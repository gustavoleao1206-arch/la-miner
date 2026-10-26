import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import Papa from 'papaparse';

import { PrismaService } from '../../prisma/prisma.service';
import { escopoGlobal } from '../../prisma/sentinela-escopo';
import { FilaService } from '../fila/fila.service';
import { STATUS_A_ENRIQUECER, precisaEnriquecer } from '../fila/fila.constants';
import { LOTE_PADRAO, type LoteCarteira } from '../carteira/carteira.service';
import { lerCampos, valorDePlanilha, type MapaColunas } from './colunas-planilha';
import { TETO_LINHAS, lerPlanilha } from './ler-planilha';
import { calcularDelta, descreverDelta, mesmoDinheiro } from './timeline-processo';
import { faseDaPlanilha } from './fase-da-planilha';
import { cpfDeMetodoRecusado, MOTIVO_METODO_RECUSADO } from './metodo-do-cpf';
import type { FaseProcesso, Prisma } from '@miner/database';

/**
 * Fallback apenas. A fonte da verdade é PerfilImportacao no banco, por tribunal.
 * Mantido para o caso de um tribunal sem perfil cadastrado — mas esse caminho
 * agora falha antes de chegar aqui, porque importar com o mapa errado produz
 * "sucesso" com zero linhas, que é pior do que um erro.
 */
const COLUNAS_FALLBACK = {
  cpf: ['cpf', 'cpf do requerente', 'cpf/cnpj', 'documento', 'cpf requerente'],
  nome: ['nome', 'nome completo', 'requerente', 'nome do requerente', 'exequente', 'nome completo do requerente/exequente'],
  processo: ['processo', 'precatorio', 'precatório', 'numero do processo', 'nº do processo', 'processo precatorio', 'número do processo de precatório no trf5'],
  originario: ['originario', 'originário', 'processo originario', 'numero do processo de execução/originário', 'número do processo de execução/originário'],
  requisitorio: ['requisitorio', 'requisitório', 'numero do requisitorio', 'número do requisitório'],
  valor: ['valor', 'valor individual', 'valor atualizado', 'valor atualizado individual'],
  entidade: ['entidade', 'entidade devedora', 'orgao', 'órgão'],
  /* O campo que mais muda ao longo da vida do precatório. Já foi o buraco do
     diff: a planilha trazia "Situação do requisitório" e o banco tinha a
     coluna, mas só o seed a preenchia — pela API ela nunca chegava ao delta, e
     a timeline do CRM nasceria sem o evento que ela existe para mostrar.
     Fechado e conferido: o perfil do TRF5 mapeia `situacao`, os 4.188
     processos estão com o campo preenchido, e a reimportação pela tela os
     acusou como inalterados, o que só acontece se o diff LEU o campo. */
  situacao: ['situacao', 'situação', 'situacao do requisitorio', 'situação do requisitório', 'status'],
  /* ── CAMPOS QUE O IMPORTADOR GENÉRICO PASSOU A LER EM 04/09/2026 ──

     `vara` e `natureza` já eram mapeados pelo perfil do TRF1 desde 09/08, e a
     migration que os criou avisava: "o importador genérico ainda não as lê". O
     fio ficou solto um mês. `tribunal` e `fase` nascem agora, com os
     pré-precatórios. */
  vara: ['vara', 'juizo de origem', 'juízo de origem', 'orgao julgador', 'órgão julgador'],
  natureza: ['natureza'],
  tribunal: ['tribunal', 'sigla do tribunal', 'tribunal de origem'],
  fase: ['fase', 'descricao da fase', 'descrição da fase', 'estagio', 'estágio'],
  /* Separado de `valor` de propósito: valor extraído de TEXTO não pode cair na
     mesma coluna do valor apurado — ver a nota de `Processo.valorIndicativo`. */
  valorIndicativo: ['valor extraido', 'valor extraído', 'valor indicativo'],
};

export interface LinhaNormalizada {
  cpf: string | null;
  nome: string | null;
  processo: string | null;
  originario: string | null;
  requisitorio: string | null;
  valor: number | null;
  valorIndicativo: number | null;
  entidade: string | null;
  situacao: string | null;
  vara: string | null;
  natureza: string | null;
  /** Sigla crua da planilha. Só vale no modo multi-tribunal; resolvida depois. */
  tribunal: string | null;
  /** Texto cru da fase. Traduzido em `FaseProcesso` na conciliação. */
  fase: string | null;
  /** "Como o CPF foi obtido", cru. Só o radar de pré-precatórios traz. Ver `metodo-do-cpf.ts`. */
  metodoCpf: string | null;
  bruto: Record<string, unknown>;
}

@Injectable()
export class ImportacaoService {
  private readonly logger = new Logger(ImportacaoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
  ) {}

  async importar(params: {
    arquivo: Express.Multer.File;
    organizationId: string;
    userId: string;
    /** Simula sem gravar nada. Ver o bloco de projeção mais abaixo. */
    dryRun?: boolean;
    /**
     * Destino da carga. Ausente = o padrão histórico, para não quebrar quem
     * ainda chama sem escolher — mas a tela SEMPRE manda, porque deixar 4 mil
     * linhas caírem num tribunal implícito é o tipo de engano caro de desfazer.
     */
    lote?: LoteCarteira;
    /**
     * O perfil de leitura, escolhido explicitamente.
     *
     * ── POR QUE EXISTE, E POR QUE E OPCIONAL ──
     *
     * Ausente = o caminho de sempre: o tribunal vem do lote e o perfil e o mais
     * antigo ativo dele. Nada muda para quem importa divida consolidada.
     *
     * Presente, e o perfil sem tribunal = MODO MULTI-TRIBUNAL: o tribunal passa
     * a vir de uma COLUNA, linha a linha. E preciso ser um pedido explicito, e
     * nunca a ausencia de escolha — deixar 1.169 linhas caírem num tribunal
     * implicito e o tipo de engano caro de desfazer.
     *
     * Presente, e o perfil COM tribunal = o operador escolheu qual dos perfis
     * daquele tribunal usar. Ate aqui isso era impossivel: `orderBy criadoEm
     * asc` sempre devolvia o mais antigo, entao um perfil novo num tribunal que
     * ja tinha um nunca seria alcancado.
     */
    perfilId?: string;
  }) {
    const { arquivo, organizationId, userId, dryRun = false, lote = LOTE_PADRAO } = params;
    const hash = createHash('sha256').update(arquivo.buffer).digest('hex');

    /* Mesmo conteúdo já importado? Evita duplicar carteira por engano.
       As duas perguntas são DIFERENTES e levam a mensagens diferentes: uma
       carga concluída é "isto já está na carteira"; uma em andamento é "espere,
       está acontecendo agora". */
    const [duplicada, emAndamento] = await Promise.all([
      this.prisma.importacao.findFirst({
        where: { arquivoHash: hash, status: { in: ['CONCLUIDA', 'CONCLUIDA_COM_ERROS'] } },
        select: { id: true, arquivoNome: true, criadoEm: true },
      }),
      /**
       * A MESMA planilha já em processamento.
       *
       * Esta checagem nasceu com a fila. Antes o trabalho todo cabia na
       * requisição, e a janela para reenviar o mesmo arquivo era o tempo dela.
       * Agora a carga fica minutos em RECEBIDA/PROCESSANDO, e o operador que não
       * vê progresso reenvia — o hash não barraria, porque só olhava as
       * concluídas, e duas passadas do mesmo arquivo entrariam na fila.
       *
       * Não seria corrupção (o segundo passe é diff, portanto no-op), mas
       * dobraria o tempo de fila e produziria dois registros no histórico para
       * um arquivo só, com números que não somam.
       */
      this.prisma.importacao.findFirst({
        where: { arquivoHash: hash, status: { in: ['RECEBIDA', 'PROCESSANDO'] } },
        select: { id: true, criadoEm: true, processadas: true, totalLinhas: true },
      }),
    ]);
    if (duplicada && !dryRun) {
      throw new BadRequestException(
        `Este arquivo já foi importado em ${duplicada.criadoEm.toLocaleDateString('pt-BR')} (${duplicada.arquivoNome}).`,
      );
    }
    if (emAndamento && !dryRun) {
      throw new BadRequestException(
        `Este mesmo arquivo já está sendo importado (${emAndamento.processadas.toLocaleString('pt-BR')} de ` +
          `${emAndamento.totalLinhas.toLocaleString('pt-BR')} linhas processadas). ` +
          'Acompanhe o progresso no histórico em vez de enviar de novo.',
      );
    }

    /* O perfil precisa existir ANTES de qualquer escrita: importar com o mapa
       de colunas errado gera "sucesso" com zero linhas — ou, pior, reconhece os
       CPFs, não reconhece os processos, e a fila queima crédito da Contactra em
       gente que ficaria invisível em todo agregado. */
    const { perfil, tribunal } = await this.resolverLeitura(params.perfilId, lote.tribunal);
    const multiTribunal = perfil.tribunalId === null;
    const mapa = perfil.mapaColunas as Record<string, string[]>;

    const linhas = await this.parsear(arquivo, mapa, perfil.aba);
    if (linhas.length === 0) throw new BadRequestException('Planilha vazia ou sem cabeçalho reconhecido.');

    /* Falha ALTO quando uma coluna obrigatória não foi reconhecida em nenhuma
       linha. Antes isto passava batido: sem a coluna de processo, todas as
       linhas viravam pessoas sem precatório e a tela dizia "sucesso". */
    const faltando = perfil.colunasObrigatorias.filter(
      (c: string) => !linhas.some((l) => (l as unknown as Record<string, unknown>)[c]),
    );
    if (faltando.length > 0) {
      throw new BadRequestException(
        `Perfil "${perfil.nome}" (${tribunal?.sigla ?? 'multi-tribunal'}): não encontrei a(s) coluna(s) ` +
          `${faltando.join(', ')} ` +
          `na planilha. Verifique o cabeçalho ou ajuste o perfil de importação.`,
      );
    }

    /* Confere se a planilha é MESMO do tribunal escolhido, pelo número CNJ.
       Com o destino selecionável, o engano de mandar a planilha do TRF1 para o
       TRF5 passa a ser possível — e nada mais no fluxo o detectaria: o número é
       tratado como texto opaco em todo o resto do sistema, então 4 mil
       processos entrariam sob o tribunal errado, com chave composta válida e
       zero erro. Desfazer isso exige apagar processo a processo. */
    /* ⚠ SÓ NO MODO DE TRIBUNAL ESCOLHIDO.
       Esta conferência compara o número CNJ das linhas com o tribunal que o
       operador escolheu. No modo multi-tribunal não existe "escolhido" para
       comparar — a rede de lá é outra, e mais fraca: sigla fora do catálogo
       recusa o arquivo, mas sigla certa com processo de outro tribunal PASSA.
       Ensinar o leitor de CNJ os formatos estadual e trabalhista fecharia isso;
       está anotado e não cabe aqui. */
    if (tribunal) {
      const divergencia = this.conferirTribunal(linhas, tribunal.sigla);
      if (divergencia) throw new BadRequestException(divergencia);
    }

    /* A rede DO MODO MULTI-TRIBUNAL: toda sigla da planilha precisa existir no
       catálogo, e a recusa é do ARQUIVO INTEIRO, não da linha. Deixar passar as
       conhecidas importaria metade da carga e deixaria a outra metade num limbo
       que ninguém revisita — e o operador acharia que importou tudo. */
    /* Chamado pelo EFEITO, não pelo retorno: aqui ele recusa o arquivo com
       sigla desconhecida, antes de qualquer escrita. O mapa sigla→id que ele
       devolve é reconstruído no worker, que roda minutos depois e não pode
       confiar num catálogo lido lá atrás. */
    if (multiTribunal) await this.resolverTribunaisDasLinhas(linhas);

    /* ── Simulação ──
       Devolve o que ACONTECERIA sem escrever uma linha sequer: nem Importacao,
       nem Pessoa, nem Processo, nem job na fila.

       Existe porque validar o fluxo sujava a carteira de produção e dependia de
       alguém lembrar de limpar depois — foi o que aconteceu no primeiro teste de
       ponta a ponta, que somou 2 processos fictícios aos agregados. É a mesma
       proteção que a Fila já tem antes de gastar crédito. */
    if (dryRun) {
      /* As linhas do método recusado saem da conta ANTES de tudo: elas não vão
         virar pessoa, nem processo, nem consulta paga, e uma simulação que as
         somasse prometeria mais do que o confirmar entrega. A MESMA função que o
         worker usa — não uma cópia da regra. */
      const recusadasPeloMetodo = linhas.filter((l) => cpfDeMetodoRecusado(l.metodoCpf)).length;
      const aproveitaveis = linhas.filter((l) => !cpfDeMetodoRecusado(l.metodoCpf));
      const comCpf = aproveitaveis.filter((l) => l.cpf);
      const cpfs = [...new Set(comCpf.map((l) => l.cpf!))];
      const numeros = [
        ...new Set(aproveitaveis.map((l) => l.processo).filter(Boolean) as string[]),
      ];

      const [jaConhecidas, jaExistentes] = await Promise.all([
        this.prisma.pessoa.findMany({
          where: { cpf: { in: cpfs } },
          select: { cpf: true, statusEnriquecimento: true },
        }),
        this.prisma.processo.findMany(
          /* Deduplicação: o precatório é único em toda a base pela chave
             (tribunal, número). Recortar por organização faria a mesma planilha
             criar duplicata a cada importação de um cliente diferente — e a
             chave única do banco recusaria a carga inteira. */
          escopoGlobal('deduplicacao: o precatorio e unico por (tribunal, numero) em toda a base', {
            where: {
              /* No modo multi-tribunal a projeção olha os números em QUALQUER
                 tribunal do arquivo. É uma estimativa mais larga que a real —
                 dois tribunais podem repetir número —, e ela erra para o lado
                 de anunciar MENOS novos do que virão. Prometer menos e entregar
                 mais é o erro barato; o contrário faria a simulação mentir. */
              ...(tribunal ? { tribunalId: tribunal.id } : {}),
              numeroPrecatorio: { in: numeros },
            },
            select: { numeroPrecatorio: true },
          }),
        ),
      ]);
      const conhecidas = new Map(jaConhecidas.map((p) => [p.cpf, p.statusEnriquecimento]));

      /* Motivo por linha, sem gravar: o operador corrige a planilha ANTES de
         importar, em vez de importar e depois caçar os erros. */
      const problemas = linhas
        .map((l, i) => ({
          /* i + 2, não i + 1: `linhas` começa depois do cabeçalho, então a
             linha 0 do array é a 2 do Excel. Com i + 1 o operador corrigia a
             linha errada, e o número não batia com o `numeroLinha` gravado em
             ImportacaoLinha — os dois relatórios do mesmo arquivo não fechavam. */
          linha: i + 2,
          motivo: !l.cpf && !l.processo
            ? 'Linha sem CPF e sem número de processo (seria ignorada)'
            : !l.cpf
              ? 'CPF ausente ou inválido'
              : !l.nome
                ? 'Nome ausente'
                : null,
        }))
        .filter((x) => x.motivo)
        .slice(0, 50);

      return {
        dryRun: true as const,
        /* O destino aparece na simulação porque é a última chance de perceber
           que a planilha ia para o lugar errado — depois do confirmar, não há
           desfazer. */
        perfil: { tribunal: tribunal?.sigla ?? null, nome: perfil.nome },
        destino: multiTribunal
          ? { tribunal: 'da planilha', exercicio: null }
          : { tribunal: tribunal!.sigla, exercicio: lote.exercicio },
        arquivoJaImportado: duplicada
          ? { em: duplicada.criadoEm, arquivo: duplicada.arquivoNome }
          : null,
        /* Avisar aqui é o que evita o operador confirmar e levar uma recusa.
           Sem isto a simulação diria "tudo certo" para um arquivo que o
           confirmar vai barrar por já estar na fila. */
        emAndamento: emAndamento
          ? {
              em: emAndamento.criadoEm,
              processadas: emAndamento.processadas,
              totalLinhas: emAndamento.totalLinhas,
            }
          : null,
        totalLinhas: linhas.length,
        /* Quantas ficam de fora por causa de COMO o CPF foi obtido, e por quê.
           Zero em toda planilha que não seja do radar — a coluna nem existe. */
        recusadasPeloMetodo: {
          total: recusadasPeloMetodo,
          motivo: recusadasPeloMetodo > 0 ? MOTIVO_METODO_RECUSADO : null,
        },
        pessoas: {
          distintas: cpfs.length,
          novas: cpfs.filter((c) => !conhecidas.has(c)).length,
          existentes: cpfs.filter((c) => conhecidas.has(c)).length,
        },
        processos: {
          distintos: numeros.length,
          novos: numeros.filter((n) => !jaExistentes.some((e) => e.numeroPrecatorio === n)).length,
        },
        /* Só quem seria enfileirado de fato. `cpfs` já é distinto e o critério
           é o MESMO objeto que o fluxo real usa — não uma cópia da regra. A
           versão anterior contava "tudo que não fosse SINCRONIZADO", o que
           somava os SEM_DADOS que a execução nunca enfileira, e a promessa da
           simulação vinha maior que o resultado. */
        seriamEnfileiradas: cpfs.filter((c) => precisaEnriquecer(conhecidas.get(c))).length,
        problemas,
        totalProblemas: linhas.filter((l) => !l.cpf || !l.nome).length,
      };
    }

    /* ── Daqui em diante o trabalho SAI da requisição ──
       O que ficou acima são as recusas que o operador precisa ver com a
       planilha ainda na mão: cabeçalho irreconhecível, tribunal errado, arquivo
       repetido. O que vem abaixo é o trabalho longo — 8,5 ms por linha,
       medido —, e 100 mil linhas dentro de um HTTP são 14 minutos que nenhum
       proxy do mundo deixa terminar. */
    const importacao = await this.prisma.importacao.create({
      data: {
        organizationId,
        userId,
        arquivoNome: arquivo.originalname,
        arquivoHash: hash,
        arquivoTipo: arquivo.originalname.toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx',
        /* O destino vai para o BANCO, e não só para o job: é daqui que o worker
           o relê. Guardá-lo apenas no payload faria uma retentativa depois de
           um deploy rodar com a forma antiga do dado — e deixaria o histórico
           sem saber para qual tribunal cada carga passada foi. */
        /* NULO no modo multi-tribunal: não há um destino só, e inventar um
           faria o worker gravar 1.169 linhas sob ele. O que o worker relê nesse
           modo é o PERFIL, logo abaixo. */
        tribunalId: tribunal?.id ?? null,
        exercicio: multiTribunal ? null : lote.exercicio,
        /* Com que mapa esta carga foi lida. É por ele que o worker refaz a
           mesma leitura, em vez de redescobrir pelo tribunal. */
        perfilId: perfil.id,
        status: 'RECEBIDA',
        totalLinhas: linhas.length,
      },
      select: { id: true },
    });

    await this.gravarLinhas(importacao.id, linhas);

    /* Enfileirar é a ÚLTIMA coisa: com as linhas já no banco, o job nunca
       aponta para dado que ainda não existe. */
    try {
      await this.fila.enfileirarImportacao(importacao.id);
    } catch (e) {
      /* Sem fila não há quem processe: as linhas ficariam PENDENTE para sempre,
         e a tela mostraria "recebida" com a barra parada em zero, sem erro
         nenhum. Marcar FALHOU transforma o silêncio em um registro legível — e
         como FALHOU não entra na trava de hash, reenviar o mesmo arquivo depois
         funciona sem nenhum destravamento manual. */
      await this.prisma.importacao.update({
        where: { id: importacao.id },
        data: {
          status: 'FALHOU',
          mensagemErro: 'A fila não respondeu; a importação não chegou a ser processada.',
          concluidoEm: new Date(),
        },
      });
      this.logger.error(
        `Importação ${importacao.id} não pôde ser enfileirada: ${(e as Error).message}`,
      );
      throw new ServiceUnavailableException(
        'A fila de processamento não está respondendo, então a planilha não foi importada. ' +
          'Nada foi gravado na carteira. Tente novamente em alguns minutos.',
      );
    }

    return {
      importacaoId: importacao.id,
      status: 'RECEBIDA' as const,
      totalLinhas: linhas.length,
      destino: multiTribunal
        ? { tribunal: 'da planilha', exercicio: null }
        : { tribunal: tribunal!.sigla, exercicio: lote.exercicio },
    };
  }

  /**
   * Grava as linhas cruas, em blocos.
   *
   * `createMany` de 100 mil linhas de uma vez monta um único INSERT gigante —
   * a consulta estoura o limite de parâmetros do driver muito antes disso. Em
   * blocos, o custo é o mesmo e o pico de memória fica constante.
   *
   * `dadosBrutos` é o que permite ao worker trabalhar sem o arquivo: a planilha
   * não é guardada em lugar nenhum, e é da linha crua que ele renormaliza.
   */
  private async gravarLinhas(importacaoId: string, linhas: LinhaNormalizada[]): Promise<void> {
    const BLOCO = 2_000;
    for (let i = 0; i < linhas.length; i += BLOCO) {
      await this.prisma.importacaoLinha.createMany({
        data: linhas.slice(i, i + BLOCO).map((l, j) => ({
          importacaoId,
          /* i + j + 2 — cabeçalho + base 1. A MESMA aritmética dos outros três
             pontos que numeram linha neste arquivo: já houve `i + 1` num ramo
             só, e duas linhas receberam o mesmo número, violando
             @@unique([importacaoId, numeroLinha]) fora de qualquer try/catch. */
          numeroLinha: i + j + 2,
          dadosBrutos: l.bruto as never,
          cpf: l.cpf,
          numeroProcesso: l.processo,
          status: 'PENDENTE' as const,
        })),
      });
    }
  }

  private async parsear(
    arquivo: Express.Multer.File,
    cols: Record<string, string[]>,
    aba: string | null,
  ): Promise<LinhaNormalizada[]> {
    const nome = arquivo.originalname.toLowerCase();
    let registros: Record<string, unknown>[];

    if (nome.endsWith('.csv')) {
      const texto = arquivo.buffer.toString('utf-8');
      const r = Papa.parse<Record<string, unknown>>(texto, {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (h) => h.trim(),
      });
      registros = r.data;
      /* O CSV não passa por `lerPlanilha`, então o teto de linhas precisa ser
         aplicado aqui também — senão bastaria renomear o arquivo para .csv
         para contorná-lo. */
      if (registros.length > TETO_LINHAS) {
        throw new BadRequestException(
          `O arquivo tem ${registros.length.toLocaleString('pt-BR')} linhas, acima do limite de ` +
            `${TETO_LINHAS.toLocaleString('pt-BR')} por importação. Divida o arquivo em partes.`,
        );
      }
    } else {
      /* Aba, tetos e conversão em objetos moram em `ler-planilha.ts`, que é
         onde a troca do SheetJS ficou contida e testada. */
      ({ registros } = await lerPlanilha(arquivo.buffer, aba));
    }

    return registros.map((r) => this.normalizar(r, cols));
  }

  private normalizar(bruto: Record<string, unknown>, cols: Record<string, string[]>): LinhaNormalizada {
    /* Leitura pelo módulo espelhado: o seed usa exatamente o mesmo código, para
       a MESMA planilha não ser interpretada de dois jeitos. */
    const campo = lerCampos(bruto, cols as MapaColunas);

    const cpfBruto = campo('cpf');
    const cpf = cpfBruto ? cpfBruto.replace(/\D/g, '').padStart(11, '0') : null;

    return {
      cpf: cpf && cpf.length === 11 && this.cpfValido(cpf) ? cpf : null,
      nome: campo('nome'),
      processo: campo('processo'),
      originario: campo('originario'),
      requisitorio: campo('requisitorio'),
      valor: valorDePlanilha(campo('valor')),
      valorIndicativo: valorDePlanilha(campo('valorIndicativo')),
      entidade: campo('entidade'),
      situacao: campo('situacao'),
      vara: campo('vara'),
      natureza: campo('natureza'),
      tribunal: campo('tribunal'),
      fase: campo('fase'),
      metodoCpf: campo('metodoCpf'),
      bruto,
    };
  }

  /** Dígito verificador — barra CPF inválido antes de gastar crédito de API. */
  private cpfValido(cpf: string): boolean {
    if (/^(\d)\1{10}$/.test(cpf)) return false;
    for (const t of [9, 10]) {
      let soma = 0;
      for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(cpf[t])) return false;
    }
    return true;
  }

  /**
   * Qual TRF o número CNJ afirma ser. `null` quando não dá para afirmar.
   *
   * Padrão CNJ: `NNNNNNN-DD.AAAA.J.TR.OOOO`. Interessam dois campos — `J`, o
   * segmento do Judiciário (4 = Justiça Federal), e `TR`, o tribunal dentro do
   * segmento (01..06 para os TRFs).
   *
   * Devolve `null` de propósito para qualquer coisa fora disso: número em
   * formato antigo, de tribunal estadual, ou com dígito de tribunal que não
   * existe. É o lado certo para errar — esta função só serve para RECUSAR uma
   * importação, e recusar por causa de um número que não se entende seria pior
   * que deixar passar.
   */
  private tribunalDoNumeroCnj(numero: string): string | null {
    const m = /\d{7}-\d{2}\.\d{4}\.(\d)\.(\d{2})\./.exec(numero);
    if (!m) return null;
    const [, segmento, tr] = m;
    if (segmento !== '4') return null; // não é Justiça Federal
    const n = Number(tr);
    return n >= 1 && n <= 6 ? `TRF${n}` : null;
  }

  /** Amostra mínima para afirmar que a planilha é de outro tribunal. */
  private static readonly CNJ_AMOSTRA_MINIMA = 10;
  /** Proporção mínima concordando com o mesmo tribunal divergente. */
  private static readonly CNJ_CONCORDANCIA = 0.8;

  /**
   * A planilha é de outro tribunal? Devolve a mensagem de recusa, ou `null`.
   *
   * Dois limiares, e ambos existem para evitar falso positivo: uma planilha com
   * poucos números legíveis não autoriza conclusão nenhuma, e uma carteira com
   * meia dúzia de números de outra região (que acontece — processo redistribuído)
   * não pode barrar a importação inteira. Só recusa quando a MAIORIA esmagadora
   * de uma amostra relevante aponta para o mesmo outro tribunal.
   */
  /**
   * Decide COM QUE MAPA a planilha vai ser lida, e SOB QUE TRIBUNAL ela entra.
   *
   * Devolve `tribunal: null` quando o perfil escolhido não tem tribunal — é o
   * modo multi-tribunal, e a partir daí o tribunal vem de cada linha.
   *
   * ── AS DUAS PORTAS, E POR QUE SÃO SEPARADAS ──
   *
   * Sem `perfilId`, nada muda: o tribunal vem do lote e o perfil é o mais antigo
   * ativo dele. É o caminho que importa a dívida consolidada dos TRFs desde o
   * começo, e ele não pode nem piscar.
   *
   * Com `perfilId`, quem escolhe é o operador. Isso resolve DOIS problemas que
   * chegaram juntos: o perfil multi-tribunal não pertence a tribunal nenhum,
   * então não há como alcançá-lo pelo lote; e um tribunal com dois perfis ativos
   * sempre resolvia para o mais antigo (`orderBy criadoEm asc`), o que tornaria
   * um perfil novo inalcançável no TRF1, TRF3, TRF4, TRF5 e TRF6.
   */
  private async resolverLeitura(perfilId: string | undefined, siglaDoLote: string) {
    const selecao = {
      id: true,
      nome: true,
      tribunalId: true,
      mapaColunas: true,
      colunasObrigatorias: true,
      aba: true,
    } as const;

    if (perfilId) {
      const perfil = await this.prisma.perfilImportacao.findUnique({
        where: { id: perfilId },
        select: { ...selecao, ativo: true },
      });
      if (!perfil || !perfil.ativo) {
        throw new BadRequestException(
          'O perfil de importação escolhido não existe ou está inativo.',
        );
      }
      /* Perfil DE um tribunal: o destino é o dele, não o do lote. Aceitar o lote
         aqui deixaria a tela mandar TRF5 com um perfil do TRF1 e gravar sob o
         tribunal errado — o engano que `conferirTribunal` existe para pegar, só
         que por outro caminho. */
      const tribunal = perfil.tribunalId
        ? await this.prisma.tribunal.findUnique({
            where: { id: perfil.tribunalId },
            select: { id: true, sigla: true, ativo: true },
          })
        : null;
      if (perfil.tribunalId && (!tribunal || !tribunal.ativo)) {
        throw new BadRequestException(
          'O tribunal do perfil escolhido está inativo ou foi removido.',
        );
      }
      return { perfil, tribunal };
    }

    /* ── O caminho de sempre ── */
    const tribunal = await this.prisma.tribunal.findUnique({
      where: { sigla: siglaDoLote },
      select: { id: true, sigla: true, ativo: true },
    });
    if (!tribunal || !tribunal.ativo) {
      throw new BadRequestException(
        `Tribunal ${siglaDoLote} não está cadastrado ou está inativo. Verifique o catálogo de tribunais.`,
      );
    }
    const perfil = await this.prisma.perfilImportacao.findFirst({
      where: { tribunalId: tribunal.id, ativo: true },
      /* Ordem explícita: com dois perfis ativos no mesmo tribunal, `findFirst`
         sem `orderBy` devolve o que o banco quiser, e a MESMA planilha poderia
         ser lida com mapas de coluna diferentes entre duas execuções. */
      orderBy: { criadoEm: 'asc' },
      select: selecao,
    });
    if (!perfil) {
      throw new BadRequestException(
        `Nenhum perfil de importação ativo para ${tribunal.sigla}. Cadastre o perfil antes de importar.`,
      );
    }
    return { perfil, tribunal };
  }

  /**
   * A rede do modo multi-tribunal: TODA sigla da planilha tem de existir.
   *
   * Devolve o mapa sigla → id para o worker não reconsultar linha a linha.
   *
   * ── POR QUE RECUSA O ARQUIVO INTEIRO, E NÃO A LINHA ──
   *
   * Deixar passar as siglas conhecidas importaria parte da carga e deixaria o
   * resto num limbo que ninguém revisita — e o operador, olhando "concluída",
   * acharia que importou tudo. Um arquivo com sigla desconhecida quase sempre
   * significa catálogo desatualizado, não linha ruim: a correção é cadastrar o
   * tribunal e reenviar, e para isso ele precisa saber QUAIS faltam.
   *
   * A mensagem lista as siglas com a contagem, porque "TJXX (3 linhas)" é o que
   * diz se é erro de digitação numa linha ou um tribunal inteiro faltando.
   */
  private async resolverTribunaisDasLinhas(
    linhas: LinhaNormalizada[],
  ): Promise<Map<string, string>> {
    const contagem = new Map<string, number>();
    for (const l of linhas) {
      const sigla = (l.tribunal ?? '').toUpperCase().replace(/-/g, '').trim();
      if (sigla) contagem.set(sigla, (contagem.get(sigla) ?? 0) + 1);
    }

    const semSigla = linhas.filter((l) => !(l.tribunal ?? '').trim()).length;
    if (semSigla > 0) {
      throw new BadRequestException(
        `${semSigla} linha(s) sem tribunal. Neste perfil o tribunal vem da planilha, ` +
          'e sem ele o processo não teria onde ser gravado.',
      );
    }

    const encontrados = await this.prisma.tribunal.findMany({
      where: { sigla: { in: [...contagem.keys()] }, ativo: true },
      select: { id: true, sigla: true },
    });
    const mapa = new Map(encontrados.map((t) => [t.sigla, t.id]));

    const faltando = [...contagem.entries()]
      .filter(([sigla]) => !mapa.has(sigla))
      .sort((a, b) => b[1] - a[1]);
    if (faltando.length > 0) {
      const lista = faltando.map(([s, n]) => `${s} (${n} linha${n > 1 ? 's' : ''})`).join(', ');
      throw new BadRequestException(
        `Tribunal(is) não cadastrado(s) ou inativo(s): ${lista}. ` +
          'Cadastre no catálogo antes de importar — a carga inteira foi recusada para não ' +
          'entrar pela metade.',
      );
    }
    return mapa;
  }

  private conferirTribunal(linhas: LinhaNormalizada[], siglaEscolhida: string): string | null {
    const detectados = linhas
      .map((l) => this.tribunalDoNumeroCnj(l.processo ?? ''))
      .filter((x): x is string => x !== null);

    if (detectados.length < ImportacaoService.CNJ_AMOSTRA_MINIMA) return null;

    const contagem = new Map<string, number>();
    for (const d of detectados) contagem.set(d, (contagem.get(d) ?? 0) + 1);

    const [vencedor, quantos] = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0];
    if (vencedor === siglaEscolhida) return null;
    if (quantos / detectados.length < ImportacaoService.CNJ_CONCORDANCIA) return null;

    const pct = Math.round((quantos / detectados.length) * 100);
    return (
      `A planilha parece ser do ${vencedor}, não do ${siglaEscolhida}: ${pct}% dos números ` +
      `de processo legíveis apontam para o ${vencedor}. Troque o tribunal de destino ou ` +
      `confira o arquivo — importar aqui gravaria os processos sob o tribunal errado.`
    );
  }

  /**
   * Quantas linhas o worker carrega por vez.
   *
   * Nem uma (uma consulta por linha, sobre 8,5 ms de trabalho útil) nem todas
   * (100 mil linhas cruas na memória do worker de uma vez). A página também é
   * o intervalo em que `processadas` avança na tela — a cada ~4 segundos de
   * trabalho, que é o ritmo em que uma barra de progresso parece viva.
   */
  private static readonly LOTE_LINHAS = 500;

  /**
   * O trabalho de verdade — roda no WORKER, fora de qualquer requisição.
   *
   * ── POR QUE UM JOB POR IMPORTAÇÃO, E NÃO UM POR LINHA ──
   *
   * Um job por linha seria mais paralelo e estaria errado. O mapa
   * `reconciliados`, abaixo, é estado da importação INTEIRA: ele impede que um
   * precatório com vários beneficiários seja reconciliado uma vez por linha —
   * o que faria os campos brigarem entre si dentro da mesma carga. Espalhado
   * por N jobs, ele deixaria de existir.
   *
   * ── RETOMA, NÃO RECOMEÇA ──
   *
   * Só lê linhas em PENDENTE. Uma retentativa do BullMQ — por queda do worker
   * no meio, deploy, ou o job travado que ele recupera sozinho — continua de
   * onde parou em vez de reprocessar o que já entrou. É o que torna seguro o
   * `attempts: 3` sobre um trabalho de 14 minutos.
   */
  async processarImportacao(importacaoId: string): Promise<void> {
    const imp = await this.prisma.importacao.findUnique({
      where: { id: importacaoId },
      select: {
        organizationId: true,
        userId: true,
        tribunalId: true,
        exercicio: true,
        perfilId: true,
        status: true,
        totalLinhas: true,
        iniciadoEm: true,
      },
    });

    if (!imp) {
      /* Some entre enfileirar e consumir só se alguém apagou. Repetir não traz
         de volta — devolver sem erro encerra o job em vez de gastar as três
         tentativas contra um id que não existe. */
      this.logger.warn(`Importação ${importacaoId} não existe mais; job descartado.`);
      return;
    }

    /* Idempotência: o mesmo job entregue duas vezes (o que o BullMQ admite em
       queda de rede) não reprocessa uma carga fechada. */
    if (imp.status === 'CONCLUIDA' || imp.status === 'CONCLUIDA_COM_ERROS') {
      this.logger.log(`Importação ${importacaoId} já estava concluída; nada a fazer.`);
      return;
    }

    /**
     * O perfil, e por ele o MODO.
     *
     * `perfilId` é a fonte da verdade desde 04/09/2026, e redescobrir o perfil
     * pelo tribunal é o caminho legado. A diferença importa: a requisição já
     * decidiu com que mapa ler, e refazer a escolha aqui abre a porta para a
     * MESMA planilha ser lida de dois jeitos — que é exatamente o que o
     * `orderBy` explícito da requisição existe para evitar.
     */
    const perfil = imp.perfilId
      ? await this.prisma.perfilImportacao.findUnique({
          where: { id: imp.perfilId },
          select: { nome: true, mapaColunas: true, tribunalId: true, ativo: true },
        })
      : imp.tribunalId
        ? await this.prisma.perfilImportacao.findFirst({
            where: { tribunalId: imp.tribunalId, ativo: true },
            /* Mesma ordem explícita da requisição: com dois perfis ativos, sem
               `orderBy` o banco escolhe — e a MESMA planilha seria lida com
               mapas diferentes na requisição e no worker. */
            orderBy: { criadoEm: 'asc' },
            select: { nome: true, mapaColunas: true, tribunalId: true, ativo: true },
          })
        : null;

    if (!perfil || !perfil.ativo) {
      /* O perfil existia quando a planilha foi aceita e sumiu antes de ela ser
         processada. Retentativa não recria perfil. */
      await this.marcarFalha(
        importacaoId,
        'O perfil de importação foi removido ou desativado depois do envio.',
      );
      return;
    }

    const multiTribunal = perfil.tribunalId === null;

    /* Importações gravadas ANTES do B5 não têm destino: o tribunal só existia
       como argumento em memória. Nenhuma delas está pendente (todas fecharam
       dentro da própria requisição), mas processar uma sem destino criaria
       processos sob tribunal nenhum.

       ⚠ A exigência NÃO vale no modo multi-tribunal: lá o destino é por linha, e
       tribunal nulo é o estado correto, não a ausência de um. Sem esta ressalva,
       toda carga do modo novo falharia aqui — com a mensagem errada. */
    if (!multiTribunal && (!imp.tribunalId || imp.exercicio === null)) {
      await this.marcarFalha(
        importacaoId,
        'Importação sem tribunal ou exercício de destino gravado. Reenvie a planilha.',
      );
      return;
    }

    /* No modo multi-tribunal o catálogo é relido AGORA, e não reaproveitado da
       requisição: entre uma coisa e outra passam minutos, e um tribunal pode ter
       sido desativado. Reler é barato (dezenas de linhas) e evita gravar sob um
       tribunal que deixou de valer. */
    const tribunaisPorSigla = multiTribunal
      ? new Map(
          (
            await this.prisma.tribunal.findMany({
              where: { ativo: true },
              select: { id: true, sigla: true },
            })
          ).map((t) => [t.sigla, t.id]),
        )
      : null;
    const mapa = perfil.mapaColunas as Record<string, string[]>;

    await this.prisma.importacao.update({
      where: { id: importacaoId },
      data: {
        status: 'PROCESSANDO',
        /* Preserva o início da PRIMEIRA tentativa: numa retomada, remarcar
           faria a duração aparente encolher a cada retry. */
        iniciadoEm: imp.iniciadoEm ?? new Date(),
        mensagemErro: null,
      },
    });

    const contexto = {
      importacaoId,
      userId: imp.userId,
      organizationId: imp.organizationId,
      /* Nulos no modo multi-tribunal: quem manda ali é a linha. */
      tribunalId: imp.tribunalId,
      exercicio: imp.exercicio,
      multiTribunal,
      tribunaisPorSigla,
    };

    /* Guarda contra a planilha que repete o MESMO processo em várias linhas —
       o formato de um precatório com vários beneficiários, em que as colunas do
       processo se repetem linha a linha e só o valor individual muda.

       Reconciliar o processo em toda linha faria os campos brigarem dentro da
       mesma execução: `valor` vem da coluna de valor INDIVIDUAL, então cada
       linha proporia um valor diferente para o mesmo processo, e a execução
       seguinte inverteria tudo de novo — thrash perpétuo, evento em todo
       processo em toda importação, o oposto do no-op exigido. A PRIMEIRA linha
       do processo decide; as demais só criam o vínculo da parte. É isto que
       também garante, de graça, "um evento por processo por execução".

       ATENÇÃO ao mexer: este caminho NÃO é exercitado hoje. Os 4.188 processos
       da carteira do TRF5 têm exatamente uma parte cada (conferido no banco), e
       nenhuma planilha dos testes repete um processo entre linhas — as duas
       repetem TITULAR, que é o caso oposto. Então `reconciliados` nunca acerta
       em cheio, nem em produção nem na suíte. A proteção vale para perfis de
       outros tribunais, mas mudá-la é mexer em código sem rede. */
    const reconciliados = new Map<string, string>();

    let processadas =
      imp.totalLinhas -
      (await this.prisma.importacaoLinha.count({ where: { importacaoId, status: 'PENDENTE' } }));
    let ultimoInicio = -1;

    for (;;) {
      /* Sem cursor: as linhas SAEM do PENDENTE ao serem processadas, então a
         mesma consulta devolve naturalmente a página seguinte — e devolve o
         resto certo depois de uma queda no meio. */
      const pagina = await this.prisma.importacaoLinha.findMany({
        where: { importacaoId, status: 'PENDENTE' },
        orderBy: { numeroLinha: 'asc' },
        take: ImportacaoService.LOTE_LINHAS,
        select: { id: true, numeroLinha: true, dadosBrutos: true },
      });
      if (pagina.length === 0) break;

      /* Trava contra laço infinito. Toda volta TEM de tirar linhas do PENDENTE;
         se a página recomeçar no mesmo número, alguma linha não mudou de estado
         e o worker giraria em vazio para sempre, sem avisar ninguém. Falhar
         alto aqui é o certo: o job vai para `failed`, visível. */
      if (pagina[0].numeroLinha === ultimoInicio) {
        throw new Error(
          `A linha ${ultimoInicio} da importação ${importacaoId} não saiu de PENDENTE — ` +
            'processamento interrompido para não repetir indefinidamente.',
        );
      }
      ultimoInicio = pagina[0].numeroLinha;

      await this.processarPagina(pagina, mapa, contexto, reconciliados);

      processadas += pagina.length;
      await this.prisma.importacao.update({
        where: { id: importacaoId },
        data: { processadas },
      });
    }

    await this.concluir(importacaoId);
  }

  /** Uma página de linhas cruas. Não conta nada: os números finais saem do banco. */
  private async processarPagina(
    pagina: { id: string; numeroLinha: number; dadosBrutos: unknown }[],
    mapa: Record<string, string[]>,
    ctx: {
      importacaoId: string;
      userId: string;
      organizationId: string;
      /** Nulo no modo multi-tribunal — o destino vem de cada linha. */
      tribunalId: string | null;
      exercicio: number | null;
      multiTribunal: boolean;
      /** Sigla → id, relido no início do processamento. Nulo no modo clássico. */
      tribunaisPorSigla: Map<string, string> | null;
    },
    reconciliados: Map<string, string>,
  ): Promise<void> {
    for (const registro of pagina) {
      /* Renormaliza a partir do BRUTO, com o perfil — em vez de confiar nas
         colunas `cpf`/`numeroProcesso` que a requisição já gravou. É o que
         mantém uma fonte só para "o que esta coluna significa": corrigir o
         perfil e reprocessar passa a ter efeito, e uma mudança na normalização
         não deixa metade das linhas lidas pela regra velha. */
      const l = this.normalizar(registro.dadosBrutos as Record<string, unknown>, mapa);

      /* Linha estruturalmente vazia (nem CPF nem processo) é IGNORADA, não erro.
         Descartá-las em silêncio escondia planilha mal lida; contá-las como
         falha transformaria as linhas em branco do fim do arquivo em "concluída
         com erros". Ficam registradas e auditáveis, fora da contagem de falhas. */
      if (!l.cpf && !l.processo) {
        await this.prisma.importacaoLinha.update({
          where: { id: registro.id },
          data: { status: 'IGNORADA', mensagemErro: 'Linha sem CPF e sem número de processo' },
        });
        continue;
      }

      /* CPF achado por método que erra mais do que acerta: a linha NÃO ENTRA.
         Antes de `sincronizarPessoa` de propósito — é ela que cria a pessoa, e é a
         pessoa PENDENTE que vai para a fila paga. IGNORADA e não ERRO: a planilha
         não está errada, a decisão é nossa, e o motivo fica auditável na linha. */
      if (cpfDeMetodoRecusado(l.metodoCpf)) {
        await this.prisma.importacaoLinha.update({
          where: { id: registro.id },
          data: { status: 'IGNORADA', mensagemErro: MOTIVO_METODO_RECUSADO },
        });
        continue;
      }

      try {
        if (!l.cpf) throw new Error('CPF ausente ou inválido');
        if (!l.nome) throw new Error('Nome ausente');

        const pessoa = await this.sincronizarPessoa(l.cpf, l.nome);
        let processoId: string | null = null;

        if (l.processo) {
          /**
           * O DESTINO DA LINHA.
           *
           * No modo clássico ele veio da tela e vale para a carga inteira. No
           * multi-tribunal ele é desta linha, e as duas coisas que o decidem —
           * tribunal e fase — RECUSAM a linha quando não dão para decidir.
           *
           * Recusar é o ponto. Um default de tribunal gravaria o processo no
           * lugar errado; um default de fase o venderia como coisa que ele não é.
           * Linha recusada aparece no relatório de erros com o texto original e
           * alguém corrige; linha adivinhada não aparece em lugar nenhum.
           */
          let tribunalDaLinha = ctx.tribunalId;
          let faseDaLinha: FaseProcesso = 'PRECATORIO_EXPEDIDO';

          if (ctx.multiTribunal) {
            const sigla = (l.tribunal ?? '').toUpperCase().replace(/-/g, '').trim();
            const id = sigla ? ctx.tribunaisPorSigla?.get(sigla) : undefined;
            if (!id) {
              throw new Error(
                sigla
                  ? `Tribunal ${sigla} não está cadastrado ou foi desativado durante a importação`
                  : 'Tribunal ausente na linha',
              );
            }
            tribunalDaLinha = id;

            const fase = faseDaPlanilha(l.fase);
            if (!fase) {
              throw new Error(
                l.fase
                  ? `Fase não reconhecida: "${l.fase}"`
                  : 'Fase ausente na linha',
              );
            }
            faseDaLinha = fase;
          }

          /* ⚠ A CHAVE INCLUI O TRIBUNAL no modo multi-tribunal. O mesmo número
             de processo existe em tribunais diferentes — a identidade do
             sistema é (tribunal, número), e não o número sozinho. Sem isto, a
             primeira linha de um número venceria a de outro tribunal, e o
             segundo processo viraria uma parte pendurada no primeiro. */
          const chaveMemoria = ctx.multiTribunal
            ? `${tribunalDaLinha}|${l.processo}`
            : l.processo;
          const conhecido = reconciliados.get(chaveMemoria);

          if (conhecido) {
            processoId = conhecido;
          } else {
            const reconciliacao = await this.reconciliarProcesso({
              tribunalId: tribunalDaLinha!,
              exercicio: ctx.exercicio,
              fase: faseDaLinha,
              organizationId: ctx.organizationId,
              importacaoId: ctx.importacaoId,
              userId: ctx.userId,
              numeroPrecatorio: l.processo,
              daPlanilha: {
                numeroOriginario: l.originario,
                numeroRequisitorio: l.requisitorio,
                entidadeDevedora: l.entidade,
                situacao: l.situacao,
                /* `vara` e `natureza` eram mapeadas pelo perfil do TRF1 desde
                   09/08/2026 e nunca chegavam aqui — a migration que as criou
                   dizia "o importador generico ainda nao as le". Fio ligado. */
                vara: l.vara,
                natureza: l.natureza,
                valor: l.valor,
                /* Coluna PROPRIA, nunca `valor`: extraido de texto nao pode
                   contaminar o agregado que o cliente usa para decidir. */
                valorIndicativo: l.valorIndicativo,
              },
            });
            processoId = reconciliacao.id;
            reconciliados.set(chaveMemoria, processoId);
          }

          await this.vincularParte(processoId, pessoa.id, l.valor);
        }

        await this.prisma.importacaoLinha.update({
          where: { id: registro.id },
          data: {
            cpf: l.cpf,
            numeroProcesso: l.processo,
            status: 'OK',
            mensagemErro: null,
            pessoaId: pessoa.id,
            /* Preenchido de verdade agora. A coluna existia desde o começo e
               ficava sempre nula — o que fazia a linha saber quem é a pessoa mas
               não a qual processo ela entrou. */
            processoId,
          },
        });

        /* Quem vai para a fila de enriquecimento NÃO é decidido aqui: é o
           `pessoasAEnriquecer`, no fim, que pergunta ao banco. Decidir no laço
           deixaria de fora, numa retomada, exatamente as pessoas da tentativa
           anterior. */
      } catch (e) {
        await this.prisma.importacaoLinha.update({
          where: { id: registro.id },
          data: {
            cpf: l.cpf,
            numeroProcesso: l.processo,
            status: 'ERRO',
            mensagemErro: (e as Error).message.slice(0, 300),
          },
        });
      }
    }
  }

  /**
   * Fecha a importação: enfileira o enriquecimento e grava o resumo.
   *
   * ── TUDO SAI DO BANCO, NADA DE VARIÁVEIS ACUMULADAS ──
   *
   * Contadores mantidos em memória mentiriam numa RETOMADA: a segunda tentativa
   * só percorre o que sobrou, e somaria parciais de duas passadas sobre
   * conjuntos diferentes. Contando as linhas e os eventos GRAVADOS, o número é o
   * mesmo tenha o job rodado de uma vez ou em três pedaços.
   *
   * `inalterados` é derivado, e não contado: processos DISTINTOS tocados por
   * linhas OK, menos os que geraram evento. Um processo só gera evento quando
   * nasce (IMPORTADO) ou quando o diff achou diferença (DADO_ATUALIZADO) — o
   * resto, por definição, não mudou.
   */
  private async concluir(importacaoId: string): Promise<void> {
    /* Enriquecimento só DEPOIS de tudo gravado: a fila nunca aponta para dado
       que ainda não existe. E o número vem do RETORNO da fila, não de uma
       contagem paralela — quem responde "quantos foram enfileirados" tem de ser
       quem enfileirou. */
    const aEnriquecer = await this.pessoasAEnriquecer(importacaoId);
    let enfileirados = 0;
    if (aEnriquecer.length > 0) {
      ({ enfileirados } = await this.fila.enfileirarLote(
        aEnriquecer,
        `importacao:${importacaoId}`,
      ));
    }

    const [porStatus, porEvento, distintos] = await Promise.all([
      this.prisma.importacaoLinha.groupBy({
        by: ['status'],
        where: { importacaoId },
        _count: { _all: true },
      }),
      this.prisma.eventoProcesso.groupBy(
        /* Global DE PROPÓSITO, e ancorado no `importacaoId`: os eventos que uma
           importação grava (IMPORTADO, DADO_ATUALIZADO) são FATO do processo e
           nascem sem `organizationId` — recortar por org devolveria zero.
           `satisfies` para o `by` e o `_all` não alargarem para string/boolean
           ao passar pelo genérico do `escopoGlobal`. */
        escopoGlobal('resumo da importacao: eventos DESTA importacao, que sao fato do processo e nascem sem organizationId', {
          by: ['tipo'],
          where: { importacaoId },
          _count: { _all: true },
        } satisfies Prisma.EventoProcessoGroupByArgs),
      ),
      this.prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(DISTINCT "numeroProcesso")::int AS n
        FROM importacao_linhas
        WHERE "importacaoId" = ${importacaoId}::uuid
          AND status = 'OK'
          AND "numeroProcesso" IS NOT NULL`,
    ]);

    const linhas = (s: string) => porStatus.find((g) => g.status === s)?._count._all ?? 0;
    const eventos = (t: string) => porEvento.find((g) => g.tipo === t)?._count._all ?? 0;

    const sucesso = linhas('OK');
    const falhas = linhas('ERRO');
    const ignoradas = linhas('IGNORADA');
    const criados = eventos('IMPORTADO');
    const atualizados = eventos('DADO_ATUALIZADO');
    const tocados = distintos[0]?.n ?? 0;

    await this.prisma.importacao.update({
      where: { id: importacaoId },
      data: {
        status: falhas > 0 ? 'CONCLUIDA_COM_ERROS' : 'CONCLUIDA',
        processadas: sucesso + falhas + ignoradas,
        sucesso,
        falhas,
        ignoradas,
        processosCriados: criados,
        processosAtualizados: atualizados,
        /* `max(0, ...)` por segurança aritmética: os três vêm de consultas
           diferentes, e um número negativo na tela seria pior que um zero. */
        processosInalterados: Math.max(0, tocados - criados - atualizados),
        enfileirados,
        concluidoEm: new Date(),
      },
    });

    this.logger.log(
      `Importação ${importacaoId} concluída: ${sucesso} ok, ${falhas} erro(s), ${ignoradas} ignorada(s) · ` +
        `${criados} processo(s) novo(s), ${atualizados} atualizado(s) · ${enfileirados} enfileirado(s).`,
    );
  }

  /**
   * Quem desta importação ainda vale consultar no provedor.
   *
   * ── POR QUE DO BANCO, E NÃO DE UM MAPA MONTADO NO LAÇO ──
   *
   * O laço só enxerga as linhas que ELE processou. Numa retomada, as pessoas da
   * tentativa anterior ficariam de fora do enfileiramento — presas em PENDENTE
   * até o cron diário passar. E o contador `enfileirados` viraria a soma de duas
   * passadas sobre conjuntos diferentes, em vez do total da importação.
   *
   * Lendo do banco, o resultado é o mesmo tenha o job rodado inteiro ou em
   * pedaços. De quebra, o critério de "quem vale consultar" fica em um lugar só
   * — `STATUS_A_ENRIQUECER` —, e não numa segunda cópia dentro do laço. Já houve
   * TRÊS respostas divergentes para essa pergunta neste sistema (ver a nota em
   * `fila.constants.ts`), e o operador via a diferença na tela.
   */
  private async pessoasAEnriquecer(importacaoId: string): Promise<{ pessoaId: string }[]> {
    /* `distinct` no banco: um titular com vários precatórios tem várias linhas
       OK, e a unidade de consulta ao provedor é a PESSOA. */
    const vinculadas = await this.prisma.importacaoLinha.findMany({
      where: { importacaoId, status: 'OK', pessoaId: { not: null } },
      distinct: ['pessoaId'],
      select: { pessoaId: true },
    });
    const ids = vinculadas.map((l) => l.pessoaId!);

    /* Em blocos: `IN` com 100 mil uuids é uma consulta que o driver não monta.
       São ~20 idas ao banco no fim de um trabalho de minutos — irrelevante. */
    const BLOCO = 5_000;
    const saida: { pessoaId: string }[] = [];
    for (let i = 0; i < ids.length; i += BLOCO) {
      const pessoas = await this.prisma.pessoa.findMany({
        where: {
          id: { in: ids.slice(i, i + BLOCO) },
          statusEnriquecimento: { in: [...STATUS_A_ENRIQUECER] },
        },
        /* A consulta continua necessária — é ela que filtra por
           `STATUS_A_ENRIQUECER` —, mas o `cpf` saiu do `select`: o job não o
           carrega mais, e uma importação grande deixa de materializar dezenas de
           milhares de CPFs na memória da API só para jogá-los fora. */
        select: { id: true },
      });
      saida.push(...pessoas.map((p) => ({ pessoaId: p.id })));
    }
    return saida;
  }

  /** Encerra a importação como FALHOU. Para o que retentativa não resolve. */
  private async marcarFalha(importacaoId: string, motivo: string): Promise<void> {
    this.logger.error(`Importação ${importacaoId} falhou: ${motivo}`);
    await this.prisma.importacao.update({
      where: { id: importacaoId },
      data: { status: 'FALHOU', mensagemErro: motivo, concluidoEm: new Date() },
    });
  }

  /**
   * Pessoa: cria ou corrige. NÃO gera evento — nenhum campo de Pessoa é logável.
   *
   * Nome e CPF são dado pessoal, e EventoProcesso é append-only: registrar
   * "nome mudou de X para Y" criaria um dado que uma SolicitacaoTitular de
   * EXCLUSÃO não conseguiria apagar. A correção acontece, o rastro não fica.
   */
  private async sincronizarPessoa(cpf: string, nomeBruto: string) {
    const nome = nomeBruto.trim();
    const nomeNormalizado = this.normalizarNome(nome);

    const atual = await this.prisma.pessoa.findUnique({
      where: { cpf },
      select: { id: true, nome: true, nomeNormalizado: true, statusEnriquecimento: true },
    });

    if (!atual) {
      return this.prisma.pessoa.create({
        data: { cpf, nome, nomeNormalizado },
        select: { id: true, statusEnriquecimento: true },
      });
    }

    /* `nome` e `nomeNormalizado` andam JUNTOS: a busca por nome roda sobre o
       índice trigram de nomeNormalizado. Corrigir um sem o outro deixaria a
       pessoa achável pelo nome antigo e invisível pelo novo. */
    if (atual.nome !== nome || atual.nomeNormalizado !== nomeNormalizado) {
      await this.prisma.pessoa.update({
        where: { id: atual.id },
        data: { nome, nomeNormalizado },
      });
    }

    return { id: atual.id, statusEnriquecimento: atual.statusEnriquecimento };
  }

  /**
   * Lê o processo, calcula o delta e grava SÓ o que mudou — com um evento junto.
   *
   * Substitui o `upsert ... update: {}`, que era write-once: reimportar a planilha
   * corrigida não alterava campo algum, e por isso DADO_ATUALIZADO seria um enum
   * que nunca receberia linha.
   */
  private async reconciliarProcesso(params: {
    tribunalId: string;
    organizationId: string;
    /** Exercício do lote de destino — antes vinha de LOTE_PADRAO. */
    exercicio: number | null;
    /** Declarada pelo chamador, nunca assumida aqui. Ver a nota do `create`. */
    fase: FaseProcesso;
    importacaoId: string;
    userId: string;
    numeroPrecatorio: string;
    /** O MESMO objeto alimenta o `create` e o diff. Se fossem listas separadas,
        um campo poderia entrar na criação e nunca mais ser corrigido depois. */
    daPlanilha: {
      numeroOriginario: string | null;
      numeroRequisitorio: string | null;
      entidadeDevedora: string | null;
      situacao: string | null;
      vara: string | null;
      natureza: string | null;
      valor: number | null;
      valorIndicativo: number | null;
    };
  }): Promise<{ id: string; criado: boolean; atualizado: boolean }> {
    /* Chave composta: o número só é único DENTRO do tribunal. Com a chave global
       anterior, um número do TRF1 que colidisse com um do TRF5 encontraria o
       processo errado e vincularia a parte a ele. */
    const chave = {
      tribunalId_numeroPrecatorio: {
        tribunalId: params.tribunalId,
        numeroPrecatorio: params.numeroPrecatorio,
      },
    };

    /* Linha inteira, sem `select`: o diff percorre CAMPOS_LOGAVEIS, e um `select`
       que esquecesse um deles devolveria `undefined` — que o diff leria como
       "mudou", reescrevendo o campo e emitindo evento em TODA execução. Processo
       não tem coluna pessoal, então ler tudo não amplia exposição de dado. */
    let atual = await this.prisma.processo.findUnique({ where: chave });

    if (!atual) {
      try {
        /* Criação e marco IMPORTADO na mesma transação: processo sem evento
           inicial faria a timeline do CRM começar do nada. */
        const novo = await this.prisma.$transaction(async (tx) => {
          const criado = await tx.processo.create({
            data: {
              ...params.daPlanilha,
              numeroPrecatorio: params.numeroPrecatorio,
              tribunalId: params.tribunalId,
              organizationId: params.organizationId,
              /* Sem o lote, o processo nasce com exercicio NULL — e como
                 `exercicio = 2027` é FALSO para NULL em SQL, ele sumiria de
                 todos os agregados da carteira sem erro nenhum. A planilha
                 importaria "com sucesso" e o dashboard não se moveria. */
              exercicio: params.exercicio,
              /**
               * A FASE, declarada por QUEM CHAMA e nunca assumida aqui.
               *
               * Esteve fixa em `PRECATORIO_EXPEDIDO` entre 04/09/2026 e este
               * commit, com um aviso dizendo que precisaria vir da planilha
               * quando o perfil de pré-precatório entrasse. É este commit.
               *
               * No modo clássico o chamador continua declarando
               * `PRECATORIO_EXPEDIDO`, porque é o que a dívida consolidada dos
               * TRFs É — precatório autuado aguardando exercício. No modo
               * multi-tribunal ela vem da coluna, e a linha é RECUSADA quando o
               * texto não é reconhecido.
               *
               * O parâmetro é obrigatório de propósito: sem default, quem chama
               * é forçado a dizer, e o TypeScript recusa quem não disser. Um
               * `@default` no schema teria escondido isso.
               */
              fase: params.fase,
              /* create-only de propósito: `fonte` carrega o id da importação.
                 No diff, mudaria a cada execução e faria toda reimportação
                 "atualizar" todo processo da carteira. */
              fonte: `importacao:${params.importacaoId}`,
            },
            select: { id: true },
          });
          await tx.eventoProcesso.create({
            data: {
              processoId: criado.id,
              tipo: 'IMPORTADO',
              /* Frase estável, sem o nome do arquivo. `descricao` é texto livre
                 numa tabela append-only e NÃO passa pela trava de LGPD do
                 calcularDelta — e planilha de precatório individual costuma ser
                 nomeada pelo requerente ("Precatorio FULANO 529.982.247-25.xlsx"),
                 o que gravaria nome e CPF de forma impossível de apagar. A
                 rastreabilidade fica por `importacaoId`, que leva a
                 Importacao.arquivoNome para quem tem direito de ver. */
              descricao: 'Processo importado para a carteira',
              importacaoId: params.importacaoId,
              userId: params.userId,
            },
          });
          return criado;
        });
        return { id: novo.id, criado: true, atualizado: false };
      } catch (e) {
        /* P2002: outra importação criou este mesmo processo entre o findUnique e
           o create. Não é erro da linha — relê e segue pelo caminho do diff. */
        if ((e as { code?: string }).code !== 'P2002') throw e;
        atual = await this.prisma.processo.findUnique({ where: chave });
      }
    }

    /* Fora do try/catch de propósito: reatribuir dentro do catch não estreita o
       tipo de forma confiável na saída do bloco. Chegar aqui sem processo
       significa que o P2002 veio de outra restrição, não da corrida. */
    if (!atual) {
      throw new Error(
        `Processo ${params.numeroPrecatorio} não pôde ser lido após colisão de chave única.`,
      );
    }

    const idProcesso = atual.id;
    const delta = calcularDelta({ ...atual }, params.daPlanilha);

    /* Nada mudou: nenhum update — nem o `editadoEm` — e nenhum evento.
       É o que faz reimportar planilha idêntica ser no-op observável. */
    if (!delta) return { id: idProcesso, criado: false, atualizado: false };

    /* Update e evento na MESMA transação. Campo alterado sem linha na timeline é
       exatamente a falha que este desenho existe para tornar impossível. */
    await this.prisma.$transaction([
      this.prisma.processo.update({ where: { id: idProcesso }, data: delta.dados }),
      this.prisma.eventoProcesso.create({
        data: {
          processoId: idProcesso,
          tipo: 'DADO_ATUALIZADO',
          /* Sem o nome do arquivo — mesmo motivo do IMPORTADO acima. */
          descricao: descreverDelta(delta, 'reimportação'),
          /* Só campo NÃO pessoal chega aqui — garantido por calcularDelta, que
             recusa qualquer chave fora de CAMPOS_LOGAVEIS. */
          camposAlterados: delta.campos,
          detalhe: delta.detalhe,
          importacaoId: params.importacaoId,
          userId: params.userId,
        },
      }),
    ]);

    return { id: idProcesso, criado: false, atualizado: true };
  }

  /**
   * Vínculo parte↔processo. Corrige `valorIndividual`, sem evento.
   *
   * Sem evento porque é o valor devido a UM titular: registrá-lo num log
   * append-only, preso a um processo, apontaria para a pessoa.
   */
  private async vincularParte(processoId: string, pessoaId: string, valorIndividual: number | null) {
    const chave = { processoId_pessoaId: { processoId, pessoaId } };

    const vinculo = await this.prisma.processoPessoa.findUnique({
      where: chave,
      select: { valorIndividual: true },
    });

    if (!vinculo) {
      await this.prisma.processoPessoa.create({ data: { processoId, pessoaId, valorIndividual } });
      return;
    }

    /* Valor ausente na planilha NÃO zera o que já existe — mesma regra do diff
       do processo. E a comparação passa por mesmoDinheiro porque Decimal do
       Prisma é objeto: `vinculo.valorIndividual !== 1234.56` seria sempre
       verdadeiro e reescreveria os 4.188 vínculos em toda importação. */
    if (valorIndividual !== null && !mesmoDinheiro(vinculo.valorIndividual, valorIndividual)) {
      await this.prisma.processoPessoa.update({ where: chave, data: { valorIndividual } });
    }
  }

  /**
   * DEVE permanecer idêntica à `normalizarNome` de packages/database/prisma/seed.ts.
   *
   * Divergiam: o seed usava NFD + remoção de pontuação, esta usava NFKD e mantinha
   * pontuação. Enquanto o upsert era `update: {}` isso era inerte, mas com o diff
   * cada alternância seed↔API reescreveria `nomeNormalizado` — e a busca trigram
   * roda sobre ele, então a pessoa ficaria achável pela grafia velha e invisível
   * pela nova. Alinhado NA DIREÇÃO DO SEED porque foi ele que gravou as 3.974
   * linhas atuais: adotar a outra convenção custaria uma reescrita da base.
   */
  private normalizarNome(nome: string): string {
    return nome
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
