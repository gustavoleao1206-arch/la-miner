import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { FILA_ENRIQUECIMENTO, FILA_IMPORTACAO, STATUS_A_ENRIQUECER } from './fila.constants';
import type { JobEnriquecerCpf } from './enriquecimento.processor';

/**
 * O job de importação carrega SÓ o id.
 *
 * Tudo o mais — destino, perfil, linhas — o worker relê do banco. A alternativa
 * seria empacotar a planilha inteira no Redis, que além de cara guardaria dado
 * pessoal (CPF e nome) fora do Postgres, onde a exclusão do titular do B9 não
 * alcança. E payload gordo envelhece: uma retentativa depois de um deploy
 * rodaria com a forma antiga do dado.
 */
export interface JobImportarPlanilha {
  importacaoId: string;
}

/**
 * Quanto se espera uma operação de fila antes de desistir.
 *
 * ── POR QUE ISTO PRECISA EXISTIR ──
 *
 * Com `maxRetriesPerRequest: null` — que o BullMQ EXIGE, senão o worker morre
 * na primeira queda de rede — o ioredis nunca desiste. Medido com o Redis
 * inalcançável: `getJobCounts` e `add` não rejeitam em 15 segundos. Não
 * rejeitam nunca.
 *
 * O efeito não é a rota falhar; é a rota FICAR PENDURADA. O painel consulta
 * `/fila/estado` em ciclo, e cada consulta vira uma requisição presa segurando
 * conexão e memória. Redis fora não derrubava a API — estrangulava devagar, e
 * o log não dizia uma palavra.
 *
 * `try/catch` sozinho não resolveria: não há o que capturar de uma promessa que
 * não se resolve. O teto é o que transforma "pendurado" em "falhou", e falha é
 * coisa que se trata.
 */
const TETO_MS = 3_000;

/** Lançada quando o Redis não responde no prazo. */
export class FilaIndisponivelError extends Error {
  constructor(operacao: string) {
    super(`A fila não respondeu em ${TETO_MS}ms (${operacao}). Redis provavelmente está fora.`);
    this.name = 'FilaIndisponivelError';
  }
}

@Injectable()
export class FilaService {
  private readonly logger = new Logger(FilaService.name);
  /** Evita repetir o mesmo aviso a cada consulta do painel. */
  private avisouIndisponivel = false;

  constructor(
    @InjectQueue(FILA_ENRIQUECIMENTO) private readonly fila: Queue<JobEnriquecerCpf>,
    @InjectQueue(FILA_IMPORTACAO) private readonly filaImportacao: Queue<JobImportarPlanilha>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Roda a operação com teto de tempo.
   *
   * O `finally` limpa o temporizador: sem isso, uma operação que responde
   * rápido deixaria um timer pendurado por 3s segurando o event loop — o
   * processo demoraria a encerrar, e num teste isso vira "jest não termina".
   */
  private async comTeto<T>(operacao: string, fn: () => Promise<T>): Promise<T> {
    let temporizador: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, rejeitar) => {
          temporizador = setTimeout(() => rejeitar(new FilaIndisponivelError(operacao)), TETO_MS);
        }),
      ]);
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  /** Um aviso por queda, e um por volta — em vez de um por requisição. */
  private registrarIndisponibilidade(e: unknown) {
    if (e instanceof FilaIndisponivelError && !this.avisouIndisponivel) {
      this.avisouIndisponivel = true;
      this.logger.error(
        'FILA INDISPONÍVEL: o Redis não está respondendo. O enriquecimento fica parado; ' +
          'nada é perdido — as pessoas seguem PENDENTE e o cron as retoma quando o Redis voltar.',
      );
    }
  }

  private registrarVolta() {
    if (this.avisouIndisponivel) {
      this.avisouIndisponivel = false;
      this.logger.log('Fila de volta: o Redis voltou a responder.');
    }
  }

  /**
   * O identificador do job — determinístico por PESSOA e por dia.
   *
   * ── ERA `cpf:<cpf>:<dia>`, E ISSO PUNHA CPF NA CHAVE DO REDIS ──
   *
   * O corpo do job é um valor; o `jobId` é parte da CHAVE. Chave é pior: um
   * `KEYS *`, uma tela de monitoramento ou um dump de memória lista CPFs sem
   * precisar ler valor nenhum. E a conexão não usa TLS — a proteção era só o
   * isolamento de rede.
   *
   * Trocar por um HASH do CPF, que era a correção sugerida, seria fraco: são
   * ~10^11 CPFs e o dígito verificador corta isso ainda mais, então a tabela de
   * SHA-256 de todos os válidos se constrói num laptop. Hash de espaço pequeno e
   * enumerável não anonimiza — a mesma razão pela qual `anonimizarIp` trunca.
   *
   * `pessoaId` é UUID sorteado: não deriva do CPF e não tem o que enumerar. E
   * como `Pessoa.cpf` é único, deduplicar por pessoa é exatamente deduplicar por
   * CPF — a idempotência diária continua idêntica.
   *
   * ⚠ Sem `:`, como o job de importação — ver o comentário em
   * `enfileirarImportacao` para o porquê. Os hifens do UUID não incomodam.
   */
  private idDoJob(pessoaId: string, dia: string) {
    return `enr-${pessoaId}-${dia}`;
  }

  /**
   * Enfileira uma pessoa. jobId determinístico evita repetir no mesmo dia.
   *
   * ⚠ Hoje NENHUM código chama este método — quem enfileira é sempre o lote.
   * Mantido por ser a operação unitária óbvia da fila, e corrigido junto para
   * não sobrar um caminho que ainda escreva CPF no Redis.
   */
  async enfileirarCpf(pessoaId: string, origem?: string) {
    const dia = new Date().toISOString().slice(0, 10);
    const r = await this.comTeto('enfileirar', () =>
      this.fila.add('enriquecer-cpf', { pessoaId, origem }, { jobId: this.idDoJob(pessoaId, dia) }),
    );
    this.registrarVolta();
    return r;
  }

  /**
   * Enfileira em lote, respeitando a deduplicação por jobId.
   *
   * Deduplica por PESSOA ANTES de mandar. O `jobId` já colapsava os repetidos
   * dentro do Redis, então nunca houve consulta paga em dobro — mas o número
   * devolvido era o de itens ENVIADOS, não o de jobs aceitos. Como a
   * importação empurra um item por LINHA da planilha, e um mesmo titular
   * aparece em vários precatórios, a tela anunciou "4.033 enfileirados" para
   * um lote que a fila recebeu como 3.839. Contar aqui faz o retorno
   * significar pessoas, e não linhas.
   *
   * Ressalva que o número não cobre: um CPF já enfileirado HOJE por outra
   * origem (cron, importação anterior) reencontra o mesmo jobId e é ignorado
   * pelo Redis. Nesses casos isto é um teto, não uma contagem exata —
   * distinguir exigiria consultar job a job, o que a 4 mil CPFs custaria mais
   * do que a precisão vale.
   */
  async enfileirarLote(itens: { pessoaId: string }[], origem?: string) {
    const dia = new Date().toISOString().slice(0, 10);
    /* Deduplicar por `pessoaId` é o mesmo que deduplicar por CPF: `Pessoa.cpf`
       é único, então a relação é 1:1. O que muda é que o CPF não precisa mais
       atravessar a aplicação até aqui. */
    const unicos = [...new Map(itens.map((i) => [i.pessoaId, i])).values()];
    const jobs = unicos.map((i) => ({
      name: 'enriquecer-cpf',
      data: { pessoaId: i.pessoaId, origem },
      opts: { jobId: this.idDoJob(i.pessoaId, dia) },
    }));
    /**
     * A fila fora NÃO pode derrubar a importação.
     *
     * Quando isto é chamado, as linhas da planilha JÁ estão no banco. Deixar o
     * erro subir devolveria um 500 para uma carga que deu certo — e o operador
     * reenviaria a planilha achando que perdeu tudo.
     *
     * Nada se perde de verdade: as pessoas ficam PENDENTE, que é exatamente o
     * que o cron diário procura. O enriquecimento atrasa, não some.
     */
    try {
      await this.comTeto('enfileirar-lote', () => this.fila.addBulk(jobs));
      this.registrarVolta();
    } catch (e) {
      this.registrarIndisponibilidade(e);
      this.logger.warn(
        `${jobs.length} CPF(s) NÃO foram enfileirados (origem=${origem ?? '-'}): fila indisponível. ` +
          'Eles seguem PENDENTE e o cron os retoma quando o Redis voltar.',
      );
      return { enfileirados: 0, filaIndisponivel: true as const };
    }
    const repetidos = itens.length - unicos.length;
    this.logger.log(
      `${jobs.length} CPF(s) enfileirados (origem=${origem ?? '-'})` +
        (repetidos > 0 ? ` · ${repetidos} repetido(s) no lote` : ''),
    );
    return { enfileirados: jobs.length };
  }

  /**
   * Manda uma importação para o worker processar.
   *
   * ── AQUI O ERRO SOBE, AO CONTRÁRIO DO `enfileirarLote` ──
   *
   * No enriquecimento, a fila fora é um atraso: as pessoas ficam PENDENTE e o
   * cron as retoma. Engolir o erro é o certo lá, porque a carga JÁ está gravada.
   *
   * Na importação é o oposto. Este job é o que FAZ o trabalho — sem ele as
   * linhas ficam PENDENTE para sempre, sem nada no sistema encarregado de
   * retomá-las. Engolir aqui produziria a pior tela possível: "recebida",
   * barrinha parada em 0%, e nenhum erro em lugar nenhum. Quem chama trata,
   * marca a importação como FALHOU e diz ao operador o que houve.
   *
   * `jobId` determinístico pelo id da importação: um clique duplo no botão, ou
   * um retry do cliente HTTP, não geram duas passadas sobre as mesmas linhas.
   *
   * ⚠ SEM DOIS-PONTOS NO `jobId`, e isso não é estilo.
   *
   * O BullMQ RECUSA um id customizado que contenha `:` — exceto quando ele parte
   * em exatamente três pedaços, uma compatibilidade com jobs repetíveis que o
   * próprio código deles marca como TODO para remover. `importacao:<uuid>` tem
   * duas partes e estourava com "Custom Id cannot contain :", derrubando toda
   * importação com um 503. Achado no navegador: os testes usam um dublê de fila
   * e nunca chegam a essa validação.
   *
   * O `cpf:<cpf>:<dia>` do enriquecimento tem três partes e passa hoje — mas
   * depende justamente da compatibilidade que eles pretendem tirar. Aqui não se
   * usa `:` de forma alguma para não depender disso.
   */
  async enfileirarImportacao(importacaoId: string) {
    const job = await this.comTeto('enfileirar-importacao', () =>
      this.filaImportacao.add(
        'importar-planilha',
        { importacaoId },
        { jobId: `importacao-${importacaoId}` },
      ),
    );
    this.registrarVolta();
    this.logger.log(`Importação ${importacaoId} enfileirada (job ${job.id}).`);
    return job;
  }

  /** Enfileira quem nunca foi sincronizado ou está desatualizado. */
  async enfileirarPendentes(limite = 500) {
    const pessoas = await this.prisma.pessoa.findMany({
      where: { statusEnriquecimento: { in: [...STATUS_A_ENRIQUECER] } },
      /* Sem o `cpf`: a fila não precisa mais dele, e não ler é melhor que ler e
         descartar — o CPF deixa de existir até no processo da API. */
      select: { id: true },
      take: limite,
      orderBy: { criadoEm: 'asc' },
    });
    if (pessoas.length === 0) return { enfileirados: 0 };
    return this.enfileirarLote(
      pessoas.map((p) => ({ pessoaId: p.id })),
      'sincronizacao-manual',
    );
  }

  /**
   * Estado da fila — NUNCA lança.
   *
   * É rota de painel: com o Redis fora, o certo é a tela dizer "fila
   * indisponível" e seguir mostrando o resto. Propagar o erro daqui derrubaria
   * um dashboard inteiro por causa de um card.
   *
   * `disponivel` é campo NOVO e explícito. Devolver zeros seria pior que o
   * erro: "0 aguardando" é indistinguível de "fila vazia", e alguém concluiria
   * que o enriquecimento terminou.
   */
  async estado() {
    const vazio = { aguardando: 0, ativos: 0, concluidos: 0, falhos: 0, atrasados: 0 };
    try {
      const [aguardando, ativos, concluidos, falhos, atrasados] = await this.comTeto(
        'estado',
        () =>
          Promise.all([
            this.fila.getWaitingCount(),
            this.fila.getActiveCount(),
            this.fila.getCompletedCount(),
            this.fila.getFailedCount(),
            this.fila.getDelayedCount(),
          ]),
      );
      this.registrarVolta();
      return { disponivel: true as const, aguardando, ativos, concluidos, falhos, atrasados };
    } catch (e) {
      this.registrarIndisponibilidade(e);
      return {
        disponivel: false as const,
        motivo: 'A fila não está respondendo (Redis fora do ar).',
        ...vazio,
      };
    }
  }

  async falhasRecentes(limite = 20) {
    try {
      const jobs = await this.comTeto('falhas', () => this.fila.getFailed(0, limite - 1));
      this.registrarVolta();
      return jobs.map((j) => ({
        id: j.id,
        tentativas: j.attemptsMade,
        motivo: j.failedReason?.slice(0, 300),
        em: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
      }));
    } catch (e) {
      /* Lista vazia é honesta aqui: "não há falha a mostrar agora". O card do
         estado, logo acima, é quem diz que a fila está fora. */
      this.registrarIndisponibilidade(e);
      return [];
    }
  }

  /**
   * Reprocessa tudo que falhou — requisito de "reprocessamento de consultas".
   *
   * Aqui o erro SOBE: é ação deliberada de um operador que clicou no botão.
   * Devolver "0 reprocessados" o faria pensar que não havia nada a reprocessar.
   */
  async reprocessarFalhas() {
    const jobs = await this.comTeto('reprocessar', () => this.fila.getFailed(0, 999));
    let n = 0;
    for (const j of jobs) {
      await this.comTeto('retry', () => j.retry());
      n++;
    }
    this.registrarVolta();
    return { reprocessados: n };
  }
}
