import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type ConferenciaNome,
  type EsferaTribunal,
  type EstagioCrm,
  type FaseProcesso,
  type PrioridadeProcesso,
} from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { condicoesDaFila, filtroDeOverlay, type FiltrosDaFila } from './condicoes-da-fila';
/* A fronteira de visibilidade mora em common/ porque a ESCRITA do CRM precisa da
   MESMA regra — o cliente anota num processo que é propriedade da org interna.
   Reexportada aqui para não quebrar quem já a importava deste módulo. */
import {
  ehEscopoCliente,
  escopoProcessos,
  type EscopoUsuario,
} from '../../common/escopo-processos';

export type { EscopoUsuario };
export { escopoProcessos };

export interface ResumoCarteira {
  pessoas: number;
  processos: number;
  valorTotal: string;
  /** Só para a org INTERNA: é métrica da OPERAÇÃO de enriquecimento, e o cliente
   *  não deve saber que ela existe. Omitidos na projeção dele — não zerados. */
  enriquecidas?: number;
  pendentes?: number;
  /** `comValor` = quantos daqueles processos têm valor APURADO. A diferença
   *  para `quantidade` é o que a soma em R$ não cobre. */
  porEntidade: { entidade: string; quantidade: number; comValor: number; valor: string }[];
  /**
   * A CARTEIRA POR ESTÁGIO — o que faz `processos` parar de mentir.
   *
   * ── POR QUE PASSOU A SER NECESSÁRIO ──
   *
   * Até 06/09/2026 a base era 100% `PRECATORIO_EXPEDIDO`, então "N processos" e
   * "N precatórios" diziam a mesma coisa e o dashboard podia usar a segunda
   * palavra. Com 1.169 pré-precatórios na base — e entrando no sorteio dos 250 —
   * a contagem passou a somar crédito SEM exigibilidade formada sob um rótulo
   * que a afirma.
   *
   * O tratamento por ITEM já estava certo (o `SeloFase` na linha). Era o
   * AGREGADO que continuava cego: nenhuma contagem deste serviço olhava `fase`.
   *
   * ── DADO CRU, SEM INTERPRETAÇÃO ──
   *
   * Sai a distribuição inteira, e não um par "exigíveis/pré-precatórios" já
   * decidido aqui. Quem sabe o que cada fase significa é o `FASES` do front
   * (`components/fase-processo.tsx`), que é quem desenha o selo — e ter DUAS
   * definições de "isto é exigível" é ter duas que divergem.
   *
   * Uma fase nova no enum aparece aqui sozinha, e a tela a mostra sem
   * classificá-la, em vez de a absorver silenciosamente num dos dois lados.
   */
  porFase: { fase: FaseProcesso; quantidade: number }[];
  /**
   * `null` = SEM recorte, a carteira inteira. É o caso do cliente.
   *
   * Deixou de ser obrigatório porque o rótulo "TRF5 · 2027" na tela dele era
   * falso de duas maneiras ao mesmo tempo: escondia os processos de outros
   * tribunais E anunciava um recorte que ele nunca escolheu.
   */
  lote: { tribunal: string; exercicio: number } | null;
}

/**
 * Lote da carteira. Sem isto os agregados varriam a tabela inteira e qualquer
 * importação de teste entrava no valor total — foi exatamente o que aconteceu:
 * dois processos de um `teste-import.csv` somaram R$ 25.000,49 fictícios ao
 * número que vai para o cliente. O discriminador já existia no schema
 * (tribunal/exercicio); só não estava sendo usado.
 */
export interface LoteCarteira {
  tribunal: string;
  exercicio: number;
}

/* Continua sendo um default, mas agora é só o ponto de partida da carteira
   existente — não mais uma constante que o núcleo assume. `tribunal` é a SIGLA,
   resolvida por relação; qualquer TRF1..TRF6 entra sem tocar em código. */
export const LOTE_PADRAO: LoteCarteira = { tribunal: 'TRF5', exercicio: 2027 };

/**
 * O RESUMO DA FILA — os números que ficam em cima da lista.
 *
 * Nasceu para o módulo de pré-precatórios, que até 18/09/2026 era só uma tabela:
 * respondia "quais são" e não "o que chegou" nem "por onde começar". Os cartões
 * e os chips com contagem precisam disto, e precisam contar do MESMO jeito que
 * a lista filtra — ver `condicoesDaFila`.
 *
 * Tudo aqui é contagem de PROCESSO. `valorIndicativo` é a soma do palpite
 * extraído de texto, e `comValorIndicativo` diz de quantos processos ele veio —
 * a tela imprime os dois juntos para a soma não passar por dinheiro apurado.
 */
export interface ResumoDaFila {
  total: number;
  /** Soma do valor INDICATIVO (texto da publicação), como string pelo Decimal. */
  valorIndicativo: string;
  comValorIndicativo: number;
  /** Quantos tribunais distintos há no recorte. */
  tribunais: number;
  porFase: { fase: FaseProcesso; quantidade: number }[];
  porEsfera: { esfera: EsferaTribunal; quantidade: number }[];
  /**
   * Processos com AO MENOS uma parte naquele veredito — mesmo `some` do filtro.
   *
   * Só para a org INTERNA. O dono decidiu em 18/09/2026 que o assinante não vê
   * o agregado de conferência de CPF: é métrica de qualidade da NOSSA base, e
   * "392 CPFs a conferir" na tela de quem paga lê-se como defeito do produto.
   * Omitido na projeção dele — não zerado, pela mesma razão de `enriquecidas`
   * no `ResumoCarteira`. Desde 20/09/2026 estes chips são o ÚNICO lugar onde o
   * veredito aparece na tela: o aviso por linha saiu, e o campo saiu da resposta.
   */
  porConferencia?: { conferencia: ConferenciaNome; quantidade: number }[];
}

/**
 * Quantos eventos da timeline a página do processo recebe de uma vez.
 *
 * Hoje cada processo tem 1 evento (o IMPORTADO do backfill), mas a timeline é
 * append-only e cresce para sempre: reimportação, enriquecimento, mudança de
 * status, anotação. Sem teto, um processo acompanhado por anos devolveria o
 * histórico inteiro em toda abertura da página.
 */
const EVENTOS_POR_PAGINA = 50;

@Injectable()
export class CarteiraService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * O recorte por lote vale para a operação INTERNA. Para o CLIENTE, não.
   *
   * ── O QUE ACONTECEU ──
   *
   * O primeiro cliente real pagou por "250 precatórios por mês", recebeu os 250
   * (o motor sorteia da base inteira, sem filtro de tribunal — `sortear` é um
   * `ORDER BY random()` puro) e viu 158 na tela. Os outros 92 estavam gravados
   * em `processos_liberados`, pagos, e invisíveis: a carteira caía no
   * `LOTE_PADRAO` e escondia tudo que não fosse TRF5/2027 — dois terços da base
   * são TRF1.
   *
   * A defasagem CRESCIA a cada ciclo, porque todo mês entram mais 250 sorteados
   * do país inteiro.
   *
   * ── A REGRA ──
   *
   * Lote é como a NOSSA operação organiza importação; não é como o cliente
   * enxerga o que comprou. O universo dele É o que foi liberado para ele, e o
   * `escopoProcessos` já garante isso sozinho. Um recorte por cima disso só
   * consegue SUBTRAIR do que ele pagou.
   *
   * Pedido explícito continua mandando — é o filtro voluntário do seletor de
   * tribunal na tela. O que muda é só o DEFAULT.
   */
  private loteEfetivo(
    lote: LoteCarteira | undefined,
    usuario: EscopoUsuario,
    /**
     * "Não recorte por lote", dito de propósito.
     *
     * ── O VÃO QUE ISTO FECHA ──
     *
     * Sem lote explícito, a operação interna caía em `LOTE_PADRAO` (TRF5/2027).
     * Lote é (tribunal + exercício), e pré-precatório não tem exercício — não
     * casa com nenhum, e o seletor da tela só oferece pares que EXISTEM na base.
     * Resultado: o time interno não enxergava os pré-precatórios e não tinha
     * como pedir, enquanto o CLIENTE (que não tem recorte de lote) já os
     * recebia. A operação não conseguia revisar o que estava sendo vendido.
     *
     * `undefined` continua significando "o padrão"; `true` é um pedido, e só o
     * módulo de pré-precatórios o faz. A diferença entre ausência e escolha é o
     * que impede uma tela de perder o recorte por esquecimento.
     */
    semLote = false,
  ): LoteCarteira | null {
    if (semLote) return null;
    if (lote) return lote;
    return ehEscopoCliente(usuario) ? null : LOTE_PADRAO;
  }

  /** O pedaço `where` do lote — vazio quando não há recorte (cliente). */
  private filtroDeLote(lote: LoteCarteira | null) {
    return lote ? { tribunal: { sigla: lote.tribunal }, exercicio: lote.exercicio } : {};
  }

  async resumo(params: { lote?: LoteCarteira; usuario: EscopoUsuario }): Promise<ResumoCarteira> {
    const { usuario } = params;
    const lote = this.loteEfetivo(params.lote, usuario);
    const ehCliente = ehEscopoCliente(usuario);
    const doLote = {
      ...this.filtroDeLote(lote),
      ...escopoProcessos(usuario),
    };
    /* Pessoa não tem lote próprio: pertence ao lote pelos processos a que está
       vinculada. Contar sem esta trava incluiria gente de outras importações. */
    const pessoaNoLote = { processos: { some: { processo: doLote } } };

    const [pessoas, processos, soma, enriquecidas, agrupado, porEstagio] = await Promise.all([
      this.prisma.pessoa.count({ where: pessoaNoLote }),
      this.prisma.processo.count({ where: doLote }),
      this.prisma.processoPessoa.aggregate({
        _sum: { valorIndividual: true },
        where: { processo: doLote },
      }),
      /* Para o cliente nem é consultado: além de não sair na resposta, gastar uma
         contagem com a métrica que ele não pode ver seria trabalho jogado fora. */
      ehCliente
        ? Promise.resolve(0)
        : this.prisma.pessoa.count({
            where: { ...pessoaNoLote, statusEnriquecimento: 'SINCRONIZADO' },
          }),
      this.prisma.processo.groupBy({
        by: ['entidadeDevedora'],
        /* `valor: true` conta os NÃO-NULOS daquela coluna. É o que permite à tela
           dizer quantos dos processos daquela entidade têm valor apurado — antes,
           a barra somava só o apurado enquanto a contagem incluía o
           pré-precatório, e nada dizia que eram conjuntos diferentes. */
        _count: { _all: true, valor: true },
        _sum: { valor: true },
        where: doLote,
      }),
      /* Um `groupBy` em vez de duas contagens (uma por lista fechada): custa uma
         consulta só, e devolve TAMBÉM as fases que ninguém previu — enquanto
         duas contagens deixariam uma fase nova fora das duas e ninguém veria. */
      this.prisma.processo.groupBy({
        by: ['fase'],
        _count: { _all: true },
        where: doLote,
      }),
    ]);

    /* Ordenação em memória, não no banco: em Postgres, ORDER BY ... DESC coloca
       NULL PRIMEIRO, então uma devedora sem valor lançado assumiria o topo do
       ranking e empurraria uma real para fora do `take`. São poucas dezenas de
       entidades, o custo é irrelevante e o resultado é previsível. */
    const porEntidade = agrupado
      .map((g) => ({
        entidade: g.entidadeDevedora ?? 'Não informada',
        quantidade: g._count._all,
        comValor: g._count.valor,
        valor: (g._sum.valor ?? 0).toString(),
      }))
      /* Desempate por tamanho: entidade cuja exposição é toda pré-precatório soma
         R$ 0 e empatava com todas as outras zeradas, sobrevivendo ao `take` só
         pela ordem em que o banco devolveu. Com o desempate, entre as zeradas
         fica a maior — que é a informação. */
      .sort((a, b) => Number(b.valor) - Number(a.valor) || b.quantidade - a.quantidade)
      .slice(0, 8);

    const base = {
      pessoas,
      processos,
      valorTotal: (soma._sum.valorIndividual ?? 0).toString(),
      porEntidade,
      /* Ordem estável e decrescente: a tela lê isto como texto curto ao lado de
         um número, e uma ordem que muda a cada carga faria a mesma carteira
         parecer diferente entre dois recarregamentos. */
      porFase: porEstagio
        .map((g) => ({ fase: g.fase, quantidade: g._count._all }))
        .sort((a, b) => b.quantidade - a.quantidade),
      lote,
    };
    /* Omitidos, não zerados: zero seria uma AFIRMAÇÃO falsa sobre a carteira do
       cliente ("nenhuma enriquecida"), e é justamente o vocabulário que ele não
       pode enxergar. Ausência é a resposta honesta. */
    return ehCliente ? base : { ...base, enriquecidas, pendentes: pessoas - enriquecidas };
  }

  /**
   * Catálogo de tribunais, com o que a organização de fato tem em cada um.
   *
   * É o que torna a abrangência nacional utilizável em vez de teórica: a tela
   * precisa saber QUAIS tribunais existem, quais UFs cada um cobre (para o
   * filtro de UF deixar de ser uma lista fixa do Nordeste) e em quais exercícios
   * há carteira — senão o seletor ofereceria lotes vazios.
   *
   * `exercicios` sai do dado real, não de um intervalo inventado: um escritório
   * que só tem 2027 não deve ver 2024..2030 no seletor.
   */
  async tribunais(usuario: EscopoUsuario) {
    const [catalogo, lotes] = await Promise.all([
      this.prisma.tribunal.findMany({
        where: { ativo: true },
        orderBy: { sigla: 'asc' },
        select: { id: true, sigla: true, nome: true, esfera: true, ufsJurisdicao: true },
      }),
      /* Um groupBy por (tribunal, exercício) com contagem. É o inventário de
         lotes que a org realmente TEM — para a INTERNA, o que ela possui; para o
         CLIENTE, o que lhe foi liberado (o mesmo escopo do resto da carteira). */
      this.prisma.processo.groupBy({
        by: ['tribunalId', 'exercicio'],
        _count: { _all: true },
        where: escopoProcessos(usuario),
      }),
    ]);

    return catalogo.map((t) => ({
      sigla: t.sigla,
      nome: t.nome,
      esfera: t.esfera,
      ufsJurisdicao: t.ufsJurisdicao,
      exercicios: lotes
        .filter((l) => l.tribunalId === t.id && l.exercicio !== null)
        .map((l) => ({ exercicio: l.exercicio as number, processos: l._count._all }))
        /* Mais recente primeiro: é o exercício em que se trabalha. */
        .sort((a, b) => b.exercicio - a.exercicio),
      processos: lotes
        .filter((l) => l.tribunalId === t.id)
        .reduce((s, l) => s + l._count._all, 0),
    }));
  }

  /**
   * Painel de BI: alcançabilidade da carteira e estado agregado da operação.
   *
   * A pergunta que ele responde, e que o `resumo` sozinho não respondia: DE QUE
   * ADIANTA o valor total. Precatório cujo titular não se alcança não é ativo
   * acionável — é linha de planilha. `valorAlcancavel` separa os dois, e é o
   * número que justifica (ou condena) o gasto com enriquecimento.
   *
   * `hoje` vem do CLIENTE, em AAAA-MM-DD. O servidor não sabe o fuso de quem
   * olha, e "tarefa atrasada" muda de resposta conforme o relógio do operador —
   * o mesmo cuidado das outras telas. Sem o parâmetro, cai na data do servidor.
   *
   * Tudo recortado pelo MESMO lote do `resumo`. Misturar recortes aqui repetiria
   * o problema que criou o conceito de lote: números que não fecham entre si na
   * mesma tela, sem nada explicando a diferença.
   */
  /**
   * Requerentes por UF, para o mapa — quantos titulares DO LOTE têm endereço
   * ativo em cada estado.
   *
   * `COUNT(DISTINCT p.id)` no cru de propósito: uma pessoa pode ter mais de um
   * endereço ativo na mesma UF, e o `groupBy` do Prisma contaria linhas de
   * endereço (`enderecos`), não gente. O escopo é o mesmo do painel — só entra
   * quem tem vínculo num processo do tribunal/exercício da organização —, então
   * o mapa colore o país com a carteira real, não com a base inteira.
   */
  async mapa(params: {
    lote?: LoteCarteira;
    usuario: EscopoUsuario;
  }): Promise<{ uf: string; requerentes: number }[]> {
    const { usuario } = params;
    const lote = this.loteEfetivo(params.lote, usuario);
    /* O escopo entra como fragmento SQL dentro do EXISTS que amarra pessoa ao
       processo do lote: a INTERNA filtra pela PROPRIEDADE do processo; o CLIENTE,
       pela LIBERAÇÃO. Mesmo recorte do resto da carteira. */
    const escopoSql =
      ehEscopoCliente(usuario)
        ? Prisma.sql`EXISTS (SELECT 1 FROM processos_liberados pl WHERE pl."processoId" = pr.id AND pl."organizationId" = ${usuario.organizationId}::uuid)`
        : Prisma.sql`pr."organizationId" = ${usuario.organizationId}::uuid`;
    /* Sem lote, o recorte some do SQL — e não vira `t.sigla = NULL`, que casaria
       com nada e pintaria o mapa em branco justamente para o cliente. */
    const loteSql = lote
      ? Prisma.sql`AND t.sigla = ${lote.tribunal} AND pr.exercicio = ${lote.exercicio}`
      : Prisma.empty;
    const linhas = await this.prisma.$queryRaw<{ uf: string; requerentes: bigint }[]>(Prisma.sql`
      SELECT e.uf AS uf, COUNT(DISTINCT p.id) AS requerentes
      FROM enderecos e
      JOIN pessoas p ON p.id = e."pessoaId"
      WHERE e.ativo = true AND e.uf IS NOT NULL AND length(e.uf) = 2
        AND EXISTS (
          SELECT 1 FROM processo_pessoas pp
          JOIN processos pr ON pr.id = pp."processoId"
          JOIN tribunais t ON t.id = pr."tribunalId"
          WHERE pp."pessoaId" = p.id
            AND ${escopoSql}
            ${loteSql}
        )
      GROUP BY e.uf
      ORDER BY requerentes DESC
    `);
    return linhas.map((l) => ({ uf: l.uf.toUpperCase(), requerentes: Number(l.requerentes) }));
  }

  /**
   * Grava, de forma IDEMPOTENTE, o retrato de hoje da carteira.
   *
   * Reusa os números que o `painel` acabou de calcular, então quase não custa —
   * só resolve o `tribunalId` e faz um insert que NÃO FAZ NADA se o dia já
   * existe (createMany skipDuplicates = ON CONFLICT DO NOTHING). É chamado em
   * fire-and-forget pelo painel: nunca bloqueia nem quebra a resposta.
   */
  private async registrarSnapshot(dados: {
    organizationId: string;
    lote: LoteCarteira;
    processos: number;
    pessoas: number;
    comAlgumContato: number;
    valorTotal: string;
    valorAlcancavel: string;
  }): Promise<void> {
    const tribunal = await this.prisma.tribunal.findUnique({
      where: { sigla: dados.lote.tribunal },
      select: { id: true },
    });
    if (!tribunal) return;
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);
    await this.prisma.snapshotCarteira.createMany({
      data: [
        {
          organizationId: dados.organizationId,
          tribunalId: tribunal.id,
          exercicio: dados.lote.exercicio,
          data: hoje,
          processos: dados.processos,
          pessoas: dados.pessoas,
          comAlgumContato: dados.comAlgumContato,
          valorTotal: dados.valorTotal,
          valorAlcancavel: dados.valorAlcancavel,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Série diária dos indicadores, para os sparklines de tendência dos KPIs.
   *
   * Nasce vazia (ou com um ponto só) e enche a cada dia — a Fase 4 é começar a
   * gravar, não ter histórico pronto. Devolve os últimos `dias`, em ordem
   * cronológica, no escopo do lote da organização.
   */
  async tendencias(params: { lote?: LoteCarteira; organizationId: string; dias?: number }) {
    const { lote = LOTE_PADRAO, organizationId, dias = 30 } = params;
    const tribunal = await this.prisma.tribunal.findUnique({
      where: { sigla: lote.tribunal },
      select: { id: true },
    });
    if (!tribunal) return [];
    const desde = new Date();
    desde.setUTCHours(0, 0, 0, 0);
    desde.setUTCDate(desde.getUTCDate() - (dias - 1));
    const linhas = await this.prisma.snapshotCarteira.findMany({
      where: {
        organizationId,
        tribunalId: tribunal.id,
        exercicio: lote.exercicio,
        data: { gte: desde },
      },
      orderBy: { data: 'asc' },
      select: {
        data: true,
        processos: true,
        pessoas: true,
        comAlgumContato: true,
        valorTotal: true,
        valorAlcancavel: true,
      },
    });
    return linhas.map((l) => ({
      data: l.data.toISOString().slice(0, 10),
      processos: l.processos,
      pessoas: l.pessoas,
      comAlgumContato: l.comAlgumContato,
      valorTotal: l.valorTotal.toString(),
      valorAlcancavel: l.valorAlcancavel.toString(),
    }));
  }

  async painel(params: { lote?: LoteCarteira; usuario: EscopoUsuario; hoje?: string }) {
    const { usuario, hoje } = params;
    const lote = this.loteEfetivo(params.lote, usuario);
    const doLote = {
      ...this.filtroDeLote(lote),
      ...escopoProcessos(usuario),
    };
    const pessoaNoLote = { processos: { some: { processo: doLote } } };

    /* "Tem contato" = tem ao menos um canal ATIVO. `ativo: false` é dado que o
       provedor deixou de confirmar; contá-lo inflaria a alcançabilidade
       justamente com o que provavelmente não funciona mais. */
    const comAlgum = {
      OR: [
        { telefones: { some: { ativo: true } } },
        { emails: { some: { ativo: true } } },
        { enderecos: { some: { ativo: true } } },
      ],
    };

    const dataCorte = hoje ? new Date(`${hoje}T00:00:00.000Z`) : new Date();

    const [
      pessoas,
      comTelefone,
      comEmail,
      comEndereco,
      comAlgumContato,
      somaTotal,
      somaAlcancavel,
      totalProcessos,
    ] = await Promise.all([
      this.prisma.pessoa.count({ where: pessoaNoLote }),
      this.prisma.pessoa.count({ where: { ...pessoaNoLote, telefones: { some: { ativo: true } } } }),
      this.prisma.pessoa.count({ where: { ...pessoaNoLote, emails: { some: { ativo: true } } } }),
      this.prisma.pessoa.count({ where: { ...pessoaNoLote, enderecos: { some: { ativo: true } } } }),
      this.prisma.pessoa.count({ where: { ...pessoaNoLote, ...comAlgum } }),

      this.prisma.processoPessoa.aggregate({
        _sum: { valorIndividual: true },
        where: { processo: doLote },
      }),
      /* O valor que está preso a gente que dá para contatar. Some por VÍNCULO,
         não por processo: o valor é devido à pessoa, e é a pessoa que se
         alcança ou não. */
      this.prisma.processoPessoa.aggregate({
        _sum: { valorIndividual: true },
        where: { processo: doLote, pessoa: comAlgum },
      }),

      this.prisma.processo.count({ where: doLote }),
    ]);

    /* O bloco operacional (tarefas, prioridade, responsável) diverge por tipo de
       org — ver `operacao`. Fica fora do Promise.all porque o ramo do cliente faz
       seu próprio par de consultas. */
    const operacao = await this.operacao(usuario, lote, doLote, dataCorte, totalProcessos);

    /* Retrato do dia, sem bloquear a resposta — as tendências dos KPIs nascem
       daqui. Grava por ORG: cada cliente acumula o histórico da PRÓPRIA carteira. */
    /* Só grava snapshot quando HÁ lote. A tabela é chaveada por (org, tribunal,
       exercício, dia), e a carteira do cliente atravessa tribunais — não existe
       um tribunal para carimbar. Inventar um faria a série de tendências contar
       uma história falsa; sem snapshot, o sparkline mostra "coletando", que é a
       verdade. Fica como pendência: dar histórico ao cliente exige gravar por
       tribunal e somar na leitura. */
    if (lote) {
      void this.registrarSnapshot({
        organizationId: usuario.organizationId,
        lote,
        processos: totalProcessos,
        pessoas,
        comAlgumContato,
        valorTotal: (somaTotal._sum.valorIndividual ?? 0).toString(),
        valorAlcancavel: (somaAlcancavel._sum.valorIndividual ?? 0).toString(),
      }).catch(() => undefined);
    }

    return {
      lote,
      cobertura: {
        pessoas,
        comTelefone,
        comEmail,
        comEndereco,
        comAlgumContato,
        valorTotal: (somaTotal._sum.valorIndividual ?? 0).toString(),
        valorAlcancavel: (somaAlcancavel._sum.valorIndividual ?? 0).toString(),
      },
      operacao,
    };
  }

  /**
   * O bloco operacional do painel — tarefas abertas/atrasadas, distribuição por
   * prioridade e processos sem responsável — SEMPRE no escopo de quem olha.
   *
   * As tarefas são contadas por `organizationId`, não só pelo processo: no
   * multi-tenant, um cliente cria tarefa num processo que é PROPRIEDADE da org
   * interna (liberado a ele). Contar por processo faria a tarefa do cliente
   * inflar o painel do time interno — o vazamento que a coluna `organizationId`
   * da Fase A existe para fechar. Para a INTERNA hoje o filtro é no-op (não há
   * tarefa de cliente ainda), então o número não muda.
   *
   * Prioridade e responsável divergem por ORIGEM: o time interno mantém os seus
   * nas colunas do próprio Processo; o cliente, no overlay CarteiraProcesso. Daí
   * o ramo — não é duplicação supérflua, são duas fontes de verdade distintas
   * (ver a nota em CarteiraProcesso no schema). O ramo do cliente faz COALESCE
   * para NORMAL / "sem responsável" nos processos que ele ainda não triou.
   */
  private async operacao(
    usuario: EscopoUsuario,
    /** `null` = sem recorte de lote. É o caso do CLIENTE: ver `loteEfetivo`. */
    lote: LoteCarteira | null,
    doLote: Prisma.ProcessoWhereInput,
    dataCorte: Date,
    totalProcessos: number,
  ) {
    const tarefaBase = { organizationId: usuario.organizationId, processo: doLote };
    const [tarefasAbertas, tarefasAtrasadas] = await Promise.all([
      this.prisma.tarefaProcesso.count({ where: { concluidaEm: null, ...tarefaBase } }),
      this.prisma.tarefaProcesso.count({
        where: { concluidaEm: null, prazo: { lt: dataCorte }, ...tarefaBase },
      }),
    ]);

    /* Ordem do enum (URGENTE→BAIXA): a tela desenha nesta sequência e ordem
       instável faria as cores dançarem entre dois carregamentos. */
    const ordem = ['URGENTE', 'ALTA', 'NORMAL', 'BAIXA'] as const;

    if (!ehEscopoCliente(usuario)) {
      const [porPrioridade, semResponsavel] = await Promise.all([
        this.prisma.processo.groupBy({
          by: ['prioridade'],
          _count: { _all: true },
          _sum: { valor: true },
          where: doLote,
        }),
        this.prisma.processo.count({ where: { ...doLote, responsavelId: null } }),
      ]);
      return {
        tarefasAbertas,
        tarefasAtrasadas,
        processosSemResponsavel: semResponsavel,
        porPrioridade: ordem.map((nivel) => {
          const g = porPrioridade.find((x) => x.prioridade === nivel);
          return {
            prioridade: nivel,
            quantidade: g?._count._all ?? 0,
            valor: (g?._sum.valor ?? 0).toString(),
          };
        }),
      };
    }

    /* Cliente: prioridade sai do overlay dele, com COALESCE para NORMAL nos
       processos ainda não triados. Um raw só, porque é um GROUP BY sobre o LEFT
       JOIN processo↔overlay que o groupBy do Prisma não expressa.

       ⚠ Este raw expressa o escopo PELA SEGUNDA VEZ (o JOIN em
       processos_liberados abaixo), em vez de reusar `escopoProcessos` — um
       fragmento de where do Prisma não entra numa query crua. Ou seja: o escopo
       do cliente vive em DOIS lugares neste método, e eles podem divergir. A
       trava contra isso é o teste do painel do cliente, que afere os dois
       caminhos de propósito (`porPrioridade`, que vem daqui, e
       `processosSemResponsavel`, que vem do `doLote`). Mexeu num, confira o outro. */
    const [linhas, comResponsavel] = await Promise.all([
      this.prisma.$queryRaw<{ prioridade: string; quantidade: number; valor: string }[]>(Prisma.sql`
        SELECT COALESCE(cp.prioridade::text, 'NORMAL') AS prioridade,
               COUNT(*)::int AS quantidade,
               COALESCE(SUM(pr.valor), 0)::text AS valor
        FROM processos pr
        JOIN processos_liberados pl
          ON pl."processoId" = pr.id AND pl."organizationId" = ${usuario.organizationId}::uuid
        JOIN tribunais t ON t.id = pr."tribunalId"
        LEFT JOIN carteira_processo cp
          ON cp."processoId" = pr.id AND cp."organizationId" = ${usuario.organizationId}::uuid
        WHERE ${
          lote
            ? Prisma.sql`t.sigla = ${lote.tribunal} AND pr.exercicio = ${lote.exercicio}`
            : Prisma.sql`TRUE`
        }
        GROUP BY COALESCE(cp.prioridade::text, 'NORMAL')
      `),
      this.prisma.carteiraProcesso.count({
        where: {
          organizationId: usuario.organizationId,
          responsavelId: { not: null },
          processo: doLote,
        },
      }),
    ]);
    const porNivel = new Map(linhas.map((l) => [l.prioridade, l]));
    return {
      tarefasAbertas,
      tarefasAtrasadas,
      /* Sem responsável = os do escopo menos os que já têm responsável no overlay. */
      processosSemResponsavel: totalProcessos - comResponsavel,
      porPrioridade: ordem.map((nivel) => {
        const l = porNivel.get(nivel);
        return { prioridade: nivel, quantidade: l?.quantidade ?? 0, valor: l?.valor ?? '0' };
      }),
    };
  }

  /**
   * Busca no banco INTERNO. Nunca consulta provider externo em tempo real.
   * Paginada por padrão — a carteira cresce e a tela não pode puxar tudo.
   */
  async buscar(params: {
    termo?: string;
    uf?: string;
    pagina: number;
    porPagina: number;
    lote?: LoteCarteira;
    usuario: EscopoUsuario;
  }) {
    const { termo, uf, pagina, porPagina, usuario } = params;
    const lote = this.loteEfetivo(params.lote, usuario);
    const somenteDigitos = (termo ?? '').replace(/\D/g, '');
    const buscaPorCpf = somenteDigitos.length >= 6;
    const doLote = {
      ...this.filtroDeLote(lote),
      ...escopoProcessos(usuario),
    };

    /* Mesmo recorte do resumo. Sem isto, o dashboard declarava "TRF5 · 2027"
       enquanto a busca devolvia gente de qualquer lote — o operador acharia um
       CPF que o total agregado afirma não existir, e os dois números nunca
       fechariam sem nada na tela explicando a diferença. */
    const where = {
      AND: [
        { processos: { some: { processo: doLote } } },
        termo
          ? buscaPorCpf
            ? { cpf: { contains: somenteDigitos } }
            : {
                OR: [
                  { nomeNormalizado: { contains: this.normalizar(termo) } },
                  {
                    processos: {
                      some: { processo: { ...doLote, numeroPrecatorio: { contains: termo } } },
                    },
                  },
                ],
              }
          : {},
        uf ? { enderecos: { some: { uf: uf.toUpperCase() } } } : {},
      ],
    };

    const [total, itens] = await Promise.all([
      this.prisma.pessoa.count({ where }),
      this.prisma.pessoa.findMany({
        where,
        skip: (pagina - 1) * porPagina,
        take: porPagina,
        orderBy: { nome: 'asc' },
        select: {
          id: true,
          cpf: true,
          nome: true,
          statusEnriquecimento: true,
          ultimaSincronizacao: true,
          telefones: { where: { ativo: true }, take: 1, select: { ddd: true, numero: true } },
          emails: { where: { ativo: true }, take: 1, select: { endereco: true } },
          enderecos: { where: { ativo: true }, take: 1, select: { cidade: true, uf: true } },
          processos: {
            /* Recorta também os precatórios exibidos: a pessoa entra pelo lote,
               então mostrar processos de fora dele reintroduziria a divergência
               que o filtro acima existe para eliminar. */
            where: { processo: doLote },
            take: 3,
            select: {
              valorIndividual: true,
              processo: {
                /* `id` é o que torna cada precatório do resultado clicável até a
                   página do processo. Sem ele a busca acha o precatório e a tela
                   não tem como abri-lo. */
                /* ⚠ `fase` e `valorIndicativo` são obrigatórios aqui pela mesma
                   razão da fila e do funil — mas esta projeção tinha ficado para
                   trás, e era a mais perigosa das três: a Consulta é a porta de
                   entrada por CPF, o caminho mais curto entre o advogado e um
                   nome. Sem a fase, o `SeloFase` não tem o que renderizar, e um
                   pré-precatório sai idêntico a um precatório na fila
                   orçamentária. O comentário logo acima já chamava o resultado
                   de "precatório" — a tela dizia isso ao cliente. */
                select: {
                  id: true,
                  numeroPrecatorio: true,
                  entidadeDevedora: true,
                  situacao: true,
                  fase: true,
                  valorIndicativo: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: itens.map((p) => {
        const processos = p.processos.map((v) => ({
          ...v,
          valorIndividual: v.valorIndividual?.toString() ?? null,
          /* `valorIndicativo` é Decimal e não sobrevive ao JSON como número
             confiável — vai como string, igual ao `valorIndividual` acima. */
          processo: {
            ...v.processo,
            valorIndicativo: v.processo.valorIndicativo?.toString() ?? null,
          },
        }));
        const base = {
          id: p.id,
          cpf: p.cpf,
          nome: p.nome,
          telefones: p.telefones,
          emails: p.emails,
          enderecos: p.enderecos,
          processos,
        };
        /* Para o cliente, status e última sincronização do enriquecimento não
           existem: a base "é dele", sem rastro de provedor. Somem da projeção —
           e não por strip depois, mas por não serem montados. */
        return ehEscopoCliente(usuario)
          ? base
          : {
              ...base,
              statusEnriquecimento: p.statusEnriquecimento,
              ultimaSincronizacao: p.ultimaSincronizacao,
            };
      }),
    };
  }

  /**
   * A FILA DE TRABALHO: a carteira como lista acionável.
   *
   * ── POR QUE NÃO É UM FILTRO DA BUSCA ──
   *
   * `buscar` responde "onde está esta PESSOA" — entra por CPF ou nome e devolve
   * gente, com os precatórios dela por baixo. A fila responde outra pergunta:
   * "o que eu trabalho agora". A unidade é o PROCESSO, porque é nele que moram
   * estágio, prioridade, responsável, etiqueta e contato.
   *
   * Enfiar isso na busca faria uma rota com duas unidades de resposta,
   * dependendo dos parâmetros — o tipo de coisa que quebra o cliente no dia em
   * que alguém combina filtros que ninguém previu.
   *
   * ── A ORDEM É POR VALOR, E OS FILTROS FAZEM O RESTO ──
   *
   * Ordenar por prioridade ou por "há mais tempo sem contato" seria natural, e
   * os dois moram no OVERLAY — uma relação. O Prisma não ordena por campo de
   * relação to-many, e resolver isso exigiria SQL cru com LEFT JOIN, repetindo
   * à mão todos os filtros abaixo.
   *
   * A troca escolhida: os FILTROS isolam o recorte (`prioridade=URGENTE`,
   * `semContato`), e dentro dele a ordem é o dinheiro — maior valor primeiro,
   * que é a régua que o escritório usa para decidir por onde começar.
   * `nulls: 'last'` porque em Postgres o DESC coloca NULL primeiro, e processo
   * sem valor lançado tomaria o topo da fila.
   */
  /* Os filtros vêm do tipo COMPARTILHADO com o funil: acrescentar um aqui e
     esquecer lá é como o chip e a lista voltariam a divergir. */
  async fila(
    params: FiltrosDaFila & {
      pagina: number;
      porPagina: number;
      lote?: LoteCarteira;
      /** Ver `loteEfetivo`: pedido explícito de "a carteira inteira". */
      semLote?: boolean;
      usuario: EscopoUsuario;
    },
  ) {
    const { pagina, porPagina, usuario } = params;
    /* `?? undefined` porque `condicoesDaFila` já trata lote AUSENTE como "a
       carteira inteira" — é o mesmo significado, e reaproveitar o caminho que já
       existe evita uma segunda regra dizendo a mesma coisa com outras palavras. */
    const lote = this.loteEfetivo(params.lote, usuario, params.semLote) ?? undefined;
    const org = usuario.organizationId;

    /* A MESMA montagem que o funil usa para CONTAR. Ver condicoes-da-fila.ts:
       chip e lista que nascem de códigos diferentes divergem no primeiro ajuste,
       e um total que contradiz a lista abaixo dele não é informação, é ruído. */
    const condicoes = condicoesDaFila(params, { usuario, lote });

    /* Quem olha decide DE ONDE sai prioridade e responsável na linha montada lá
       embaixo — a mesma dualidade que `condicoesDaFila` aplica no filtro. */
    const ehCliente = ehEscopoCliente(usuario);

    const where: Prisma.ProcessoWhereInput = { AND: condicoes };

    const [total, processos] = await Promise.all([
      this.prisma.processo.count({ where }),
      this.prisma.processo.findMany({
        where,
        skip: (pagina - 1) * porPagina,
        take: porPagina,
        /* ⚠ CHAVE SECUNDÁRIA, e não uma régua só.
           A ordem é o dinheiro, e o dinheiro do pré-precatório está em OUTRA
           coluna: com `valor DESC NULLS LAST` os 1.169 afundavam em bloco para o
           fim de qualquer lista, e dentro do módulo de pré-precatórios — onde
           TODOS têm `valor` nulo — a ordem virava o `id`, ou seja, nenhuma.

           Intercalar os dois numa régua só exigiria `COALESCE` em SQL cru, e
           misturaria valor apurado com palpite extraído de texto na mesma
           escala. Como chave secundária não muda nada para quem tem `valor`, e
           dá magnitude a quem só tem o indicativo. */
        orderBy: [
          { valor: { sort: 'desc', nulls: 'last' } },
          { valorIndicativo: { sort: 'desc', nulls: 'last' } },
          { id: 'asc' },
        ],
        select: {
          id: true,
          numeroPrecatorio: true,
          entidadeDevedora: true,
          situacao: true,
          valor: true,
          /* ── O ESTÁGIO REAL DO CRÉDITO, e o valor que é palpite ──

             Sem estes dois na tela, um pré-precatório fica indistinguível de um
             precatório na fila orçamentária: mesmo número, mesma linha, mesmo
             valor com cara de apurado. E a decisão de incluí-los no sorteio dos
             250 tornou isso obrigatório — a landing vende "250 precatórios por
             mês", e entregar oportunidade ainda não exigível sem dizer qual é
             qual é o terreno do art. 37, §1º do CDC. */
          fase: true,
          valorIndicativo: true,
          /* A SIGLA do tribunal. Na carteira ela é implícita — está no lote que
             recorta a tela. No módulo de pré-precatórios há 42, e de qual
             tribunal é o processo muda a abordagem: consulta pública, prazo e
             até o ente devedor mudam entre um TJ e um TRT. */
          tribunal: { select: { sigla: true } },
          /* As colunas do PROCESSO: é delas que sai a triagem do time interno.
             Para o cliente, o overlay abaixo tem precedência. */
          prioridade: true,
          responsavel: { select: { id: true, nome: true } },
          /* O titular, para a linha ser reconhecível sem abrir o processo — é
             para ele que se liga. */
          partes: {
            take: 1,
            select: {
              pessoa: {
                select: {
                  id: true,
                  nome: true,
                  cpf: true,
                  /* ⚠ SEM `conferenciaNome`, desde 20/09/2026.
                     O veredito saiu das telas e, com elas, da RESPOSTA: nenhum
                     código do front o lia mais, e um campo que ninguém desenha
                     continuava viajando até o navegador do assinante, visível a
                     quem abrisse as ferramentas do desenvolvedor. Ele segue
                     apurado e gravado, e segue decidindo o sorteio — o filtro
                     por veredito da tela de pré-precatórios é resolvido no
                     SERVIDOR (`condicoesDaFila`), então não precisa do campo
                     aqui. */
                },
              },
            },
          },
          etiquetas: { select: { etiqueta: { select: { id: true, nome: true, cor: true } } } },
          carteira: {
            where: { organizationId: org },
            select: {
              estagio: true,
              estagioEm: true,
              prioridade: true,
              ultimoContatoEm: true,
              responsavel: { select: { id: true, nome: true } },
            },
          },
          tarefas: {
            where: { organizationId: org, concluidaEm: null },
            select: { prazo: true },
          },
        },
      }),
    ]);

    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens: processos.map((p) => {
        const o = p.carteira[0];
        const titular = p.partes[0]?.pessoa ?? null;
        return {
          id: p.id,
          numeroPrecatorio: p.numeroPrecatorio,
          entidadeDevedora: p.entidadeDevedora,
          situacao: p.situacao,
          valor: p.valor?.toString() ?? null,
          fase: p.fase,
          /* String, como `valor`: Decimal do Prisma não sobrevive ao
             JSON.stringify com precisão. */
          valorIndicativo: p.valorIndicativo?.toString() ?? null,
          /* Achatada para a sigla: a tela mostra "TJMG", não um objeto. */
          tribunal: p.tribunal.sigla,
          titular,
          /* Padrões EXPLÍCITOS: a tela não pode precisar saber que ausência de
             linha no overlay significa "novo". */
          estagio: o?.estagio ?? 'NOVO',
          estagioEm: o?.estagioEm ?? null,
          ultimoContatoEm: o?.ultimoContatoEm ?? null,
          /* E aqui a dualidade documentada: overlay para o cliente, coluna do
             processo para o time interno. */
          prioridade: ehCliente ? (o?.prioridade ?? 'NORMAL') : p.prioridade,
          responsavel: ehCliente ? (o?.responsavel ?? null) : p.responsavel,
          etiquetas: p.etiquetas.map((e) => e.etiqueta),
          tarefasAbertas: p.tarefas.length,
          tarefasAtrasadas: p.tarefas.filter((t) => t.prazo && t.prazo < hoje).length,
        };
      }),
    };
  }

  /**
   * Os números em cima da fila: total, soma indicativa e a quebra por fase,
   * esfera e veredito do CPF. Ver `ResumoDaFila`.
   *
   * ── O QUE ELE IGNORA, DE PROPÓSITO ──
   *
   * Os três chips (`fase`, `esfera`, `conferencia`) ficam de fora da contagem,
   * pela mesma regra do funil com `estagio`: clicar em "Estadual" não pode zerar
   * os chips "Federal" e "Trabalhista", senão o operador perde a referência de
   * onde está. O resto dos filtros (termo, responsável…) ENTRA — é o mesmo
   * universo da lista, só sem o recorte que o próprio chip faz.
   */
  async resumoDaFila(
    params: FiltrosDaFila & {
      lote?: LoteCarteira;
      semLote?: boolean;
      usuario: EscopoUsuario;
    },
  ): Promise<ResumoDaFila> {
    const { usuario } = params;
    const lote = this.loteEfetivo(params.lote, usuario, params.semLote) ?? undefined;
    const semChips: FiltrosDaFila = {
      ...params,
      fase: undefined,
      esfera: undefined,
      conferencia: undefined,
    };
    const where: Prisma.ProcessoWhereInput = {
      AND: condicoesDaFila(semChips, { usuario, lote }),
    };
    /* Para o cliente nem é consultado: além de não sair na resposta, três
       contagens de uma métrica que ele não pode ver seriam trabalho jogado fora. */
    const ehCliente = ehEscopoCliente(usuario);
    const comVeredito = (v: ConferenciaNome) =>
      ehCliente
        ? Promise.resolve(0)
        : this.prisma.processo.count({
            where: { ...where, partes: { some: { pessoa: { conferenciaNome: v } } } },
          });

    const [total, soma, porFase, porTribunal, catalogo, conferem, divergem, semVeredito] =
      await Promise.all([
        this.prisma.processo.count({ where }),
        this.prisma.processo.aggregate({
          where,
          _sum: { valorIndicativo: true },
          /* `valorIndicativo: true` conta os NÃO-NULOS: é o "de quantos" que a
             tela imprime ao lado da soma. */
          _count: { valorIndicativo: true },
        }),
        this.prisma.processo.groupBy({ by: ['fase'], _count: { _all: true }, where }),
        /* Prisma não agrupa por campo de relação; agrupa-se pelo id e a esfera
           vem do catálogo, que tem poucas dezenas de linhas. De quebra sai o
           número de tribunais distintos, que o cartão usa. */
        this.prisma.processo.groupBy({ by: ['tribunalId'], _count: { _all: true }, where }),
        this.prisma.tribunal.findMany({ select: { id: true, esfera: true } }),
        comVeredito('CONFERE'),
        comVeredito('DIVERGE'),
        comVeredito('NAO_CONFERIDO'),
      ]);

    const esferaDe = new Map(catalogo.map((t) => [t.id, t.esfera]));
    const porEsfera = new Map<EsferaTribunal, number>();
    for (const g of porTribunal) {
      const esfera = esferaDe.get(g.tribunalId);
      if (!esfera) continue;
      porEsfera.set(esfera, (porEsfera.get(esfera) ?? 0) + g._count._all);
    }

    const base = {
      total,
      valorIndicativo: (soma._sum.valorIndicativo ?? 0).toString(),
      comValorIndicativo: soma._count.valorIndicativo,
      tribunais: porTribunal.length,
      /* Ordem estável (decrescente), como no `resumo`: a mesma base não pode
         parecer diferente entre dois recarregamentos. */
      porFase: porFase
        .map((g) => ({ fase: g.fase, quantidade: g._count._all }))
        .sort((a, b) => b.quantidade - a.quantidade),
      porEsfera: [...porEsfera]
        .map(([esfera, quantidade]) => ({ esfera, quantidade }))
        .sort((a, b) => b.quantidade - a.quantidade),
    };
    if (ehCliente) return base;
    return {
      ...base,
      porConferencia: [
        { conferencia: 'CONFERE' as const, quantidade: conferem },
        { conferencia: 'DIVERGE' as const, quantidade: divergem },
        { conferencia: 'NAO_CONFERIDO' as const, quantidade: semVeredito },
      ],
    };
  }

  /**
   * Um processo com tudo que a página do CRM mostra: dados, partes e timeline.
   *
   * Escopado por `organizationId`, e não pelo lote. São coisas diferentes: o
   * lote (tribunal + exercício) é um RECORTE DE EXIBIÇÃO, existe para os
   * agregados do dashboard não somarem importação de teste; a organização é a
   * FRONTEIRA DE ACESSO declarada no schema. Filtrar o detalhe por lote faria o
   * operador clicar num resultado da busca e receber 404 assim que o lote em
   * foco mudasse — o processo continua sendo dele. Já o filtro por organização
   * é o que impede ler processo de outro tenant sabendo o UUID; que UUID não se
   * adivinha é obscuridade, não autorização.
   *
   * Devolve `null` quando não existe OU é de outra organização — de propósito o
   * mesmo retorno, para o 404 não confirmar a existência do id alheio.
   */
  async processo(id: string, usuario: EscopoUsuario) {
    const processo = await this.prisma.processo.findFirst({
      where: { id, ...escopoProcessos(usuario) },
      select: {
        id: true,
        numeroPrecatorio: true,
        numeroOriginario: true,
        numeroRequisitorio: true,
        vara: true,
        entidadeDevedora: true,
        natureza: true,
        situacao: true,
        valor: true,
        /* Ver a nota da fila: sem fase e sem o valor indicativo, um
           pré-precatório fica indistinguível de um precatório exigível. */
        fase: true,
        valorIndicativo: true,
        dataAutuacao: true,
        exercicio: true,
        fonte: true,
        criadoEm: true,
        editadoEm: true,
        tribunal: { select: { sigla: true, nome: true, esfera: true } },

        // ── Estado do CRM ──
        prioridade: true,
        responsavel: { select: { id: true, nome: true } },
        etiquetas: {
          /* Só as etiquetas do tenant que está olhando: o vocabulário é por org
             (Etiqueta.organizationId), então cliente e time interno etiquetam o
             MESMO processo sem enxergar a etiqueta um do outro. */
          where: { etiqueta: { organizationId: usuario.organizationId } },
          orderBy: { etiqueta: { nome: 'asc' } },
          select: { etiqueta: { select: { id: true, nome: true, cor: true } } },
        },
        tarefas: {
          /* Do tenant que olha. Para a INTERNA é no-op hoje (toda tarefa é dela);
             a partir do primeiro cliente, é o que impede um ver a tarefa do outro
             no mesmo processo liberado. */
          where: { organizationId: usuario.organizationId },
          /* Pendentes primeiro; dentro delas, o prazo mais apertado no topo.
             `nulls: 'last'` é obrigatório: no Postgres, ASC coloca NULL POR
             ÚLTIMO por padrão, mas quem lê o código não deve ter de saber isso
             — e tarefa sem prazo não pode competir com a que vence amanhã. */
          orderBy: [
            { concluidaEm: { sort: 'asc', nulls: 'first' } },
            { prazo: { sort: 'asc', nulls: 'last' } },
            { criadoEm: 'asc' },
          ],
          select: {
            id: true,
            tipo: true,
            titulo: true,
            prazo: true,
            concluidaEm: true,
            criadoEm: true,
            responsavel: { select: { id: true, nome: true } },
            criadoPor: { select: { id: true, nome: true } },
          },
        },
        anotacoes: {
          /* Mesma regra da tarefa: anotação é do tenant que escreveu. */
          where: { organizationId: usuario.organizationId },
          /* Fixadas primeiro, depois a mais recente. É a ordem de leitura de
             quem abre o processo: o aviso que alguém pregou no alto, e então o
             que aconteceu por último. */
          orderBy: [{ fixada: 'desc' }, { criadoEm: 'desc' }],
          select: {
            id: true,
            texto: true,
            fixada: true,
            criadoEm: true,
            editadoEm: true,
            autor: { select: { id: true, nome: true } },
          },
        },
        partes: {
          /* REQUERENTE primeiro: enum do Postgres ordena pela ordem de
             declaração, e é ela que abre PapelProcessual. Nome como desempate
             para a lista não embaralhar entre uma abertura e outra. */
          orderBy: [{ papel: 'asc' }, { pessoa: { nome: 'asc' } }],
          select: {
            papel: true,
            valorIndividual: true,
            observacoes: true,
            pessoa: {
              select: {
                id: true,
                cpf: true,
                nome: true,
                /* Sem `conferenciaNome` — ver a nota da fila. */
                statusEnriquecimento: true,
                ultimaSincronizacao: true,
                dataNascimento: true,
                obito: true,
                /* `ativo: false` é dado que o provider deixou de confirmar.
                   Some da tela, mas continua no banco para a trilha. */
                telefones: {
                  where: { ativo: true },
                  orderBy: { ultimaVez: 'desc' },
                  select: { ddd: true, numero: true, tipo: true, whatsapp: true },
                },
                emails: {
                  where: { ativo: true },
                  orderBy: { ultimaVez: 'desc' },
                  select: { endereco: true },
                },
                enderecos: {
                  where: { ativo: true },
                  orderBy: { ultimaVez: 'desc' },
                  select: {
                    logradouro: true,
                    numero: true,
                    complemento: true,
                    bairro: true,
                    cidade: true,
                    uf: true,
                    cep: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!processo) return null;

    /* Só depois de confirmar o acesso. Buscar a timeline junto com o processo
       leria evento de outro tenant antes de saber se ele pode ver o processo. */
    /* Visibilidade da timeline: o FATO do processo (organizationId NULL) mais o
       que é privado da PRÓPRIA org. O cliente não vê a operação interna, e o time
       interno não vê o que o cliente registrou no overlay dele. */
    const eventoVisivel = {
      processoId: id,
      OR: [{ organizationId: null }, { organizationId: usuario.organizationId }],
    };
    const [eventos, totalEventos] = await Promise.all([
      this.prisma.eventoProcesso.findMany({
        where: eventoVisivel,
        /* `id` como desempate: o backfill do IMPORTADO copiou o `criadoEm` do
           processo, então eventos empatados no mesmo instante existem de fato.
           Sem desempate, a ordem entre eles muda de uma consulta para outra. */
        orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
        take: EVENTOS_POR_PAGINA,
        select: {
          id: true,
          tipo: true,
          descricao: true,
          camposAlterados: true,
          detalhe: true,
          importacaoId: true,
          criadoEm: true,
        },
      }),
      this.prisma.eventoProcesso.count({ where: eventoVisivel }),
    ]);

    const base = {
      ...processo,
      /* Decimal do Prisma não sobrevive ao JSON.stringify com a precisão
         intacta — vira string em toda a API (ver `resumo` e `buscar`). */
      valor: processo.valor?.toString() ?? null,
      valorIndicativo: processo.valorIndicativo?.toString() ?? null,
      /* Achata a tabela de junção: a tela quer etiquetas, não vínculos. */
      etiquetas: processo.etiquetas.map((v) => v.etiqueta),
      partes: processo.partes.map((v) => ({
        ...v,
        valorIndividual: v.valorIndividual?.toString() ?? null,
      })),
      eventos,
      totalEventos,
      /* A página avisa que existe mais histórico do que ela está mostrando, em
         vez de deixar o operador achar que a timeline acaba ali. */
      eventosTruncados: totalEventos > eventos.length,
    };

    /* ── O FUNIL VALE PARA OS DOIS LADOS ──
       Estava dentro da projeção do cliente, e por isso a org INTERNA recebia o
       processo SEM estágio, sem motivo de perda e sem último contato: o bloco de
       funil da página não acendia nenhum botão para o próprio time que mantém a
       base. Não é dualidade — estágio e contato só existem no overlay, para
       todos. Dualidade é só prioridade/responsável, logo abaixo. */
    const overlayDoFunil = await this.prisma.carteiraProcesso.findUnique({
      where: {
        organizationId_processoId: { organizationId: usuario.organizationId, processoId: id },
      },
      select: {
        /* O funil é de QUEM OLHA, e só dele: o mesmo precatório pode estar em
           PROPOSTA para um escritório e NOVO para outro. */
        estagio: true,
        estagioEm: true,
        motivoPerda: true,
        ultimoContatoEm: true,
        prioridade: true,
        responsavel: { select: { id: true, nome: true } },
      },
    });

    const doFunil = {
      /* Sem linha no overlay = NOVO: ninguém tocou neste processo ainda. É o
         estado da maioria da carteira no começo de cada mês. */
      estagio: overlayDoFunil?.estagio ?? ('NOVO' as const),
      estagioEm: overlayDoFunil?.estagioEm ?? null,
      motivoPerda: overlayDoFunil?.motivoPerda ?? null,
      ultimoContatoEm: overlayDoFunil?.ultimoContatoEm ?? null,
    };

    if (!ehEscopoCliente(usuario)) return { ...base, ...doFunil };

    /* ── Projeção do CLIENTE ──
       Para ele a base é PRÓPRIA: nem provedor, nem custo, nem o vocabulário do
       enriquecimento. Três coisas mudam:
        1. prioridade/responsável saem do OVERLAY dele — nunca das colunas do
           Processo, que são a triagem do time interno;
        2. somem `statusEnriquecimento`/`ultimaSincronizacao` das partes (o
           contato ele vê; COMO chegou lá, não);
        3. a timeline vira genérica — ENRIQUECIDO é relabelado e os campos
           técnicos (diff, id de importação) não saem.
       É por REMONTAGEM, não por `delete`: campo novo no select não vaza sozinho
       para o cliente, tem de ser adicionado aqui de propósito. */
    return {
      ...base,
      ...doFunil,
      /* A dualidade, e SÓ ela: prioridade e responsável saem do overlay para o
         cliente e das colunas do Processo para o time interno. */
      prioridade: overlayDoFunil?.prioridade ?? 'NORMAL',
      responsavel: overlayDoFunil?.responsavel ?? null,
      partes: base.partes.map((p) => ({
        papel: p.papel,
        valorIndividual: p.valorIndividual,
        observacoes: p.observacoes,
        pessoa: {
          id: p.pessoa.id,
          cpf: p.pessoa.cpf,
          nome: p.pessoa.nome,
          /* ⚠ O VEREDITO DO CPF NÃO ATRAVESSA MAIS — saiu em 20/09/2026.
             Até 11/09 ele atravessava de propósito, com o argumento de que quem
             liga é o cliente e esconder dele que o documento pode ser de outro
             credor seria guardar a informação que o protege. O dono decidiu
             diferente: o aviso saiu de TODAS as telas e o campo saiu da
             resposta. O que o aviso pedia virou regra — divergente não é
             sorteado, e pré-precatório sem conferência também não —, então o
             cliente não recebe mais o caso que o aviso existia para sinalizar. */
          dataNascimento: p.pessoa.dataNascimento,
          obito: p.pessoa.obito,
          telefones: p.pessoa.telefones,
          emails: p.pessoa.emails,
          enderecos: p.pessoa.enderecos,
        },
      })),
      eventos: eventos.map((e) => ({
        id: e.id,
        tipo: e.tipo === 'ENRIQUECIDO' ? 'DADO_ATUALIZADO' : e.tipo,
        descricao: e.tipo === 'ENRIQUECIDO' ? 'Dados atualizados' : e.descricao,
        criadoEm: e.criadoEm,
      })),
    };
  }

  private normalizar(s: string): string {
    return s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  }
}
