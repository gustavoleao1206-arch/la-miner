import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StatusFatura } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { escopoGlobal } from '../../prisma/sentinela-escopo';
import {
  BILLING_PROVIDER,
  type BillingProvider,
  type TipoEventoCobranca,
} from './domain/billing-provider.port';
import { conferirValorPago } from './conferir-valor';
import { DistribuicaoService } from '../distribuicao/distribuicao.service';

/**
 * ── DE ONDE PARA ONDE CADA EVENTO PODE LEVAR A FATURA ──
 *
 * `de` não é documentação: ele vai para o WHERE do UPDATE, e é o que impede um
 * evento atrasado de reescrever um estado mais recente. Cada linha tem uma
 * razão de dinheiro:
 *
 *  • VENCIDO só sai de ABERTA. Fatura PAGA não volta a dever porque um
 *    PAYMENT_OVERDUE chegou fora de ordem — e ele chega, sempre que alguém paga
 *    no dia do vencimento e o gateway entrega os eventos em paralelo.
 *  • ESTORNADO sai de qualquer estado VIVO, inclusive ABERTA: chargeback pode
 *    aparecer antes de a baixa ter sido processada, e dinheiro que voltou é o
 *    sinal mais forte que existe. Só não ressuscita CANCELADA.
 *  • REMOVIDA nunca toca fatura PAGA ou ESTORNADA. Apagar a cobrança lá fora não
 *    desfaz um pagamento que já aconteceu aqui dentro.
 *  • RESTAURADA só volta de CANCELADA, e volta para ABERTA — nunca direto para
 *    VENCIDA. Quem marca vencimento é `processarVencimentos`, e essa transição
 *    tem que continuar com um dono só; a fatura restaurada já nasce elegível
 *    para ele na próxima rodada.
 *
 * O `Exclude` no tipo é proposital: acrescentar um evento novo em
 * `TipoEventoCobranca` sem decidir a transição dele NÃO COMPILA.
 */
const TRANSICOES: Record<
  Exclude<TipoEventoCobranca, 'PAGAMENTO_CONFIRMADO'>,
  { de: StatusFatura[]; para: StatusFatura }
> = {
  PAGAMENTO_VENCIDO: { de: ['ABERTA'], para: 'VENCIDA' },
  PAGAMENTO_ESTORNADO: { de: ['ABERTA', 'PAGA', 'VENCIDA'], para: 'ESTORNADA' },
  COBRANCA_REMOVIDA: { de: ['ABERTA', 'VENCIDA'], para: 'CANCELADA' },
  COBRANCA_RESTAURADA: { de: ['CANCELADA'], para: 'ABERTA' },
};

@Injectable()
export class CobrancaService {
  private readonly logger = new Logger(CobrancaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    /* O motor de entrega. Cobrança conhece distribuição, e não o contrário:
       pagar é o fato que DISPARA a entrega, então a seta aponta daqui para lá.
       `DistribuicaoModule` não importa `CobrancaModule`, então não há ciclo. */
    private readonly distribuicao: DistribuicaoService,
  ) {}

  /** Dias entre a competência e o vencimento da fatura. */
  private get diasParaVencer(): number {
    return Number(this.config.get('COBRANCA_DIAS_VENCIMENTO', 10));
  }

  /** Tolerância entre vencer e suspender o acesso. */
  private get carenciaDias(): number {
    return Number(this.config.get('COBRANCA_CARENCIA_DIAS', 5));
  }

  /** Primeiro dia do mês, em UTC — mesma razão do motor de distribuição. */
  private competenciaDe(data: Date): Date {
    return new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth(), 1));
  }

  /**
   * Soma meses em UTC, no primeiro dia — o mesmo `Date.UTC(ano, mes + n, 1)` que
   * o motor de distribuição usa. Soma de MESES, não de 30 dias: um ciclo pago em
   * 31/01 termina em 01/03, e não numa data que escorrega todo mês.
   */
  private somarMeses(data: Date, meses: number): Date {
    return new Date(Date.UTC(data.getUTCFullYear(), data.getUTCMonth() + meses, 1));
  }

  private soDia(data: Date): Date {
    const d = new Date(data);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  /**
   * O provedor atual produz id externo?
   *
   * O MANUAL não produz — `emitirCobranca` devolve `{ idExterno: null }` de
   * propósito, porque a cobrança vive só aqui. Sem esta distinção, "fatura sem
   * id externo = emissão incompleta" faria o modo manual re-emitir a MESMA
   * fatura em toda chamada, destruindo a idempotência que o `@@unique` existe
   * para garantir.
   */
  private get provedorEmiteIdExterno(): boolean {
    return this.provider.nome !== 'MANUAL';
  }

  /**
   * Emite (idempotente) a fatura do ciclo.
   *
   * A fatura nasce no NOSSO banco ANTES de qualquer chamada externa. Se o gateway
   * falhar no meio, sobra uma fatura sem cobrança — visível, reconciliável. Na
   * ordem inversa sobraria uma cobrança lá fora que ninguém aqui conhece, e é
   * dessa metade que nascem os "paguei e não consta".
   */
  async emitirFatura(params: { organizationId: string; competencia?: Date; hoje?: Date }) {
    const agora = params.hoje ?? new Date();
    const competencia = this.competenciaDe(params.competencia ?? agora);
    const iso = competencia.toISOString().slice(0, 10);

    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId: params.organizationId },
      select: {
        id: true,
        status: true,
        clienteExternoId: true,
        provedorCobranca: true,
        pagoAte: true,
        /* `intervaloMeses` entra aqui pela PRIMEIRA vez neste módulo. Até então
           a palavra não aparecia uma única vez no arquivo, e era exatamente por
           isso que a cobrança era mensal por construção. */
        plano: { select: { nome: true, preco: true, intervaloMeses: true } },
        organization: { select: { nome: true, cnpj: true, telefone: true } },
      },
    });
    if (!assinatura) throw new NotFoundException('Esta organização não tem assinatura.');
    if (assinatura.status === 'CANCELADA') {
      return { emitida: false, motivo: 'assinatura cancelada', competencia: iso };
    }

    /**
     * ── O PERÍODO JÁ ESTÁ PAGO: NÃO COBRA DE NOVO ──
     *
     * A trava que faltava para o plano anual existir. `competenciaDe` sempre
     * trunca para o mês corrente, então no dia 1º do mês seguinte a competência
     * muda, o unique de (assinatura, competência) não acha nada e o serviço
     * emitiria uma cobrança NOVA pelo valor cheio do plano. Num plano de 12
     * meses isso é o cliente pagando o ano doze vezes.
     *
     * A comparação é com `pagoAte` EXCLUSIVO: um mensal pago em agosto tem
     * pagoAte = 1º de setembro, e no dia 1º de setembro `> hoje` é falso — volta
     * a cobrar, na data certa. Um anual pago em agosto só volta a cobrar em
     * agosto do ano seguinte.
     *
     * ⚠ VALE TAMBÉM PARA COMPETÊNCIA EXPLÍCITA, inclusive a da rota de ADMIN.
     * Poderia abrir exceção para quem passa a competência na mão, mas é
     * justamente ali que uma segunda cobrança do mesmo período nasceria sem
     * ninguém perceber — e desfazer cobrança emitida no gateway é trabalho
     * manual. Quem precisa mesmo forçar tem o caminho de cancelar a fatura.
     */
    if (assinatura.pagoAte && assinatura.pagoAte > this.soDia(agora)) {
      return {
        emitida: false,
        motivo: 'ciclo já pago',
        competencia: iso,
        pagoAte: assinatura.pagoAte.toISOString().slice(0, 10),
      };
    }

    const existente = await this.prisma.fatura.findUnique({
      where: { assinaturaId_competencia: { assinaturaId: assinatura.id, competencia } },
      select: { id: true, status: true, idExterno: true },
    });

    /* ── EMISSÃO PELA METADE: a fatura existe, a cobrança lá fora não ──
       A fatura nasce aqui ANTES da chamada externa (ver o cabeçalho). Se o
       gateway recusa, sobra uma fatura ABERTA sem `idExterno` — e o comentário
       original a chamava de "reconciliável" sem que nada a reconciliasse: a
       trava de idempotência devolvia "já existe" e NUNCA voltava ao gateway.
       O cliente ficava com conta criada, sem link de pagamento, para sempre.
       Aconteceu de verdade, com o primeiro cadastro real do site.

       Só é retomável o que está ABERTA: PAGA, CANCELADA e ESTORNADA não podem
       ganhar cobrança nova, e VENCIDA é assunto do cron de vencimentos. */
    const incompleta =
      existente !== null &&
      existente.status === 'ABERTA' &&
      existente.idExterno === null &&
      this.provedorEmiteIdExterno;

    if (existente && !incompleta) {
      return {
        emitida: false,
        motivo: 'fatura desta competência já existe',
        competencia: iso,
        faturaId: existente.id,
      };
    }

    const valor = Number(assinatura.plano.preco);

    /* ── O VENCIMENTO É O MAIOR ENTRE DOIS CANDIDATOS ──
       Pela competência (1º do mês + prazo) é o que o cron mensal quer: ele roda
       no começo do mês e o vencimento cai onde sempre caiu.
       Mas CADASTRO acontece em qualquer dia. Emitir no dia 16 a fatura da
       competência do dia 1º produzia vencimento no PASSADO, e o Asaas recusa
       com "Não é permitido data de vencimento inferior a hoje" — derrubando
       todo cadastro do dia 12 em diante, isto é, na maior parte do mês.
       O máximo entre os dois preserva o cron (no dia 1º os dois coincidem) e
       conserta o cadastro. Em UTC de propósito: UTC nunca está ATRÁS do horário
       de Brasília, então a data daqui nunca é anterior à de lá. */
    const porCompetencia = this.soDia(competencia);
    porCompetencia.setUTCDate(porCompetencia.getUTCDate() + this.diasParaVencer);
    const porHoje = this.soDia(agora);
    porHoje.setUTCDate(porHoje.getUTCDate() + this.diasParaVencer);
    const vencimentoEm = porCompetencia > porHoje ? porCompetencia : porHoje;

    /* Retomada REAPROVEITA a linha, em vez de criar outra: o `@@unique`
       (assinatura, competência) recusaria a segunda, e o vencimento antigo é
       justamente o que precisa ser corrigido. */
    const fatura = incompleta
      ? await this.prisma.fatura.update({
          where: { id: existente!.id },
          data: { valor, vencimentoEm },
          select: { id: true },
        })
      : await this.prisma.fatura.create({
          data: { assinaturaId: assinatura.id, competencia, valor, vencimentoEm },
          select: { id: true },
        });

    /* Cliente no gateway só na primeira vez — e o id volta para a assinatura. */
    const clienteExternoId =
      assinatura.clienteExternoId ??
      (await this.provider.registrarCliente({
        nome: assinatura.organization.nome,
        cnpjCpf: assinatura.organization.cnpj,
        telefone: assinatura.organization.telefone,
      }));

    const cobranca = await this.provider.emitirCobranca({
      clienteExternoId,
      valor,
      vencimentoEm,
      descricao: `${assinatura.plano.nome} — ${iso.slice(0, 7)}`,
      referencia: fatura.id,
    });

    await this.prisma.$transaction([
      this.prisma.fatura.update({
        where: { id: fatura.id },
        data: { idExterno: cobranca.idExterno, urlPagamento: cobranca.urlPagamento },
      }),
      this.prisma.assinatura.update({
        where: { id: assinatura.id },
        data: {
          /* O provedor fica gravado na PRIMEIRA emissão e não é reescrito: trocar
             de gateway não pode reinterpretar os ids externos do anterior. */
          provedorCobranca: assinatura.provedorCobranca ?? this.provider.nome,
          clienteExternoId,
        },
      }),
    ]);

    return {
      emitida: true,
      competencia: iso,
      faturaId: fatura.id,
      valor: valor.toFixed(2),
      vencimentoEm: vencimentoEm.toISOString().slice(0, 10),
      provedor: this.provider.nome,
      urlPagamento: cobranca.urlPagamento,
    };
  }

  /**
   * Baixa de pagamento — pela mão do admin ou por webhook do gateway.
   *
   * É AQUI que a entrega é disparada, e não em `reavaliarAssinatura`, embora
   * seja lá que o status vira ATIVA: `reavaliarAssinatura` também roda no cron
   * de vencimentos, onde uma assinatura pode voltar a ATIVA por motivo que não é
   * pagamento nenhum. "Pagou, recebe" tem que nascer do fato PAGAMENTO — e este
   * método é o único lugar do sistema onde esse fato é registrado, venha do
   * gateway ou da baixa manual.
   */
  async registrarPagamento(faturaId: string, quando?: Date) {
    const fatura = await this.prisma.fatura.findUnique({
      where: { id: faturaId },
      /* A organização vem junto: é a chave que o motor de distribuição usa, e
         buscá-la aqui evita uma segunda ida ao banco no caminho do webhook. */
      select: {
        id: true,
        status: true,
        assinaturaId: true,
        /* A competência da FATURA é o ciclo que está sendo pago — e é ela que
           vai ao motor de entrega, não o mês do calendário. Sem isto, quitar
           duas faturas atrasadas no mesmo mês entregava UM lote só: a segunda
           chamada caía na idempotência por competência e o cliente ficava sem o
           ciclo que acabou de pagar. */
        competencia: true,
        assinatura: { select: { organizationId: true } },
      },
    });
    if (!fatura) throw new NotFoundException('Fatura não encontrada.');
    /* Idempotente: repetir a baixa não mexe na data do primeiro pagamento — e,
       de quebra, é o que impede o reenvio de um webhook de gerar entrega duas
       vezes, porque a segunda passagem para aqui. */
    if (fatura.status === 'PAGA') return { alterado: false, status: 'PAGA' as const };
    /**
     * ESTORNADA e CANCELADA também fazem curto-circuito — e o gatilho é o
     * CARTÃO. No Asaas, o PAYMENT_RECEIVED do cartão chega ~32 dias depois do
     * CONFIRMED (quando o dinheiro liquida). Se houve estorno no meio, esse
     * RECEIVED atrasado encontrava a fatura ESTORNADA e a resistia a PAGA —
     * reabrindo acesso de quem tomou o dinheiro de volta. Dinheiro que saiu
     * não volta por webhook atrasado; volta por decisão de gente.
     */
    if (fatura.status === 'ESTORNADA' || fatura.status === 'CANCELADA') {
      this.logger.warn(
        `Baixa recusada: fatura ${faturaId} está ${fatura.status} — um pagamento ` +
          'atrasado não ressuscita fatura estornada/cancelada.',
      );
      return { alterado: false, status: fatura.status };
    }

    /**
     * ── O PAGAMENTO CARIMBA ATÉ QUANDO O CICLO ESTÁ COBERTO ──
     *
     * Gravado no INSTANTE do pagamento, e não derivado depois: `intervaloMeses`
     * é editável pelo painel, e recalcular na leitura faria o período que o
     * cliente comprou ser reinterpretado com a régua nova, retroativamente. O
     * que ele pagou é fato consumado.
     *
     * `Math.max` contra o valor atual: quitar uma fatura ATRASADA não pode
     * encurtar um período que já ia mais longe. Pagar agosto em outubro, com
     * setembro já pago, não pode fazer `pagoAte` voltar para 1º de setembro —
     * isso religaria a cobrança de um mês que está quitado.
     */
    const cobertura = await this.prisma.assinatura.findUniqueOrThrow({
      where: { id: fatura.assinaturaId },
      select: { pagoAte: true, plano: { select: { intervaloMeses: true } } },
    });
    const fimDoCiclo = this.somarMeses(fatura.competencia, cobertura.plano.intervaloMeses);
    const novoPagoAte =
      cobertura.pagoAte && cobertura.pagoAte > fimDoCiclo ? cobertura.pagoAte : fimDoCiclo;

    await this.prisma.$transaction([
      this.prisma.fatura.update({
        where: { id: faturaId },
        data: { status: 'PAGA', pagoEm: quando ?? new Date() },
      }),
      this.prisma.assinatura.update({
        where: { id: fatura.assinaturaId },
        data: { pagoAte: novoPagoAte },
      }),
    ]);
    const assinatura = await this.reavaliarAssinatura(fatura.assinaturaId);

    /* ── A ENTREGA, LOGO APÓS A BAIXA ──
       Antes disto, pagar só tirava o 402 da frente: a carteira do cliente
       continuava vazia até alguém rodar a distribuição à mão. O cliente pagava,
       entrava, e não via nada — o pior desfecho possível de uma venda.

       Fora da transação e com o erro ENGOLIDO, de propósito:
       o pagamento já está gravado e é o que não pode ser perdido. Se a entrega
       falhar, propagar o erro faria o webhook responder != 200, o gateway
       reenviaria, e o evento acabaria PENALIZADO — trocando "carteira vazia,
       conserta-se" por "pagamento sem baixa", que é bem pior. A falha fica no
       log em nível ERROR e o lote pode ser gerado depois pela rota admin ou
       pelo cron, que é idempotente por (assinatura, competência). */
    /* ⚠ Este `if` é ATALHO, não trava — e a diferença importa para quem mexer
       aqui depois. Quem de fato recusa assinatura não-ATIVA é o próprio motor
       (`gerarLote` devolve `gerado: false` com motivo `assinatura <STATUS>`).
       Medi por mutação: forçar esta condição a `true` não quebra nenhum teste,
       porque a defesa real está uma camada abaixo. O valor daqui é economizar
       uma ida ao banco no caminho do webhook e deixar a intenção explícita. */
    if (assinatura === 'ATIVA') {
      try {
        const lote = await this.distribuicao.gerarLote({
          organizationId: fatura.assinatura.organizationId,
          competencia: fatura.competencia,
        });
        if (lote.gerado) {
          this.logger.log(
            `Entrega automática após pagamento: ${lote.liberados} processos ` +
              `para a organização ${fatura.assinatura.organizationId} (${lote.competencia}).`,
          );
        } else {
          /* O caso silencioso que motivou este log: base vazia devolve
             `gerado: false` sem erro nenhum, e o cliente ficaria olhando uma
             carteira zerada sem que nada em lugar nenhum dissesse por quê. */
          this.logger.warn(
            `Entrega automática NÃO gerou lote para ${fatura.assinatura.organizationId}: ` +
              `${lote.motivo}. (disponíveis na base para esta carteira: ${lote.restantesNaBase})`,
          );
        }
      } catch (e) {
        this.logger.error(
          `Pagamento da fatura ${faturaId} registrado, mas a entrega falhou: ` +
            `${(e as Error).message}`,
        );
      }
    }

    return { alterado: true, status: 'PAGA' as const, assinatura };
  }

  /**
   * Reavalia o estado da assinatura a partir das FATURAS — nunca por decreto.
   *
   * Sobrou fatura vencida → INADIMPLENTE; nada em aberto → ATIVA. CANCELADA não
   * ressuscita: cancelamento é decisão, não consequência, e reativá-la por um
   * pagamento avulso seria pior do que devolver o dinheiro.
   */
  private async reavaliarAssinatura(assinaturaId: string) {
    const atual = await this.prisma.assinatura.findUniqueOrThrow({
      where: { id: assinaturaId },
      select: { status: true },
    });
    if (atual.status === 'CANCELADA') return atual.status;

    /* ESTORNADA conta como dívida, junto com VENCIDA.
       Contar só VENCIDA fazia o estorno DEVOLVER a assinatura para ATIVA: o
       cliente pagava, recebia o lote do mês, pedia chargeback e continuava
       ativo — recebendo um bloco novo de dados pessoais a cada ciclo, de graça.
       Reter PII de quem deixou de pagar é problema de LGPD antes de ser de
       receita. */
    const emAberto = await this.prisma.fatura.count({
      where: { assinaturaId, status: { in: ['VENCIDA', 'ESTORNADA'] } },
    });
    const novo = emAberto > 0 ? ('INADIMPLENTE' as const) : ('ATIVA' as const);

    const atualDaLinha = await this.prisma.assinatura.findUniqueOrThrow({
      where: { id: assinaturaId },
      select: { inadimplenteDesde: true },
    });

    await this.prisma.assinatura.update({
      where: { id: assinaturaId },
      data: {
        status: novo,
        /* ⚠ CARIMBAR o marco ao entrar em inadimplência.
           Sem isto, `inadimplenteDesde` ficava NULL e a query de suspensão
           (`inadimplenteDesde: { lte: limite }`) nunca casava — NULL não é TRUE
           em SQL. E o caminho que produz este estado é o webhook
           PAYMENT_OVERDUE, ou seja, o caminho NORMAL com gateway ligado: a
           suspensão por inadimplência simplesmente não acontecia.
           `?? new Date()` preserva o marco de uma inadimplência já em curso — a
           carência não pode reiniciar a cada evento do gateway. */
        ...(novo === 'INADIMPLENTE'
          ? { inadimplenteDesde: atualDaLinha.inadimplenteDesde ?? new Date() }
          : { inadimplenteDesde: null }),
      },
    });
    return novo;
  }

  /**
   * Cron diário: vence faturas, inadimple assinaturas e suspende quem passou da
   * carência.
   *
   * Suspender é o que TIRA O ACESSO (ver AssinaturaAtivaGuard) e o que corta
   * novos lotes (ver o motor de distribuição). Os dados do cliente ficam
   * intactos: suspensão é alavanca comercial, não punição — quem paga volta a
   * enxergar exatamente a carteira que já tinha.
   */
  async processarVencimentos(hoje = new Date()) {
    const dia = this.soDia(hoje);

    const vencidas = await this.prisma.fatura.updateMany({
      where: { status: 'ABERTA', vencimentoEm: { lt: dia } },
      data: { status: 'VENCIDA' },
    });

    /* ESTORNADA junto com VENCIDA — ver a nota em `reavaliarAssinatura`. */
    const comDivida = await this.prisma.fatura.findMany({
      where: { status: { in: ['VENCIDA', 'ESTORNADA'] } },
      select: { assinaturaId: true },
      distinct: ['assinaturaId'],
    });

    let inadimplentes = 0;
    for (const { assinaturaId } of comDivida) {
      const a = await this.prisma.assinatura.findUniqueOrThrow({
        where: { id: assinaturaId },
        select: { status: true, inadimplenteDesde: true },
      });

      /* Suspensa ou cancelada não regride: já passaram deste ponto. */
      if (a.status === 'SUSPENSA' || a.status === 'CANCELADA') continue;

      /* ATIVA entra em inadimplência agora. INADIMPLENTE sem marco é uma linha
         DOENTE — veio do webhook antes da correção, ou de uma versão anterior —
         e precisa ser carimbada aqui, senão fica presa para sempre: a query de
         suspensão logo abaixo ignora NULL, e o `continue` que existia neste
         lugar impedia justamente o reparo. Este ramo é o autocura. */
      if (a.status === 'ATIVA' || a.inadimplenteDesde === null) {
        await this.prisma.assinatura.update({
          where: { id: assinaturaId },
          data: { status: 'INADIMPLENTE', inadimplenteDesde: a.inadimplenteDesde ?? dia },
        });
        if (a.status === 'ATIVA') inadimplentes++;
      }
    }

    const limite = new Date(dia);
    limite.setUTCDate(limite.getUTCDate() - this.carenciaDias);
    const suspensas = await this.prisma.assinatura.updateMany(
      /* A régua de vencimentos é da operação: passa em todos os inadimplentes de
         uma vez, no cron ou na rota de ADMIN. Não é pedido de um cliente. */
      escopoGlobal('regua de vencimentos: suspende todos os inadimplentes vencidos de uma vez', {
        where: { status: 'INADIMPLENTE', inadimplenteDesde: { lte: limite } },
        data: { status: 'SUSPENSA' },
      }),
    );

    if (vencidas.count || inadimplentes || suspensas.count) {
      this.logger.log(
        `Cobrança: ${vencidas.count} fatura(s) vencida(s), ${inadimplentes} assinatura(s) ` +
          `inadimplente(s), ${suspensas.count} suspensa(s) após ${this.carenciaDias} dia(s)`,
      );
    }
    return { vencidas: vencidas.count, inadimplentes, suspensas: suspensas.count };
  }

  /**
   * Recebe um evento do gateway.
   *
   * Ordem deliberada: AUTENTICA, traduz, GRAVA e só então aplica. Gravar antes de
   * aplicar é o que dá idempotência (o gateway reenvia quando não recebe 200 a
   * tempo) e o que permite reprocessar um evento cuja interpretação estava
   * errada, sem depender de reenvio.
   */
  async receberEvento(
    corpoBruto: string,
    cabecalhos: Record<string, string | undefined>,
    payload: unknown,
  ) {
    if (!this.provider.verificarWebhook(corpoBruto, cabecalhos)) {
      /* No provedor MANUAL isto recusa sempre — é o que impede a rota pública de
         virar um "marque como pago" aberto enquanto não há gateway configurado. */
      throw new UnauthorizedException('Webhook não autenticado.');
    }

    const evento = this.provider.interpretarEvento(payload);
    if (!evento) {
      /* O nome do evento vai para o log: é assim que a operação descobre um
         pagamento parado em análise de risco (cartão de ticket alto) ou um
         estorno parcial esperando decisão humana. O comentário do adaptador
         prometia este registro e ele não existia. */
      const nome =
        typeof payload === 'object' && payload !== null && 'event' in payload
          ? String((payload as { event: unknown }).event)
          : '(sem nome)';
      this.logger.log(`Webhook ignorado por desenho: ${nome}`);
      return { aplicado: false, motivo: 'evento ignorado' };
    }

    /* skipDuplicates + @unique(idExterno) = idempotência sem transação nem
       corrida. Mesmo padrão do snapshot diário da carteira. */
    const { count } = await this.prisma.eventoCobranca.createMany({
      data: [
        {
          provedor: this.provider.nome,
          idExterno: evento.idExterno,
          tipo: evento.tipo,
          payload: payload as object,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return { aplicado: false, motivo: 'evento já processado' };

    const fatura = await this.prisma.fatura.findUnique({
      where: { idExterno: evento.cobrancaExternaId },
      select: { id: true, assinaturaId: true, valor: true },
    });
    if (!fatura) {
      await this.marcarEvento(evento.idExterno, 'cobrança não encontrada por id externo');
      return { aplicado: false, motivo: 'cobrança desconhecida' };
    }

    if (evento.tipo === 'PAGAMENTO_CONFIRMADO') {
      /**
       * CONFERE O VALOR ANTES DA BAIXA.
       *
       * Antes, "pagou" bastava — quanto, não importava. Um pagamento parcial,
       * ou uma cobrança emitida com valor errado, liberava a assinatura
       * inteira; o rombo só apareceria na conciliação, meses depois, e o
       * cliente já teria recebido lotes que não pagou.
       *
       * Repare que isto NÃO é defesa contra webhook forjado — para isso existe
       * o segredo compartilhado, conferido logo acima. É defesa contra
       * pagamento a menor e contra erro de emissão, que são muito mais
       * prováveis do que um atacante com a nossa chave.
       */
      const conferencia = conferirValorPago(fatura.valor, evento.valorPago);
      if (!conferencia.aceitar) {
        await this.marcarEvento(evento.idExterno, conferencia.motivo);
        this.logger.warn(
          `Pagamento RECUSADO na fatura ${fatura.id}: ${conferencia.motivo}. ` +
            'A fatura segue em aberto e a assinatura não foi liberada.',
        );
        return { aplicado: false, motivo: conferencia.motivo };
      }
      if (conferencia.observacao) this.logger.warn(conferencia.observacao);

      await this.registrarPagamento(fatura.id, evento.pagoEm);
      /* A observação (valor a maior, ou não conferível) fica NO EVENTO, e não
         só no log: log rotaciona, a trilha de cobrança não. */
      await this.marcarEvento(evento.idExterno, conferencia.observacao);
      return { aplicado: true, tipo: evento.tipo, faturaId: fatura.id };
    } else {
      const transicao = TRANSICOES[evento.tipo];
      /**
       * ── COMPARE-AND-SET, NÃO UPDATE CEGO ──
       *
       * O `de` entra no WHERE: o banco decide, numa operação só, se o estado
       * atual aceita este evento. Sem corrida e sem leitura prévia — o mesmo
       * truque do consumo do refresh token.
       *
       * Antes daqui o UPDATE era cego, e isso ERA UM DEFEITO com dinheiro
       * dentro: um PAYMENT_OVERDUE que chegasse DEPOIS do PAYMENT_CONFIRMED
       * marcava VENCIDA uma fatura já PAGA, e a régua suspendia quem tinha
       * pagado. Não é hipótese remota: quem paga no próprio dia do vencimento
       * dispara os dois eventos com segundos de diferença, e o webhook do Asaas
       * está configurado como "não sequencial" — ordem de chegada não é
       * garantida por desenho.
       */
      const { count } = await this.prisma.fatura.updateMany({
        where: { id: fatura.id, status: { in: transicao.de } },
        data: {
          status: transicao.para,
          /* No estorno o dinheiro VOLTOU: manter `pagoEm` preenchido deixaria a
             fatura parecendo quitada em toda leitura — inclusive na tela do
             cliente, que mostra "Paga em ...". */
          ...(transicao.para === 'ESTORNADA' ? { pagoEm: null } : {}),
        },
      });

      if (count === 0) {
        /* O evento chegou, é legítimo, e simplesmente não se aplica ao estado
           atual. Fica registrado com o motivo: a trilha de cobrança precisa
           mostrar que ele foi VISTO e recusado, e não que se perdeu. */
        const motivo = `estado atual da fatura não aceita ${evento.tipo}`;
        await this.marcarEvento(evento.idExterno, motivo);
        this.logger.warn(`Fatura ${fatura.id}: ${motivo}.`);
        return { aplicado: false, motivo };
      }

      await this.reavaliarAssinatura(fatura.assinaturaId);
    }

    await this.marcarEvento(evento.idExterno);
    return { aplicado: true, tipo: evento.tipo, faturaId: fatura.id };
  }

  private async marcarEvento(idExterno: string, erro?: string) {
    await this.prisma.eventoCobranca.update({
      where: { idExterno },
      data: { processadoEm: new Date(), erro: erro ?? null },
    });
  }

  /**
   * Encerra a assinatura.
   *
   * Existia um buraco de ciclo de vida: `CANCELADA` era LIDA em três pontos
   * (`emitirFatura` recusa, `reavaliarAssinatura` não ressuscita, o guard barra
   * o acesso) e ESCRITA em nenhum — não havia como encerrar um contrato pela
   * aplicação, só por UPDATE no banco.
   *
   * O que cancelar significa aqui:
   *  - a assinatura para de faturar e de receber lote;
   *  - o acesso cai (o AssinaturaAtivaGuard devolve 402);
   *  - as faturas ainda ABERTAS são canceladas, inclusive no gateway — cobrar
   *    quem encerrou o contrato é o pior erro possível de cobrança;
   *  - as faturas VENCIDAS ficam como estão: dívida passada não evapora porque
   *    o cliente saiu;
   *  - NADA é apagado. A carteira liberada e o CRM do cliente continuam de pé,
   *    porque cancelamento não é pedido de exclusão — para isso existe o rito do
   *    art. 18, que é outro caminho e tem outro registro.
   */
  async cancelarAssinatura(organizationId: string, motivo?: string) {
    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId },
      select: { id: true, status: true },
    });
    if (!assinatura) throw new NotFoundException('Esta organização não tem assinatura.');
    if (assinatura.status === 'CANCELADA') {
      return { cancelada: false, motivo: 'assinatura já estava cancelada' };
    }

    const abertas = await this.prisma.fatura.findMany({
      where: { assinaturaId: assinatura.id, status: 'ABERTA' },
      select: { id: true, idExterno: true },
    });

    /* O gateway primeiro: se falhar, a assinatura continua ATIVA e o operador
       tenta de novo. Na ordem inversa ficaria uma cobrança viva lá fora para um
       contrato que aqui já acabou — e o cliente receberia o boleto. */
    for (const f of abertas) {
      if (!f.idExterno) continue;
      try {
        await this.provider.cancelarCobranca(f.idExterno);
      } catch (e) {
        this.logger.error(
          `Falha ao cancelar a cobrança ${f.idExterno} no provedor: ${(e as Error).message}`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.assinatura.update({
        where: { id: assinatura.id },
        data: { status: 'CANCELADA', canceladaEm: new Date(), proximaRenovacaoEm: null },
      }),
      this.prisma.fatura.updateMany({
        where: { assinaturaId: assinatura.id, status: 'ABERTA' },
        data: { status: 'CANCELADA' },
      }),
    ]);

    this.logger.log(
      `Assinatura da org ${organizationId} cancelada${motivo ? ` (${motivo})` : ''}; ` +
        `${abertas.length} fatura(s) aberta(s) cancelada(s)`,
    );
    return { cancelada: true, faturasCanceladas: abertas.length };
  }

  /**
   * A assinatura como o CLIENTE a vê.
   *
   * Sem `clienteExternoId`, sem `assinaturaExternaId`, sem nome de gateway: ele
   * paga a Leão Amorim, e por quais trilhos o dinheiro corre é infraestrutura —
   * a mesma disciplina que apaga o provedor de enriquecimento da resposta dele.
   */
  async minhaAssinatura(organizationId: string) {
    const a = await this.prisma.assinatura.findUnique({
      where: { organizationId },
      select: {
        status: true,
        inicioEm: true,
        proximaRenovacaoEm: true,
        plano: { select: { nome: true, descricao: true, processosPorCiclo: true, preco: true } },
        faturas: {
          orderBy: { competencia: 'desc' },
          take: 12,
          select: {
            id: true,
            competencia: true,
            valor: true,
            status: true,
            vencimentoEm: true,
            pagoEm: true,
            urlPagamento: true,
            /* Só para DERIVAR `retomavel` abaixo — não sai na resposta. */
            idExterno: true,
          },
        },
      },
    });
    if (!a) throw new NotFoundException('Esta organização não tem assinatura.');

    return {
      status: a.status,
      inicioEm: a.inicioEm,
      proximaRenovacaoEm: a.proximaRenovacaoEm,
      plano: { ...a.plano, preco: a.plano.preco.toString() },
      /* `idExterno` fica de fora e vira um BOOLEANO DE PRODUTO.
         A tela precisa saber "dá para gerar a cobrança de novo?", não o id da
         cobrança no gateway — expor o id contradiria a disciplina do método, que
         apaga qualquer traço de infraestrutura da resposta do cliente. */
      faturas: a.faturas.map(({ idExterno, ...f }) => ({
        ...f,
        valor: f.valor.toString(),
        retomavel: f.status === 'ABERTA' && idExterno === null && this.provedorEmiteIdExterno,
      })),
    };
  }
}
