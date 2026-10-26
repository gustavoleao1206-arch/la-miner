import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type FaseProcesso } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { escopoGlobal } from '../../prisma/sentinela-escopo';

/**
 * ── QUEM PEDIU EXCLUSÃO SAI DE CIRCULAÇÃO (LGPD art. 18) ──
 *
 * O processo cujo titular pediu exclusão deixa de ser distribuível. Antes disto,
 * `TitularService.excluir` apagava telefone, e-mail, endereço e todo o texto
 * livre do CRM — e o sorteio da madrugada seguinte continuava entregando o
 * precatório da mesma pessoa a escritórios NOVOS, com nome, CPF, número do
 * requisitório e valor. A exclusão retirava o contato e AMPLIAVA a exposição,
 * porque cada liberação nova é mais um controlador recebendo o dado de quem já
 * disse que não queria.
 *
 * Eliminar de vez não cabe aqui, e o próprio `TitularService` explica por quê:
 * CPF e nome vêm do precatório, que é ato público do tribunal. Quando a
 * eliminação não cabe, o que resta devido é o BLOQUEIO — parar de tratar.
 *
 * ── POR QUE UMA CONSTANTE, E NÃO A CONDIÇÃO REPETIDA ──
 *
 * São QUATRO lugares que escolhem ou contam processo distribuível: o sorteio
 * (SQL cru), os irmãos do titular, o "quanto ainda resta" do `gerarLote` e o
 * fôlego da tela de clientes. Repetir a condição em quatro lugares é garantir
 * que o quinto nasça sem ela. Aqui a regra mora num lugar só, e o SQL cru logo
 * abaixo carrega a MESMA condição escrita à mão — é a única cópia, e está
 * marcada.
 *
 * `none` é verdadeiro para processo SEM parte cadastrada, e isso é o certo:
 * processo sem titular identificado não tem quem tenha pedido exclusão.
 */
/** Quem entra no fôlego: assinatura viva, de qualquer cliente. */
const FILTRO_DO_FOLEGO: Prisma.AssinaturaWhereInput = {
  status: { in: ['ATIVA', 'INADIMPLENTE'] },
};

/**
 * AS FASES QUE PODEM SER SORTEADAS — lista de PERMISSÃO, nunca de exclusão.
 *
 * ── POR QUE UMA LISTA EXPLÍCITA, SE HOJE ELA TEM TUDO ──
 *
 * Decisão do dono em 04/09/2026: pré-precatório entra no sorteio dos 250, como
 * estágio anterior do mesmo funil. Então hoje esta lista é o enum inteiro, e o
 * filtro não recusa nada.
 *
 * O valor não está no que ela filtra agora; está em COMO ela erra. Escrita como
 * lista de exclusão — "tudo, menos TRANSITO_EM_JULGADO" —, uma fase nova
 * acrescentada ao enum entraria no sorteio sozinha, e a primeira notícia disso
 * seria um cliente recebendo algo que ninguém decidiu vender. Como lista de
 * permissão, fase nova nasce FORA e alguém precisa vir aqui e assumir a escolha.
 *
 * ── E É AQUI QUE SE ESTREITA, SE FOR O CASO ──
 *
 * As duas primeiras fases são as mais distantes de virar dinheiro: em
 * `TRANSITO_EM_JULGADO` não há sequer valor apurado. Se um dia a decisão for
 * entregar só o que já tem requisitório, é uma linha — tirar as duas daqui — e o
 * teste que fixa esta lista falha, obrigando quem mexeu a confirmar que quis.
 */
export const FASES_DISTRIBUIVEIS = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
  'PRECATORIO_EXPEDIDO',
] as const satisfies readonly FaseProcesso[];

const PROCESSO_DISTRIBUIVEL: Prisma.ProcessoWhereInput = {
  organization: { tipo: 'INTERNA' },
  /* Duas razões para tirar um processo de circulação, no MESMO `none` de
     propósito: uma segunda chave `partes` sobrescreveria a primeira em silêncio,
     e a que sumiria seria a da LGPD. Por isso o `OR` mora dentro.

     ── POR QUE `DIVERGE` BLOQUEIA ──

     Nos pré-precatórios o CPF é extraído de TEXTO. Dígito verificador válido
     prova que o número é bem formado, não que seja daquele credor — e o
     enriquecimento, ao comparar o nome da planilha com o do titular real,
     marcou 239 dos 1.169 como `DIVERGE`. Distribuí-los é entregar ao cliente
     uma pessoa que não tem relação com o processo: ele liga para um estranho,
     e o estranho recebeu tratamento de dado que ninguém justificou.

     ⚠ NUNCA inverter isto para "só distribuir CONFERE". A comparação de nome
     nasceu com os pré-precatórios e só roda no enriquecimento; a carteira dos
     TRFs foi enriquecida antes dela existir e está INTEIRA em `NAO_CONFERIDO`
     (medido em 08/09/2026: 1.925 de amostra, zero conferidos). Lista de
     permissão tiraria os 12.425 precatórios do sorteio e entregaria lote vazio.
     Aqui é lista de negação, e é essa a diferença. */
  partes: {
    none: {
      pessoa: { OR: [{ exclusaoEm: { not: null } }, { conferenciaNome: 'DIVERGE' }] },
    },
  },
  /* ── PRÉ-PRECATÓRIO SEM CONFERÊNCIA TAMBÉM FICA ──

     Decisão do dono em 20/09/2026, depois de medir os radares de 16 e 17/09:
     quando o radar acha o CPF pelo método "rotulado CPF, credor único", 61% dos
     que dá para conferir são de OUTRA pessoa. E há casos em que nem dá para
     conferir — o TRT3 publica só o prenome do credor, e 283 processos ficaram
     `NAO_CONFERIDO` para sempre. Como `NAO_CONFERIDO` era distribuível, eles
     iam ao assinante com a mesma chance de estar errados.

     A regra: fora de `PRECATORIO_EXPEDIDO` o CPF vem de TEXTO, então "não
     conferido" quer dizer "ninguém verificou" — e não vai. Em
     `PRECATORIO_EXPEDIDO` o CPF vem de campo oficial do tribunal e a base
     inteira é `NAO_CONFERIDO` por história, não por dúvida: continua indo. É o
     `OR` na fase que mantém o aviso de cima ("NUNCA inverter") de pé.

     Mora num `AND` e não numa segunda chave `partes`, que sobrescreveria a de
     cima em silêncio. E não é retroativa: o que já foi liberado continua com
     quem recebeu.

     Efeito colateral conhecido e pequeno: `Pessoa` é global por CPF. Quem já
     estava na base dos TRFs (enriquecido antes de a conferência existir) e
     aparece num pré-precatório novo não é reenfileirado, fica `NAO_CONFERIDO` e
     segura aquele pré-precatório. É o lado certo do erro — o CPF dele não foi
     verificado contra AQUELE nome. */
  AND: [
    {
      OR: [
        { fase: 'PRECATORIO_EXPEDIDO' },
        { partes: { none: { pessoa: { conferenciaNome: 'NAO_CONFERIDO' } } } },
      ],
    },
  ],
  /* ⚠ Tem GÊMEO À MÃO no SQL cru de `sortear()`. O Prisma não compõe
     `WhereInput` dentro de `$queryRaw`, então as duas cópias precisam dizer a
     mesma coisa — e há teste conferindo que dizem. */
  fase: { in: [...FASES_DISTRIBUIVEIS] },
  /* ── MARCADO PARA FICAR FORA ──

     Decisão do dono em 03/10/2026: a reavaliação dos radares de 16–30/09 achou
     1.050 processos cujo devedor não é a Fazenda. Ficam na base (apagar não tem
     volta) e saem do sorteio. Nulo = distribuível; o motivo mora no enum. Não é
     retroativo: o que já foi liberado continua com quem recebeu. */
  foraDaDistribuicao: null,
};

/** O que uma geração de ciclo devolve — igual no dry-run e na execução. */
export interface ResultadoLote {
  gerado: boolean;
  /** Por que NÃO gerou, quando `gerado` é falso. */
  motivo?: string;
  dryRun: boolean;
  /** Competência do ciclo, em AAAA-MM-DD (é um DIA, não um instante). */
  competencia: string;
  /** Quantos o plano pedia. */
  alvo: number;
  /**
   * Quantos foram (ou seriam) liberados. NUNCA passa do alvo — os irmãos entram
   * dentro da cota. Pode vir MENOS quando a base esgota, ou quando o que sobrou
   * são grupos de requerente grandes demais para o que faltava fechar.
   */
  liberados: number;
  /** Quantos dos liberados entraram só por serem do mesmo requerente. */
  irmaosIncluidos: number;
  /** Quantos ainda restam na base para ciclos futuros. */
  restantesNaBase: number;
  loteId?: string;
}

@Injectable()
export class DistribuicaoService {
  private readonly logger = new Logger(DistribuicaoService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Primeiro dia do mês, em UTC.
   *
   * Competência é MÊS, não instante: gerar o lote às 23h de 31/07 no fuso de
   * Recife não pode cair na competência de agosto. Fixar em UTC deixa a chave de
   * idempotência (assinatura + competência) estável em qualquer servidor.
   */
  private competenciaDe(data: Date): Date {
    return new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), 1));
  }

  private somarMeses(data: Date, meses: number): Date {
    return new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + meses, 1));
  }

  /** Quantas rodadas de sorteio antes de desistir de fechar a cota. */
  private static readonly RODADAS_MAX = 6;

  /**
   * Escolhe os processos do ciclo: SORTEIO, com os irmãos cabendo dentro da cota.
   *
   * ── POR QUE ALEATÓRIO, E NÃO "OS DE MAIOR VALOR" ──
   *
   * Era essa a régua antes, e ela tinha uma consequência que só aparece com
   * vários clientes: sem exclusividade, todo mundo saca do mesmo poço — e
   * ordenados por valor, TODOS receberiam exatamente os mesmos processos, na
   * mesma ordem, mês a mês. Cinquenta escritórios ligando para os mesmos
   * titulares na mesma semana. O sorteio é o que espalha a carteira.
   *
   * ── OS IRMÃOS ENTRAM NA COTA, NÃO EM CIMA DELA ──
   *
   * PROCESSOS-IRMÃOS são os outros precatórios do mesmo requerente. Eles vêm
   * junto porque entregar metade dos processos de uma pessoa é entregar contexto
   * pela metade: o cliente ligaria para o titular achando que ele tem a receber
   * X, quando tem 3X — e a chance de fechar com aquela pessoa passa uma vez só.
   *
   * Antes eles eram somados DEPOIS do alvo, e o lote de 250 saía com 302. A
   * assinatura promete 250; o número na tela do cliente tem de ser esse. Aqui a
   * cota é fechada CONTANDO os irmãos: sorteia-se um titular por vez e leva-se
   * o grupo inteiro dele, enquanto couber.
   *
   * O grupo que NÃO cabe é pulado, não partido — a não ser que nada tenha sido
   * escolhido ainda, caso em que ele entra inteiro mesmo estourando. Sem essa
   * exceção, um requerente com mais processos que a cota nunca seria entregue a
   * ninguém, e ficaria preso na base para sempre.
   */
  private async selecionar(organizationId: string, alvo: number) {
    const escolhidos = new Set<string>();
    /* Quantos entraram por parentesco, e não por sorteio direto. Serve ao
       relatório do lote — é o número que explica por que um mês trouxe menos
       titulares distintos que o outro. */
    let porParentesco = 0;

    for (let rodada = 0; rodada < DistribuicaoService.RODADAS_MAX; rodada++) {
      if (escolhidos.size >= alvo) break;

      const faltam = alvo - escolhidos.size;
      /* Sorteia com folga: parte dos candidatos vai cair em titulares que já
         entraram (viraram irmãos de alguém), e parte em grupos que não cabem. */
      const candidatos = await this.sortear(organizationId, [...escolhidos], faltam * 2 + 10);
      if (candidatos.length === 0) break;

      const grupos = await this.gruposDosTitulares(organizationId, candidatos);

      for (const candidato of candidatos) {
        if (escolhidos.size >= alvo) break;

        /* Sem titular cadastrado, o processo é grupo de um. Acontece com linha
           que entrou sem CPF válido — e deixá-lo fora da distribuição para
           sempre seria pior que entregá-lo sozinho. */
        const grupo = grupos.get(candidato) ?? [candidato];
        const novos = grupo.filter((id) => !escolhidos.has(id));
        if (novos.length === 0) continue;

        if (escolhidos.size + novos.length > alvo && escolhidos.size > 0) continue;

        porParentesco += novos.length - 1;
        for (const id of novos) escolhidos.add(id);
      }
    }

    return { escolhidos: [...escolhidos], porParentesco };
  }

  /**
   * Uma amostra ALEATÓRIA da base ainda não liberada a esta org.
   *
   * SQL cru por causa do `random()`: o Prisma não tem ordenação aleatória, e as
   * alternativas em JavaScript — ler tudo e embaralhar, ou sortear deslocamentos
   * — ou carregam a base inteira na memória, ou distribuem mal quando há buracos
   * na numeração.
   *
   * `NOT EXISTS` é a regra "nunca reenviar o mesmo processo ao mesmo cliente",
   * a mesma que o @@unique(organizationId, processoId) garante no fim. E ela
   * olha SÓ esta organização, de propósito: não há exclusividade entre clientes,
   * então o processo que saiu para um continua disponível para os outros.
   */
  private async sortear(organizationId: string, jaEscolhidos: string[], quantos: number) {
    const linhas = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id
      FROM processos p
      JOIN organizations o ON o.id = p."organizationId" AND o.tipo = 'INTERNA'
      WHERE NOT EXISTS (
              SELECT 1 FROM processos_liberados l
              WHERE l."processoId" = p.id AND l."organizationId" = ${organizationId}::uuid
            )
        /* A cópia à mão de PROCESSO_DISTRIBUIVEL — o Prisma não compõe
           WhereInput dentro de $queryRaw.

           Duas razões na mesma lista, espelhando o OR de lá (sem crase aqui: o
           comentário vive dentro do template literal): titular que pediu
           exclusão e CPF que a conferência de nome disse não ser daquela
           pessoa. O cast para text no enum segue o mesmo motivo da fase logo
           abaixo — não depender do nome do tipo no Postgres.

           ── POR QUE NOT IN E NÃO NOT EXISTS (05/10/2026) ──

           Era NOT EXISTS correlacionado, e com a base em ~20 mil pessoas o
           sorteio passou a estourar o statement timeout (erro 500 no Simular
           lote). O cast para text tira do planejador a estatística do enum: ele
           estimava 100 pessoas bloqueadas quando eram milhares, escolhia laço
           aninhado e varria a tabela de pessoas INTEIRA para cada processo —
           mais de 90 s medidos em produção. NOT IN sobre subconsulta sem
           correlação vira hashed SubPlan: a lista é montada UMA vez e cada
           processo é uma consulta de hash. Medido em produção: mesma contagem
           (17.034) em poucos segundos. Sem risco do NOT IN com nulo:
           processoId é chave e nunca é nulo. */
        AND p.id NOT IN (
              SELECT pp."processoId" FROM processo_pessoas pp
              JOIN pessoas pe ON pe.id = pp."pessoaId"
              WHERE pe."exclusaoEm" IS NOT NULL OR pe."conferenciaNome"::text = 'DIVERGE'
            )
        /* O gemeo do AND de PROCESSO_DISTRIBUIVEL: fora de PRECATORIO_EXPEDIDO o
           CPF vem de texto, e titular NAO_CONFERIDO segura o processo. No
           expedido nao segura — a base dos TRFs inteira esta nesse estado.
           NOT IN pelo mesmo motivo do bloco de cima. */
        AND (
              p.fase::text = 'PRECATORIO_EXPEDIDO'
              OR p.id NOT IN (
                SELECT pp2."processoId" FROM processo_pessoas pp2
                JOIN pessoas pe2 ON pe2.id = pp2."pessoaId"
                WHERE pe2."conferenciaNome"::text = 'NAO_CONFERIDO'
              )
            )
        /* A fase, mesma lista do PROCESSO_DISTRIBUIVEL. O cast para text no lado
           do enum evita depender do nome do tipo no Postgres, como no cron de
           retenção. Esquecer esta linha numa mudança futura faria o sorteio
           entregar fase que o Prisma recusaria — a divergência que o teste do
           gêmeo existe para pegar.
           (Sem crase neste comentário: ele vive DENTRO de um template literal, e
           uma crase aqui encerra a string — já aconteceu no ambiente.ts.) */
        AND p.fase::text = ANY(${[...FASES_DISTRIBUIVEIS]}::text[])
        /* O gemeo de foraDaDistribuicao nulo: processo marcado fica na base e
           fora do sorteio (devedor que nao e Fazenda, decisao de 03/10/2026). */
        AND p."foraDaDistribuicao" IS NULL
        AND NOT (p.id = ANY(${jaEscolhidos}::uuid[]))
      ORDER BY random()
      LIMIT ${quantos}`;
    return linhas.map((l) => l.id);
  }

  /**
   * Para cada candidato, TODOS os processos ainda elegíveis do titular dele.
   *
   * Em duas consultas para o lote inteiro, e não uma por candidato: com cota de
   * 250 seriam 250 idas ao banco por ciclo, e o cron roda para todos os clientes
   * na mesma madrugada.
   */
  private async gruposDosTitulares(organizationId: string, candidatos: string[]) {
    const partes = await this.prisma.processoPessoa.findMany({
      where: { processoId: { in: candidatos } },
      select: { processoId: true, pessoaId: true },
    });
    if (partes.length === 0) return new Map<string, string[]>();

    /* O PRIMEIRO titular decide o grupo. Processo com vários requerentes é raro
       aqui, e puxar a união de todos eles encadearia grupos enormes — um
       processo com duas pessoas traria os processos das duas, que trariam os de
       seus co-titulares, e assim por diante. */
    const titularDe = new Map<string, string>();
    for (const p of partes) if (!titularDe.has(p.processoId)) titularDe.set(p.processoId, p.pessoaId);

    const pessoaIds = [...new Set(titularDe.values())];
    const doTitular = await this.prisma.processo.findMany({
      /* `AND` em vez de espalhar a constante: ela já traz um filtro de `partes`
         (o titular excluído) e aqui há outro (as partes do candidato). Espalhar
         faria um sobrescrever o outro em silêncio — e o que sumiria seria
         justamente a trava da LGPD. */
      where: {
        AND: [
          PROCESSO_DISTRIBUIVEL,
          {
            liberacoes: { none: { organizationId } },
            partes: { some: { pessoaId: { in: pessoaIds } } },
          },
        ],
      },
      select: { id: true, partes: { select: { pessoaId: true }, take: 1 } },
    });

    const porPessoa = new Map<string, string[]>();
    for (const p of doTitular) {
      const pessoaId = p.partes[0]?.pessoaId;
      if (!pessoaId) continue;
      const lista = porPessoa.get(pessoaId) ?? [];
      lista.push(p.id);
      porPessoa.set(pessoaId, lista);
    }

    const grupos = new Map<string, string[]>();
    for (const candidato of candidatos) {
      const pessoaId = titularDe.get(candidato);
      if (!pessoaId) continue;
      const grupo = porPessoa.get(pessoaId) ?? [candidato];
      /* O próprio candidato pode não estar na lista do titular quando o
         `take: 1` das partes escolheu outra pessoa para ele. Garante-se aqui. */
      grupos.set(candidato, grupo.includes(candidato) ? grupo : [candidato, ...grupo]);
    }
    return grupos;
  }

  /**
   * Gera (ou simula) o lote de um ciclo para uma org CLIENTE.
   *
   * IDEMPOTENTE por (assinatura, competência): rodar o cron duas vezes no mesmo
   * mês não gera lote duplicado nem libera processo a mais. É o que torna seguro
   * o cron rodar todo dia procurando quem venceu.
   */
  async gerarLote(params: {
    organizationId: string;
    competencia?: Date;
    dryRun?: boolean;
  }): Promise<ResultadoLote> {
    const { organizationId, dryRun = false } = params;
    const competencia = this.competenciaDe(params.competencia ?? new Date());
    const iso = competencia.toISOString().slice(0, 10);

    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId },
      select: {
        id: true,
        status: true,
        inicioEm: true,
        plano: { select: { processosPorCiclo: true, intervaloMeses: true } },
      },
    });
    if (!assinatura) throw new NotFoundException('Esta organização não tem assinatura.');

    /**
     * ── A COMPETÊNCIA PRECISA ESTAR DENTRO DA VIDA DA ASSINATURA ──
     *
     * `competencia` vem de quem chama, e existe para regerar um mês específico
     * numa correção operacional. Sem cerca, ela vira uma torneira: cada
     * competência tem o próprio lote e a própria checagem de duplicidade, então
     * doze chamadas com doze meses FUTUROS liberam doze cotas de uma vez — cada
     * uma passando por todas as travas existentes, porque nenhuma delas olha a
     * data. Um ano de carteira entregue num dia, sem nada parecer errado.
     *
     * O mesmo vale para trás: gerar o mês de janeiro para quem assinou em junho
     * entrega uma cota de um ciclo que nunca existiu.
     *
     * As duas cercas são a mesma ideia — lote pertence a um ciclo que EXISTIU.
     */
    const competenciaAtual = this.competenciaDe(new Date());
    if (competencia > competenciaAtual) {
      throw new BadRequestException(
        `Competência ${iso} está no futuro. O lote de um ciclo só pode ser gerado quando ele chega — ` +
          'antecipar entrega cota que o cliente ainda não pagou.',
      );
    }

    const primeiraCompetencia = this.competenciaDe(assinatura.inicioEm);
    if (competencia < primeiraCompetencia) {
      throw new BadRequestException(
        `Competência ${iso} é anterior ao início da assinatura ` +
          `(${primeiraCompetencia.toISOString().slice(0, 10)}). Não existe ciclo a distribuir aí.`,
      );
    }

    const alvo = assinatura.plano.processosPorCiclo;
    const restantesNaBase = await this.prisma.processo.count({
      where: { ...PROCESSO_DISTRIBUIVEL, liberacoes: { none: { organizationId } } },
    });
    const vazio = { dryRun, competencia: iso, alvo, liberados: 0, irmaosIncluidos: 0, restantesNaBase };

    /* Só assinatura ATIVA recebe lote. SUSPENSA/INADIMPLENTE mantém o que já tem
       (o cliente não perde a carteira), mas para de crescer — é a alavanca
       comercial da inadimplência, e ela mora aqui, não no gateway. */
    if (assinatura.status !== 'ATIVA') {
      return { ...vazio, gerado: false, motivo: `assinatura ${assinatura.status}` };
    }

    const existente = await this.prisma.loteAssinatura.findUnique({
      where: { assinaturaId_competencia: { assinaturaId: assinatura.id, competencia } },
      select: { id: true, quantidadeLiberada: true },
    });
    if (existente) {
      return {
        ...vazio,
        gerado: false,
        motivo: 'lote desta competência já foi gerado',
        liberados: existente.quantidadeLiberada,
        loteId: existente.id,
      };
    }

    const { escolhidos: todos, porParentesco } = await this.selecionar(organizationId, alvo);

    if (todos.length === 0) {
      return { ...vazio, gerado: false, motivo: 'a base não tem processo novo para esta carteira' };
    }

    if (dryRun) {
      return {
        ...vazio,
        gerado: false,
        motivo: 'simulação',
        liberados: todos.length,
        irmaosIncluidos: porParentesco,
      };
    }

    /* Tudo numa transação: lote sem liberações, ou liberações sem lote, deixariam
       o histórico de distribuição mentindo sobre o que o cliente recebeu. */
    let gravado: { loteId: string; count: number };
    try {
      gravado = await this.gravarLote(assinatura.id, organizationId, competencia, alvo, todos);
    } catch (e) {
      /**
       * Duas execuções simultâneas para a mesma competência.
       *
       * A checagem de `existente` lá em cima é um READ fora da transação: duas
       * chamadas concorrentes passam as duas por ela. Quem chega depois esbarra
       * no @@unique(assinaturaId, competencia) — que é a defesa REAL, e ela
       * funcionou: nenhuma cota dobrada, nenhuma liberação a mais.
       *
       * O que estava errado era a APRESENTAÇÃO: o P2002 subia como 500, e um
       * 500 diz "o servidor quebrou" quando o que houve foi "esse lote já
       * existe" — exatamente o que a rota responde quando a corrida não
       * acontece. O cron tem retry; um 500 aqui viraria alarme falso.
       */
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const concorrente = await this.prisma.loteAssinatura.findUnique({
          where: { assinaturaId_competencia: { assinaturaId: assinatura.id, competencia } },
          select: { id: true, quantidadeLiberada: true },
        });
        this.logger.warn(
          `Geração concorrente do lote ${iso} para org ${organizationId}: ` +
            'a segunda execução foi barrada pelo índice único, como projetado.',
        );
        return {
          ...vazio,
          gerado: false,
          motivo: 'lote desta competência já foi gerado',
          liberados: concorrente?.quantidadeLiberada ?? 0,
          ...(concorrente ? { loteId: concorrente.id } : {}),
        };
      }
      throw e;
    }

    this.logger.log(
      `Lote ${iso} para org ${organizationId}: ${gravado.count} liberados ` +
        `(alvo ${alvo}, ${porParentesco} por parentesco de requerente)`,
    );

    return {
      gerado: true,
      dryRun: false,
      competencia: iso,
      alvo,
      liberados: gravado.count,
      irmaosIncluidos: porParentesco,
      restantesNaBase: restantesNaBase - gravado.count,
      loteId: gravado.loteId,
    };
  }

  /**
   * A gravação do lote, numa transação só.
   *
   * Extraída do `gerarLote` para que o `try/catch` de geração concorrente
   * envolva a transação INTEIRA. Com o `catch` em volta de um bloco inline, o
   * P2002 do `create` do lote continuaria abortando a transação — mas o
   * tratamento ficaria misturado com o fluxo normal, e o próximo a mexer aqui
   * teria de reconstruir o raciocínio.
   */
  private async gravarLote(
    assinaturaId: string,
    organizationId: string,
    competencia: Date,
    alvo: number,
    processos: string[],
  ): Promise<{ loteId: string; count: number }> {
    return this.prisma.$transaction(async (tx) => {
      const lote = await tx.loteAssinatura.create({
        data: { assinaturaId, competencia, quantidadeAlvo: alvo },
        select: { id: true },
      });
      /* skipDuplicates cobre a corrida com uma execução simultânea: o
         @@unique(organizationId, processoId) é a defesa final da regra "nunca
         reenviar", e aqui ela não vira erro 500 — vira uma linha a menos. */
      const { count } = await tx.processoLiberado.createMany({
        data: processos.map((processoId) => ({ organizationId, processoId, loteId: lote.id })),
        skipDuplicates: true,
      });
      await tx.loteAssinatura.update({
        where: { id: lote.id },
        data: { quantidadeLiberada: count },
      });
      /* O ciclo anda mesmo quando a geração foi manual — senão o cron geraria de
         novo no dia seguinte, e a competência seguinte chegaria adiantada.

         ⚠ SEMPRE +1 MÊS, e NUNCA `plano.intervaloMeses`. Aquele campo é o ciclo
         de COBRANÇA (1 = mensal, 12 = anual), e a ENTREGA é mensal por definição
         do produto: o plano anual paga UMA vez e recebe 250 processos TODO MÊS.
         A versão anterior somava o intervalo do plano aqui — num anual, o
         `proximaRenovacaoEm` nascia 12 meses à frente, o cron pulava o cliente
         por 11 meses, e quem pagou o ano inteiro receberia UMA entrega. Quem
         cala a cobrança durante o período pago é `Assinatura.pagoAte`, do outro
         lado — as duas cadências são independentes de propósito. */
      await tx.assinatura.update({
        where: { id: assinaturaId },
        data: {
          proximaRenovacaoEm: this.somarMeses(competencia, 1),
        },
      });
      return { loteId: lote.id, count };
    });
  }

  /**
   * A partir de quantos ciclos restantes o cliente vira alerta.
   *
   * Três meses é o prazo para AGIR: importar uma carteira nova de um tribunal
   * leva reunião, planilha e conferência. Avisar com um mês seria avisar tarde;
   * com seis, o alerta ficaria aceso o ano inteiro e o olho aprenderia a pulá-lo.
   */
  private static readonly CICLOS_DE_AVISO = 3;

  /**
   * Quanto de base ainda resta para cada cliente — o fôlego da assinatura.
   *
   * ── POR QUE ISTO PRECISA EXISTIR ──
   *
   * A base é finita e o cliente paga todo mês. Quando o poço dele seca, o motor
   * devolve "a base não tem processo novo para esta carteira" e segue em frente:
   * a assinatura continua ATIVA, a fatura continua saindo, e o cliente passa a
   * pagar sem receber. Nada no sistema gritava — a única pista era uma linha de
   * log numa rodada de cron das quatro da manhã.
   *
   * ── A CONTA É SUBTRAÇÃO, NÃO CONSULTA CARA ──
   *
   * Como não há exclusividade, todo processo da base interna é elegível para
   * todo cliente até que ELE o receba. Então "quantos restam para este cliente"
   * é `total da base − o que ele já recebeu`. Duas consultas para todos os
   * clientes de uma vez, em vez de uma varredura por cliente.
   */
  async folego() {
    /* O fôlego mede o poço REAL: processo de titular excluído não vai sair para
       ninguém, então contá-lo aqui prometeria ciclos que não existem e adiaria
       o alerta de base esgotada. */
    const naBase = await this.prisma.processo.count(
      /* A base é da org INTERNA, que é UMA só e se identifica por `tipo` — não
         por `organizationId`. O fôlego mede esse poço inteiro, e recortá-lo por
         cliente responderia outra pergunta. */
      escopoGlobal('folego: mede a base da org INTERNA, que se identifica por tipo e nao por id', {
        where: PROCESSO_DISTRIBUIVEL,
      }),
    );

    const assinaturas = await this.prisma.assinatura.findMany(
      /* O fôlego é o relatório do painel ADMIN sobre TODOS os clientes na mesma
         tela: a pergunta é "de quem está acabando a base?", e ela não existe
         recortada por um cliente. */
      escopoGlobal('folego: relatorio do painel ADMIN sobre todos os clientes na mesma tela', {
        /* `where` tipado À PARTE, e não genérico explícito na chamada: fixar o
           genérico apagaria a inferência do `select`, e `a.plano`/`a.organization`
           sumiriam do tipo do resultado. Assim o enum fica correto e o select
           continua ditando o retorno. */
        where: FILTRO_DO_FOLEGO,
        select: {
          status: true,
          organizationId: true,
          organization: { select: { nome: true } },
          plano: { select: { processosPorCiclo: true } },
        },
      }),
    );
    if (assinaturas.length === 0) return { naBase, clientes: [], emAlerta: 0 };

    const recebidos = await this.prisma.processoLiberado.groupBy({
      by: ['organizationId'],
      where: { organizationId: { in: assinaturas.map((a) => a.organizationId) } },
      _count: { _all: true },
    });
    const jaRecebeuPor = new Map(recebidos.map((r) => [r.organizationId, r._count._all]));

    const clientes = assinaturas.map((a) => {
      const jaRecebeu = jaRecebeuPor.get(a.organizationId) ?? 0;
      const restantesNaBase = Math.max(0, naBase - jaRecebeu);
      const alvoPorCiclo = a.plano.processosPorCiclo;
      const ciclosRestantes = alvoPorCiclo > 0 ? Math.floor(restantesNaBase / alvoPorCiclo) : 0;

      /* Quatro situações, e a distinção importa para o que se faz com cada uma:
         ESGOTADA já está cobrando sem entregar HOJE; ULTIMO_CICLO entrega
         incompleto no próximo mês; PERTO_DO_FIM ainda dá tempo de importar. */
      const situacao =
        restantesNaBase === 0
          ? ('ESGOTADA' as const)
          : restantesNaBase < alvoPorCiclo
            ? ('ULTIMO_CICLO' as const)
            : ciclosRestantes <= DistribuicaoService.CICLOS_DE_AVISO
              ? ('PERTO_DO_FIM' as const)
              : ('OK' as const);

      return {
        organizationId: a.organizationId,
        nome: a.organization.nome,
        status: a.status,
        alvoPorCiclo,
        jaRecebeu,
        restantesNaBase,
        ciclosRestantes,
        situacao,
      };
    });

    /* Só ATIVA conta para o ALERTA. O inadimplente aparece na lista — a tela de
       clientes mostra o fôlego dele —, mas não acende alarme: ele não recebe
       lote enquanto não regularizar, então a base dele acabar não é problema de
       ninguém hoje. Suspensa e cancelada nem entram na consulta, pelo mesmo
       motivo levado ao limite. */
    const emAlerta = clientes.filter((c) => c.status === 'ATIVA' && c.situacao !== 'OK').length;

    return { naBase, clientes, emAlerta };
  }

  /** Histórico de ciclos de um cliente — o "Histórico de Distribuição" do pedido. */
  async lotes(organizationId: string) {
    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    if (!assinatura) throw new NotFoundException('Esta organização não tem assinatura.');

    return this.prisma.loteAssinatura.findMany({
      where: { assinaturaId: assinatura.id },
      orderBy: { competencia: 'desc' },
      select: {
        id: true,
        competencia: true,
        quantidadeAlvo: true,
        quantidadeLiberada: true,
        criadoEm: true,
      },
    });
  }
}
