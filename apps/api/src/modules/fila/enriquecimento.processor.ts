import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import type { Prisma } from '@miner/database';

import { PrismaService } from '../../prisma/prisma.service';
import {
  ENRICHMENT_PROVIDER,
  type EnrichmentProvider,
  type PessoaEnriquecida,
} from '../enriquecimento/domain/enrichment-provider.port';
import { FILA_ENRIQUECIMENTO } from './fila.constants';
import { conferirNome } from '../enriquecimento/application/conferencia-de-nome';
import { TetoConsumoService } from '../enriquecimento/application/teto-consumo.service';

/**
 * O job carrega SÓ o id da pessoa — o CPF vem do banco, na hora de usar.
 *
 * ── POR QUE O CPF SAIU DAQUI ──
 *
 * O `FilaService` já enunciava a regra para o job de IMPORTAÇÃO, no topo daquele
 * arquivo: carregar só o id, porque empacotar dado pessoal no Redis o coloca
 * "fora do Postgres, onde a exclusão do titular não alcança". O job de
 * importação obedecia; este violava — mandava `{ cpf, pessoaId, origem }`, com o
 * CPF em claro no corpo E no `jobId`.
 *
 * O corpo do job é um valor no Redis; o `jobId` é parte da CHAVE. Chave é pior:
 * um `KEYS *`, uma tela de monitoramento ou um dump de memória lista CPFs sem
 * precisar ler valor nenhum.
 *
 * ── E POR QUE NÃO UM HASH DO CPF ──
 *
 * Era a correção que a auditoria sugeria, e ela é fraca. Existem ~10^11 CPFs, e
 * o dígito verificador corta isso em uma ordem de grandeza: uma tabela de
 * SHA-256 de TODOS os CPFs válidos se constrói num laptop, em horas. Hash de
 * espaço pequeno e enumerável não anonimiza — é a mesma razão pela qual
 * `anonimizarIp` trunca em vez de resumir.
 *
 * O `pessoaId` resolve melhor e de graça: é UUID sorteado, não deriva do CPF,
 * não tem o que enumerar, e `Pessoa.cpf` é único — então deduplicar por pessoa é
 * EXATAMENTE deduplicar por CPF, sem perder nada.
 *
 * ── COMPATIBILIDADE COM O QUE JÁ ESTÁ NA FILA ──
 *
 * Jobs enfileirados pela versão antiga trazem `{ cpf, pessoaId, origem }`. Eles
 * continuam funcionando: o que se lê aqui é `pessoaId`, que eles têm; o `cpf`
 * que sobra no corpo é ignorado. Nada precisa ser drenado antes do deploy.
 */
export interface JobEnriquecerCpf {
  pessoaId: string;
  origem?: string;
}

@Processor(FILA_ENRIQUECIMENTO, { concurrency: 5 })
export class EnriquecimentoProcessor extends WorkerHost {
  private readonly logger = new Logger(EnriquecimentoProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(ENRICHMENT_PROVIDER) private readonly provider: EnrichmentProvider,
    private readonly teto: TetoConsumoService,
  ) {
    super();
  }

  async process(job: Job<JobEnriquecerCpf>): Promise<{ status: string }> {
    const { pessoaId, origem } = job.data;

    /**
     * Idempotência: se o provedor JÁ FOI PAGO por esta pessoa hoje, não paga de novo.
     *
     * ⚠ A pergunta certa é "foi cobrado?", não "deu certo?". A guarda filtrava
     * `status: 'SUCESSO'` e deixava passar o `SEM_DADOS` — que é uma consulta
     * feita, respondida e FATURADA igual. E CPF sem cadastro no provedor é a
     * população mais provável justamente nos pré-precatórios, onde o documento
     * foi extraído do texto da publicação em vez de vir de campo estruturado.
     *
     * `ERRO` fica de fora de propósito: ali o provedor pode nem ter sido
     * alcançado (timeout de rede, 5xx), e é exatamente o caso que as três
     * tentativas do BullMQ existem para resolver. Bloquear o `ERRO` trocaria um
     * gasto duplicado por uma pessoa que nunca chega a ser enriquecida.
     */
    const jaCobradoHoje = await this.prisma.enriquecimento.findFirst({
      where: {
        pessoaId,
        provider: this.provider.nome,
        status: { in: ['SUCESSO', 'SEM_DADOS'] },
        criadoEm: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      },
      select: { id: true },
    });
    if (jaCobradoHoje) return { status: 'JA_SINCRONIZADO_HOJE' };

    /**
     * O CPF é buscado AQUI, e não vem no job.
     *
     * Isso fecha uma janela que existia: entre enfileirar e processar passam
     * horas — o cron enfileira 500 por vez e a fila drena devagar. Se o titular
     * pedir exclusão nesse intervalo, o job antigo carregava o CPF dele no corpo
     * e consultaria o provedor PAGO assim que chegasse a vez, trazendo de volta
     * telefone e endereço de quem acabou de mandar apagar. O `excluir` limpa o
     * banco; não tinha como alcançar o que já estava no Redis.
     *
     * Lendo do banco na hora do uso, a exclusão passa a valer também para o
     * trabalho já enfileirado — sem precisar varrer a fila.
     *
     * Nenhum dos dois casos é falha: é trabalho que deixou de fazer sentido.
     * Lançar aqui encheria a lista de falhas e o botão Reprocessar tentaria de
     * novo, para sempre.
     */
    const pessoa = await this.prisma.pessoa.findUnique({
      where: { id: pessoaId },
      /* `nome` entra aqui porque e o LADO DE CA da conferencia — o que a
         planilha trouxe. Ler junto do CPF evita uma segunda ida ao banco no
         meio da transacao. */
      select: { cpf: true, nome: true, exclusaoEm: true },
    });
    if (!pessoa) return { status: 'PESSOA_INEXISTENTE' };
    if (pessoa.exclusaoEm) {
      this.logger.log(`Pessoa ${pessoaId} pediu exclusão: enriquecimento cancelado.`);
      return { status: 'TITULAR_EXCLUIDO' };
    }
    const cpf = pessoa.cpf;

    // Trava de custo. Lança se o teto do dia acabou — o job falha de forma
    // visível e pode ser reprocessado amanhã, em vez de gerar fatura.
    try {
      await this.teto.garantirDisponibilidade(this.provider.nome);
    } catch (e) {
      // Teto estourado não é falha transitória: repetir hoje não vai adiantar.
      // UnrecoverableError encerra o job sem consumir as tentativas de retry —
      // ele fica em 'failed' e volta pelo botão Reprocessar amanhã.
      throw new UnrecoverableError((e as Error).message);
    }

    /* DRY RUN: exercita a fila inteira sem tocar no provedor pago.
       Serve para testar fluxo, concorrência e retry sem gerar fatura.

       ⚠ O job resultante DEVOLVE a vaga de deduplicação depois de concluir —
       ver `aoCompletar` no fim do arquivo. Sem isso ele ocupa por 24h o
       `jobId` da pessoa e impede a consulta de verdade no mesmo dia. */
    if (this.config.get<string>('SYNC_DRY_RUN', 'false') === 'true') {
      this.logger.log(`[DRY RUN] consultaria CPF ***${cpf.slice(-4)} (pessoa ${pessoaId})`);
      return { status: 'DRY_RUN' };
    }

    const r = await this.provider.consultarPorCpf(cpf, { origem, correlacaoId: job.id });

    // Versão nova (append-only) — o histórico nunca é sobrescrito.
    const ultima = await this.prisma.enriquecimento.findFirst({
      where: { pessoaId, provider: this.provider.nome },
      orderBy: { versao: 'desc' },
      select: { versao: true },
    });

    /**
     * ═══ PRIMEIRO A PROVA DO GASTO, DEPOIS O TRABALHO ═══
     *
     * A consulta acima é o ÚNICO ato irreversível deste job: o dinheiro saiu.
     * Tudo o que vem depois é banco, e banco desfaz.
     *
     * Antes, as duas coisas moravam na mesma transação e o contador vinha ainda
     * mais tarde, fora dela. Qualquer tropeço dentro do `aplicarContatos` —
     * dezenas de escritas sequenciais, com dado vindo de fora — derrubava por
     * rollback a linha de `Enriquecimento` E impedia o incremento do `apiUsage`.
     * O erro subia, o BullMQ retentava (`attempts: 3`), a guarda lá em cima não
     * achava nada (o rollback tinha apagado a prova) e o provedor era PAGO OUTRA
     * VEZ. Até três cobranças para a mesma pessoa, com o painel de consumo
     * marcando zero para as três — porque o contador só subia no caminho feliz.
     *
     * Isso não era só perder dinheiro: era o teto diário mentindo. Ele conta o
     * que foi GRAVADO, e quem falha não grava. Uma trava que afrouxa justamente
     * quando as coisas dão errado é o contrário de uma trava.
     *
     * Agora são duas transações. A primeira é minúscula e só registra o que já
     * aconteceu: a linha do enriquecimento e o incremento do contador, juntos,
     * porque os dois descrevem o mesmo fato — houve uma consulta cobrada.
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.enriquecimento.create({
        data: {
          pessoaId,
          provider: this.provider.nome,
          versao: (ultima?.versao ?? 0) + 1,
          status: r.status,
          dadosBrutos: r.dadosBrutos as never,
          mensagemErro: r.mensagemErro,
          custoCreditos: r.custoCreditos,
          requestId: r.requestId,
          latenciaMs: r.latenciaMs,
        },
      });

      await this.contabilizarUso(tx, r.status, r.custoCreditos, r.latenciaMs);
    });

    /**
     * A segunda transação é a parte frágil. Se ela cair, o gasto continua
     * registrado e a guarda do topo protege a retentativa: ninguém paga duas
     * vezes pela mesma pessoa no mesmo dia.
     *
     * ⚠ `UnrecoverableError` de propósito, e não o erro cru. O erro cru faria o
     * BullMQ retentar; a retentativa bateria na guarda, devolveria
     * `JA_SINCRONIZADO_HOJE` e o job terminaria VERDE — anunciando sucesso sobre
     * um trabalho que não foi feito. Falhar de uma vez deixa o job em `failed`,
     * visível em `GET /fila/falhas`, com o dinheiro contabilizado e os contatos
     * declaradamente pendentes.
     *
     * O reprocessamento no MESMO dia não reaplica, porque a guarda barra antes —
     * e ela está certa: pagar de novo é decisão de gente, não de retry.
     */
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.pessoa.update({
          where: { id: pessoaId },
          data: {
            statusEnriquecimento:
              r.status === 'SUCESSO' ? 'SINCRONIZADO' : r.status === 'SEM_DADOS' ? 'SEM_DADOS' : 'ERRO',
            ultimaSincronizacao: new Date(),
          },
        });

        if (r.status === 'SUCESSO' && r.pessoa) {
          await this.aplicarContatos(tx, pessoaId, r.pessoa, pessoa.nome);
        }
      });
    } catch (e) {
      this.logger.error(
        `Pessoa ${pessoaId}: consulta PAGA e contabilizada, mas a gravação dos ` +
          `contatos falhou (${(e as Error).message}). O crédito não será gasto de ` +
          'novo hoje; os contatos ficam pendentes até um reprocessamento deliberado.',
      );
      throw new UnrecoverableError((e as Error).message);
    }

    return { status: r.status };
  }

  /**
   * Upsert de contatos preservando histórico:
   * dado que reaparece só atualiza `ultimaVez`; dado novo entra como novo.
   * Nada é apagado — some do "ativo", não do banco.
   */
  private async aplicarContatos(
    tx: any,
    pessoaId: string,
    p: PessoaEnriquecida,
    /** O nome que a PLANILHA trouxe — o lado de cá da conferência. */
    nomeAtual: string,
  ): Promise<void> {
    const agora = new Date();

    if (p.nome || p.dataNascimento || p.situacaoCadastral) {
      /**
       * A CONFERÊNCIA DO CPF, que custa zero e estava sendo jogada fora.
       *
       * O provedor devolve `p.nome` — o nome de quem REALMENTE tem este CPF — e
       * este bloco o recebia sem usar. Nos pré-precatórios isso importa: o CPF é
       * extraído do TEXTO da publicação, e dígito verificador válido prova que o
       * número é bem formado, não que seja daquele credor. A própria fonte
       * avisa: "documento errado ao lado de um nome é pior que documento
       * nenhum".
       *
       * ⚠ O nome do provedor NÃO é gravado, só o veredito. Guardá-lo dobraria a
       * superfície de dado pessoal e daria à exclusão do titular mais um lugar
       * para alcançar.
       *
       * E `Pessoa.nome` continua sendo o da planilha: sobrescrevê-lo pelo do
       * provedor apagaria justamente a evidência que permite a comparação — na
       * execução seguinte tudo passaria a CONFERIR, inclusive o que não confere.
       */
      const conferencia = p.nome
        ? conferirNome(nomeAtual, p.nome)
        : undefined;

      if (conferencia === 'DIVERGE') {
        this.logger.warn(
          `Nome divergente para pessoa ${pessoaId}: o CPF pertence a outra pessoa, ou o ` +
            'nome da planilha está errado. Não abordar sem conferir.',
        );
      }

      await tx.pessoa.update({
        where: { id: pessoaId },
        data: {
          dataNascimento: p.dataNascimento ?? undefined,
          nomeMae: p.nomeMae ?? undefined,
          situacaoCadastral: p.situacaoCadastral ?? undefined,
          obito: p.obito ?? undefined,
          conferenciaNome: conferencia,
        },
      });
    }

    for (const t of p.telefones) {
      await tx.telefone.upsert({
        where: { pessoaId_ddd_numero: { pessoaId, ddd: t.ddd ?? null, numero: t.numero } },
        create: {
          pessoaId,
          ddd: t.ddd,
          numero: t.numero,
          tipo: t.tipo ?? 'DESCONHECIDO',
          /* `whatsapp` continua: é o ícone verde na ficha da parte, e o único
             sinal na tela de que aquele número aceita mensagem. O `score`, que
             ficava aqui do lado, saiu — ver o bloco de e-mails logo abaixo. */
          whatsapp: t.whatsapp,
          origem: this.provider.nome,
        },
        update: { ultimaVez: agora, ativo: true },
      });
    }

    for (const e of p.emails) {
      await tx.email.upsert({
        where: { pessoaId_endereco: { pessoaId, endereco: e.endereco } },
        /* ⚠ SEM `score` — minimização (LGPD art. 6º, III).
           O provedor devolve uma nota de confiabilidade para cada telefone e
           cada e-mail, e o sistema gravava as duas. NADA as lia: não ordenavam
           a lista de contatos (a ordem é por `ultimaVez`), não filtravam, não
           apareciam em tela e não tinham um único teste. Gravar dado que
           ninguém usa é coleta sem finalidade demonstrada.

           A COLUNA continua no schema de propósito: apagá-la é irreversível, e
           o histórico só voltaria repetindo consulta PAGA ao provedor. */
        create: { pessoaId, endereco: e.endereco, origem: this.provider.nome },
        update: { ultimaVez: agora, ativo: true },
      });
    }

    // Endereço não tem chave natural confiável: evita duplicar comparando CEP+número.
    for (const a of p.enderecos) {
      const existente = await tx.endereco.findFirst({
        where: { pessoaId, cep: a.cep ?? null, numero: a.numero ?? null },
        select: { id: true },
      });
      if (existente) {
        await tx.endereco.update({ where: { id: existente.id }, data: { ultimaVez: agora, ativo: true } });
      } else {
        await tx.endereco.create({ data: { pessoaId, ...a, origem: this.provider.nome } });
      }
    }
  }

  /**
   * O contador que alimenta o teto diário.
   *
   * Recebe o `tx` porque agora vive DENTRO da transação que registra o gasto: ou
   * a consulta cobrada existe no histórico E conta no teto, ou não existe
   * nenhuma das duas. Rodando solto, como antes, ele ficava atrás de um rollback
   * e deixava dinheiro gasto fora da conta.
   */
  private async contabilizarUso(
    tx: Prisma.TransactionClient,
    status: string,
    creditos?: number,
    latencia?: number,
  ): Promise<void> {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    await tx.apiUsage.upsert({
      where: { provider_data: { provider: this.provider.nome, data: hoje } },
      create: {
        provider: this.provider.nome,
        data: hoje,
        chamadas: 1,
        sucesso: status === 'SUCESSO' ? 1 : 0,
        semDados: status === 'SEM_DADOS' ? 1 : 0,
        erros: status === 'ERRO' ? 1 : 0,
        creditosGastos: creditos ?? 0,
        latenciaMediaMs: latencia,
      },
      update: {
        chamadas: { increment: 1 },
        sucesso: { increment: status === 'SUCESSO' ? 1 : 0 },
        semDados: { increment: status === 'SEM_DADOS' ? 1 : 0 },
        erros: { increment: status === 'ERRO' ? 1 : 0 },
        creditosGastos: { increment: creditos ?? 0 },
      },
    });
  }

  /**
   * O JOB QUE NÃO GASTOU NADA DEVOLVE A VAGA.
   *
   * ── O QUE ISTO CONSERTA ──
   *
   * O `jobId` é `enr-<pessoaId>-<dia>` e existe para uma coisa só: impedir que a
   * MESMA pessoa seja PAGA duas vezes no mesmo dia. Jobs concluídos ficam no
   * Redis por 24h (`removeOnComplete: { age: 86_400 }`), então o id continua
   * ocupado depois de rodar.
   *
   * Com `SYNC_DRY_RUN=true` isso vira uma armadilha: o job conclui sem tocar no
   * provedor, não gasta um centavo — e mesmo assim segura a vaga. Ligar o modo
   * real no mesmo dia não adianta: o `add` reencontra o id, o Redis o ignora em
   * silêncio, e a API ainda responde "N enfileiradas", porque ela conta o que
   * TENTOU enviar.
   *
   * Aconteceu de verdade em 06/09/2026: 1.137 pré-precatórios importados
   * enfileiraram 1.137 jobs que rodaram em dry-run; a rodada real logo depois
   * foi engolida inteira, com os contadores parados em zero.
   *
   * ── POR QUE AQUI, E NÃO DENTRO DO `process()` ──
   *
   * Enquanto o job está ativo ele está TRAVADO pelo worker, e `job.remove()`
   * recusa. No evento `completed` ele já saiu do estado ativo e pode sair.
   *
   * ── POR QUE PELO RESULTADO, E NÃO PELA CONFIGURAÇÃO ──
   *
   * A tentação é decidir no enfileiramento: `jobId` diferente quando o dry-run
   * está ligado. Isso abre um buraco de pagamento DUPLO justo na virada da
   * variável — um job enfileirado como "dry" e processado depois do deploy, já
   * em modo real, pagaria de verdade ocupando a vaga errada, e o próximo
   * enfileiramento da mesma pessoa pagaria outra vez.
   *
   * O resultado do job é a única coisa que sabe o que REALMENTE aconteceu.
   *
   * ── E SÓ O `DRY_RUN` ──
   *
   * Os outros retornos precoces mantêm a vaga, e cada um por um motivo:
   * `JA_SINCRONIZADO_HOJE` porque houve consulta paga hoje; `TITULAR_EXCLUIDO`
   * porque repetir seria buscar dado de quem mandou apagar; `PESSOA_INEXISTENTE`
   * porque não há a quem consultar.
   *
   * ── O CUSTO, ASSUMIDO ──
   *
   * Jobs de dry-run somem do contador CONCLUÍDOS da tela de Fila. Perde-se o
   * sinal visual de "a simulação rodou" — que fica só no log. É o lado certo da
   * troca: um contador bonito não vale bloquear 24h de trabalho real.
   */
  @OnWorkerEvent('completed')
  async aoCompletar(job: Job, resultado: { status?: string } | undefined): Promise<void> {
    if (resultado?.status !== 'DRY_RUN') return;
    try {
      await job.remove();
    } catch (e) {
      /* Não relança: falhar aqui só devolve o comportamento antigo (a vaga
         segue ocupada até amanhã). Derrubar o worker por causa da limpeza
         seria trocar um incômodo por uma parada. */
      this.logger.warn(
        `Job ${job.id} (DRY RUN) não pôde liberar a vaga de deduplicação: ${(e as Error).message}. ` +
          'A consulta real desta pessoa só passa amanhã.',
      );
    }
  }

  @OnWorkerEvent('failed')
  aoFalhar(job: Job, err: Error): void {
    this.logger.error(`Job ${job.id} falhou (tentativa ${job.attemptsMade}): ${err.message}`);
  }
}
