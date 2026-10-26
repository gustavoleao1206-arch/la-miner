import { CobrancaService } from '../../src/modules/cobranca/cobranca.service';
import { ManualProvider } from '../../src/modules/cobranca/providers/manual.provider';
import { DistribuicaoService } from '../../src/modules/distribuicao/distribuicao.service';
import type {
  BillingProvider,
  CobrancaEmitida,
  PedidoCobranca,
} from '../../src/modules/cobranca/domain/billing-provider.port';
import {
  prisma,
  limparDados,
  semearCliente,
  semearOrganizacao,
  semearProcesso,
  encerrar,
} from './ambiente';

/* ConfigService mínimo: devolve sempre o default, então valem
   COBRANCA_DIAS_VENCIMENTO=10 e COBRANCA_CARENCIA_DIAS=5. */
const config = { get: (_chave: string, padrao?: unknown) => padrao } as never;

/* O motor de distribuição REAL, não um dublê: desde que pagar passou a
   entregar, o acoplamento entre os dois é parte do comportamento que estes
   testes existem para proteger. Com a base vazia ele simplesmente não gera
   lote — inofensivo para os casos que não falam de entrega. */
const distribuicao = new DistribuicaoService(prisma as never);
const criarCobranca = (provider: unknown) =>
  new CobrancaService(prisma as never, config, provider as never, distribuicao);

const cobranca = criarCobranca(new ManualProvider());

async function assinar(organizationId: string, preco: number, intervaloMeses = 1) {
  const plano = await prisma.plano.create({
    data: {
      nome: `Plano ${Math.random().toString(36).slice(2, 8)}`,
      processosPorCiclo: 250,
      preco,
      intervaloMeses,
    },
    select: { id: true },
  });
  await prisma.assinatura.create({
    data: { organizationId, planoId: plano.id, status: 'ATIVA' },
  });
}

const assinaturaDe = (organizationId: string) =>
  prisma.assinatura.findUniqueOrThrow({
    where: { organizationId },
    select: { status: true, inadimplenteDesde: true },
  });

const emDias = (base: Date, dias: number) => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + dias);
  return d;
};

/** Gateway de mentira: PRODUZ id externo (o MANUAL não) e falha sob comando. */
class GatewayFalso implements BillingProvider {
  readonly nome = 'FALSO';
  falharAgora = false;
  cobrancasEmitidas = 0;
  ultimoVencimento: Date | null = null;

  async registrarCliente(): Promise<string | null> {
    return 'cus_falso';
  }

  async emitirCobranca(pedido: PedidoCobranca): Promise<CobrancaEmitida> {
    this.ultimoVencimento = pedido.vencimentoEm;
    if (this.falharAgora) {
      this.falharAgora = false;
      /* A mensagem literal que o Asaas devolveu em produção. */
      throw new Error('Asaas (400): Não é permitido data de vencimento inferior a hoje.');
    }
    this.cobrancasEmitidas += 1;
    return {
      idExterno: `pay_${this.cobrancasEmitidas}`,
      urlPagamento: `https://exemplo.invalido/${this.cobrancasEmitidas}`,
    };
  }

  async cancelarCobranca(): Promise<void> {}
  verificarWebhook(): boolean {
    return true;
  }
  interpretarEvento(): null {
    return null;
  }
}

const comGateway = (g: GatewayFalso) =>
  criarCobranca(g);

describe('Cobrança — o ciclo de vida do dinheiro', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('emite uma fatura por competência — repetir não duplica', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);

    const primeira = await cobranca.emitirFatura({ organizationId: c.org.id });
    const segunda = await cobranca.emitirFatura({ organizationId: c.org.id });

    expect(primeira.emitida).toBe(true);
    expect(primeira.valor).toBe('1990.00');
    expect(segunda.emitida).toBe(false);
    expect(segunda.motivo).toMatch(/já existe/);
    expect(await prisma.fatura.count()).toBe(1);
  });

  /**
   * A régua inteira num teste: vencer não é suspender. Entre um e outro existe a
   * carência — e é ela que separa "esqueceu o boleto" de "parou de pagar".
   */
  it('vence, inadimple e só suspende depois da carência', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });
    const vencimento = new Date(`${f.vencimentoEm}T00:00:00.000Z`);

    /* No próprio dia do vencimento ainda está em dia. */
    await cobranca.processarVencimentos(vencimento);
    expect((await assinaturaDe(c.org.id)).status).toBe('ATIVA');

    /* Um dia depois: fatura vencida, assinatura inadimplente — mas o cliente
       AINDA acessa. É a carência. */
    await cobranca.processarVencimentos(emDias(vencimento, 1));
    expect((await assinaturaDe(c.org.id)).status).toBe('INADIMPLENTE');
    expect(await prisma.fatura.count({ where: { status: 'VENCIDA' } })).toBe(1);

    /* Passados os 5 dias de tolerância: suspensa. */
    await cobranca.processarVencimentos(emDias(vencimento, 7));
    expect((await assinaturaDe(c.org.id)).status).toBe('SUSPENSA');
  });

  it('o pagamento tira a assinatura da inadimplência e zera o marco', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });
    await cobranca.processarVencimentos(emDias(new Date(`${f.vencimentoEm}T00:00:00.000Z`), 1));
    expect((await assinaturaDe(c.org.id)).status).toBe('INADIMPLENTE');

    const r = await cobranca.registrarPagamento(f.faturaId!);

    expect(r.alterado).toBe(true);
    const depois = await assinaturaDe(c.org.id);
    expect(depois.status).toBe('ATIVA');
    /* Zerar o marco importa: senão a carência da PRÓXIMA inadimplência começaria
       contando desta, e o cliente seria suspenso no primeiro dia de atraso. */
    expect(depois.inadimplenteDesde).toBeNull();
  });

  it('dar baixa duas vezes não mexe na data do primeiro pagamento', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 100);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });

    await cobranca.registrarPagamento(f.faturaId!, new Date('2026-07-10T12:00:00.000Z'));
    const segunda = await cobranca.registrarPagamento(f.faturaId!);

    expect(segunda.alterado).toBe(false);
    const fatura = await prisma.fatura.findUniqueOrThrow({
      where: { id: f.faturaId! },
      select: { pagoEm: true },
    });
    expect(fatura.pagoEm?.toISOString()).toBe('2026-07-10T12:00:00.000Z');
  });

  /**
   * Cancelamento é DECISÃO, não consequência. Um pagamento avulso caindo depois
   * não pode ressuscitar o acesso — devolver o dinheiro é melhor do que religar
   * uma assinatura que alguém encerrou.
   */
  it('pagamento não ressuscita assinatura CANCELADA', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 100);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });
    await prisma.assinatura.update({
      where: { organizationId: c.org.id },
      data: { status: 'CANCELADA' },
    });

    await cobranca.registrarPagamento(f.faturaId!);

    expect((await assinaturaDe(c.org.id)).status).toBe('CANCELADA');
  });

  it('assinatura cancelada não recebe fatura nova', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 100);
    await prisma.assinatura.update({
      where: { organizationId: c.org.id },
      data: { status: 'CANCELADA' },
    });

    const r = await cobranca.emitirFatura({ organizationId: c.org.id });

    expect(r.emitida).toBe(false);
    expect(r.motivo).toMatch(/cancelada/);
    expect(await prisma.fatura.count()).toBe(0);
  });

  // ── Achados da auditoria de segurança ──

  /**
   * O bloqueador nº 5 da auditoria.
   *
   * `reavaliarAssinatura` marcava INADIMPLENTE sem carimbar `inadimplenteDesde`,
   * e a query de suspensão filtra por esse campo — NULL nunca é TRUE em SQL.
   * Como o caminho que produz esse estado é o webhook (o caminho NORMAL com
   * gateway ligado), a suspensão por inadimplência simplesmente não acontecia:
   * estado absorvente, cliente inadimplente com acesso vitalício.
   */
  it('inadimplência vinda do webhook carimba o marco e chega a suspender', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });

    /* Simula o efeito do PAYMENT_OVERDUE: a fatura vence e o serviço reavalia,
       sem passar pelo cron. */
    await prisma.fatura.update({ where: { id: f.faturaId! }, data: { status: 'VENCIDA' } });
    await cobranca.registrarPagamento(f.faturaId!).catch(() => undefined); // no-op proposital
    await prisma.fatura.update({ where: { id: f.faturaId! }, data: { status: 'VENCIDA', pagoEm: null } });

    /* Força o caminho do webhook: reavaliar sem o cron. */
    const dep = await assinaturaDe(c.org.id);
    expect(dep.status).toBe('ATIVA'); // ainda não reavaliada

    await cobranca.processarVencimentos(new Date(`${f.vencimentoEm}T00:00:00.000Z`));
    const depois = await assinaturaDe(c.org.id);
    expect(depois.status).toBe('INADIMPLENTE');
    /* O marco existe — é ele que faz a carência correr. */
    expect(depois.inadimplenteDesde).not.toBeNull();

    /* E passada a carência, suspende de verdade. */
    await cobranca.processarVencimentos(emDias(new Date(`${f.vencimentoEm}T00:00:00.000Z`), 10));
    expect((await assinaturaDe(c.org.id)).status).toBe('SUSPENSA');
  });

  /**
   * O caminho do WEBHOOK, que é onde o bug realmente morava.
   *
   * ⚠ Este teste existe porque o primeiro que escrevi NÃO pegava a falha: ele
   * passava por `processarVencimentos`, que carimba o marco por conta própria.
   * O bug estava em `reavaliarAssinatura` — chamada pelo webhook e por
   * `registrarPagamento`, sem passar pelo cron. Com `COBRANCA_AGENDADA_ATIVA`
   * desligado por padrão, esse é o ÚNICO caminho em produção, e ninguém
   * repararia o NULL depois.
   *
   * Cenário: duas faturas vencidas, uma é paga. Sobra dívida, então a assinatura
   * segue INADIMPLENTE — e precisa sair daqui com o marco carimbado.
   */
  it('reavaliar (caminho do webhook) carimba o marco sem depender do cron', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const jul = await cobranca.emitirFatura({
      organizationId: c.org.id,
      competencia: new Date('2026-07-10T00:00:00.000Z'),
    });
    const ago = await cobranca.emitirFatura({
      organizationId: c.org.id,
      competencia: new Date('2026-08-10T00:00:00.000Z'),
    });

    await prisma.fatura.updateMany({
      where: { id: { in: [jul.faturaId!, ago.faturaId!] } },
      data: { status: 'VENCIDA' },
    });
    /* Estado limpo, como o webhook o encontraria. */
    await prisma.assinatura.update({
      where: { organizationId: c.org.id },
      data: { status: 'ATIVA', inadimplenteDesde: null },
    });

    /* Paga UMA. `registrarPagamento` chama `reavaliarAssinatura` — sobra a outra
       vencida, então o resultado é INADIMPLENTE. */
    await cobranca.registrarPagamento(jul.faturaId!);

    const a = await assinaturaDe(c.org.id);
    expect(a.status).toBe('INADIMPLENTE');
    /* Sem o carimbo aqui, a carência nunca corre e a suspensão nunca chega. */
    expect(a.inadimplenteDesde).not.toBeNull();
  });

  /**
   * Autocura: linhas que já estão INADIMPLENTE com marco NULL — produzidas pelo
   * webhook antes da correção — ficavam presas para sempre, porque o `continue`
   * pulava justamente quem precisava do reparo.
   */
  it('assinatura já inadimplente sem marco é reparada pelo cron', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });

    /* O estado doente, exatamente como o bug o produzia. */
    await prisma.fatura.update({ where: { id: f.faturaId! }, data: { status: 'VENCIDA' } });
    await prisma.assinatura.update({
      where: { organizationId: c.org.id },
      data: { status: 'INADIMPLENTE', inadimplenteDesde: null },
    });

    await cobranca.processarVencimentos();

    expect((await assinaturaDe(c.org.id)).inadimplenteDesde).not.toBeNull();
  });

  /**
   * Chargeback mensal = serviço gratuito indefinido. Contar só VENCIDA fazia o
   * estorno devolver a assinatura para ATIVA — e o cliente seguia recebendo um
   * bloco novo de dados pessoais a cada ciclo.
   */
  it('estorno NÃO reativa a assinatura e limpa a data de pagamento', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });
    await cobranca.registrarPagamento(f.faturaId!);
    expect((await assinaturaDe(c.org.id)).status).toBe('ATIVA');

    /* O que o webhook PAYMENT_REFUNDED faz. */
    await prisma.fatura.update({
      where: { id: f.faturaId! },
      data: { status: 'ESTORNADA', pagoEm: null },
    });
    await cobranca.processarVencimentos();

    const depois = await assinaturaDe(c.org.id);
    expect(depois.status).toBe('INADIMPLENTE');
    expect(depois.inadimplenteDesde).not.toBeNull();

    const fatura = await prisma.fatura.findUniqueOrThrow({
      where: { id: f.faturaId! },
      select: { pagoEm: true },
    });
    /* Sem isto a tela do cliente continuaria dizendo "Paga em ...". */
    expect(fatura.pagoEm).toBeNull();
  });

  // ── Cancelamento ──

  /**
   * `CANCELADA` era lida em três pontos e escrita em nenhum: não havia como
   * encerrar um contrato pela aplicação.
   */
  it('cancelar encerra a assinatura, cancela as faturas abertas e preserva os dados', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });

    const r = await cobranca.cancelarAssinatura(c.org.id, 'pedido do cliente');

    expect(r.cancelada).toBe(true);
    expect(r.faturasCanceladas).toBe(1);
    const a = await prisma.assinatura.findUniqueOrThrow({
      where: { organizationId: c.org.id },
      select: { status: true, canceladaEm: true, proximaRenovacaoEm: true },
    });
    expect(a.status).toBe('CANCELADA');
    expect(a.canceladaEm).not.toBeNull();
    expect(a.proximaRenovacaoEm).toBeNull();
    expect(
      (await prisma.fatura.findUniqueOrThrow({ where: { id: f.faturaId! }, select: { status: true } }))
        .status,
    ).toBe('CANCELADA');
    /* Cancelamento não é exclusão: o usuário do cliente continua existindo. */
    expect(await prisma.user.count({ where: { organizationId: c.org.id } })).toBe(1);
  });

  it('dívida vencida sobrevive ao cancelamento', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    const f = await cobranca.emitirFatura({ organizationId: c.org.id });
    await prisma.fatura.update({ where: { id: f.faturaId! }, data: { status: 'VENCIDA' } });

    await cobranca.cancelarAssinatura(c.org.id);

    /* VENCIDA não vira CANCELADA: quem saiu devendo continua devendo. */
    expect(
      (await prisma.fatura.findUniqueOrThrow({ where: { id: f.faturaId! }, select: { status: true } }))
        .status,
    ).toBe('VENCIDA');
  });

  it('cancelar duas vezes é inofensivo', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 100);
    await cobranca.cancelarAssinatura(c.org.id);
    const segunda = await cobranca.cancelarAssinatura(c.org.id);
    expect(segunda.cancelada).toBe(false);
  });

  /**
   * A trava que impede a URL pública de virar um "marque como pago" aberto ao
   * mundo enquanto nenhum gateway está configurado.
   */
  it('no provedor manual, nenhum webhook é aceito', async () => {
    await expect(cobranca.receberEvento('{}', {}, { evento: 'PAYMENT_RECEIVED' })).rejects.toThrow(
      /não autenticado/i,
    );
    expect(await prisma.eventoCobranca.count()).toBe(0);
  });

  it('a visão do cliente não expõe nada do gateway', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 1990);
    await cobranca.emitirFatura({ organizationId: c.org.id });

    const vista = await cobranca.minhaAssinatura(c.org.id);

    expect(vista.status).toBe('ATIVA');
    expect(vista.faturas).toHaveLength(1);
    /* Ids do gateway e nome do provedor são infraestrutura — o cliente paga a
       Leão Amorim, não conhece os trilhos. */
    const cru = JSON.stringify(vista);
    expect(cru).not.toMatch(/clienteExternoId|assinaturaExternaId|provedorCobranca/);
  });

  /**
   * ── A CONFERÊNCIA DE VALOR NO WEBHOOK ──
   *
   * Antes, "pagou" bastava e QUANTO não importava: um pagamento parcial dava
   * baixa na fatura inteira e liberava a assinatura. O rombo só apareceria na
   * conciliação, meses depois, com o cliente já tendo recebido lotes.
   *
   * O provedor manual recusa todo webhook (é o que impede a rota pública de
   * virar um "marque como pago" aberto), então aqui entra um dublê que aceita —
   * é a única forma de exercitar o caminho que o gateway real percorre.
   */
  describe('valor do pagamento', () => {
    /** Provedor de teste: assina tudo e devolve o valor que o caso quiser. */
    const provedorQueAceita = (valorPago?: number) =>
      ({
        nome: 'teste',
        verificarWebhook: () => true,
        interpretarEvento: (p: { idEvento: string; cobranca: string }) => ({
          idExterno: p.idEvento,
          tipo: 'PAGAMENTO_CONFIRMADO' as const,
          cobrancaExternaId: p.cobranca,
          pagoEm: new Date(),
          ...(valorPago === undefined ? {} : { valorPago }),
        }),
        registrarCliente: async () => null,
        emitirCobranca: async () => ({ idExterno: null, urlPagamento: null }),
        cancelarCobranca: async () => {},
      }) as never;

    /** Cria cliente + assinatura + fatura já ligada a uma cobrança externa. */
    async function cenario(preco: number) {
      const c = await semearCliente();
      await assinar(c.org.id, preco);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });
      const idExterno = `cob_${Math.random().toString(36).slice(2, 10)}`;
      await prisma.fatura.update({ where: { id: f.faturaId! }, data: { idExterno } });
      return { org: c.org, faturaId: f.faturaId!, idExterno };
    }

    const enviar = async (valorPago: number | undefined, cobrancaId: string, idEvento: string) => {
      const servico = criarCobranca(provedorQueAceita(valorPago));
      return servico.receberEvento('{}', {}, { idEvento, cobranca: cobrancaId });
    };

    it('pagamento a MENOR não dá baixa: a fatura fica em aberto', async () => {
      const { faturaId, idExterno } = await cenario(1990);

      const r = await enviar(1.0, idExterno, 'ev-menor');

      expect(r.aplicado).toBe(false);
      expect(r.motivo).toMatch(/pagamento a menor/);

      const fatura = await prisma.fatura.findUniqueOrThrow({
        where: { id: faturaId },
        select: { status: true, pagoEm: true },
      });
      /* O ponto do teste: a assinatura NÃO foi liberada por R$ 1,00. */
      expect(fatura.status).not.toBe('PAGA');
      expect(fatura.pagoEm).toBeNull();

      /* E o porquê fica na trilha de cobrança, não só no log — log rotaciona. */
      const evento = await prisma.eventoCobranca.findUniqueOrThrow({
        where: { idExterno: 'ev-menor' },
        select: { erro: true, processadoEm: true },
      });
      expect(evento.erro).toMatch(/pagamento a menor/);
      expect(evento.processadoEm).not.toBeNull();
    });

    it('valor exato dá baixa normalmente', async () => {
      const { faturaId, idExterno } = await cenario(1990);

      const r = await enviar(1990.0, idExterno, 'ev-exato');

      expect(r.aplicado).toBe(true);
      const fatura = await prisma.fatura.findUniqueOrThrow({
        where: { id: faturaId },
        select: { status: true, pagoEm: true },
      });
      expect(fatura.status).toBe('PAGA');
      expect(fatura.pagoEm).not.toBeNull();
    });

    it('pagamento a MAIOR dá baixa, com a diferença registrada no evento', async () => {
      /* Quem pagou mais não pode ficar sem acesso — receber a diferença de
         volta é conversa com o financeiro, não motivo para bloquear a conta. */
      const { faturaId, idExterno } = await cenario(1990);

      const r = await enviar(2500.0, idExterno, 'ev-maior');

      expect(r.aplicado).toBe(true);
      expect(
        (await prisma.fatura.findUniqueOrThrow({ where: { id: faturaId }, select: { status: true } }))
          .status,
      ).toBe('PAGA');
      const evento = await prisma.eventoCobranca.findUniqueOrThrow({
        where: { idExterno: 'ev-maior' },
        select: { erro: true },
      });
      expect(evento.erro).toMatch(/pagamento a maior/);
    });

    it('provedor que não informa valor: dá baixa, mas registra a falta de conferência', async () => {
      const { faturaId, idExterno } = await cenario(1990);

      const r = await enviar(undefined, idExterno, 'ev-sem-valor');

      expect(r.aplicado).toBe(true);
      expect(
        (await prisma.fatura.findUniqueOrThrow({ where: { id: faturaId }, select: { status: true } }))
          .status,
      ).toBe('PAGA');
      const evento = await prisma.eventoCobranca.findUniqueOrThrow({
        where: { idExterno: 'ev-sem-valor' },
        select: { erro: true },
      });
      /* Não vira um "conferido" que não houve. */
      expect(evento.erro).toMatch(/sem conferência/);
    });
  });

  /**
   * O primeiro cadastro real do site morreu aqui, e os dois defeitos estavam
   * encadeados: o vencimento nascia no passado e o gateway recusava; a fatura
   * meio-emitida ficava para trás; e a trava de idempotência devolvia "já
   * existe" para sempre, sem nunca voltar ao gateway. Conta criada, sem link de
   * pagamento, sem saída.
   */
  describe('emissão fora do começo do mês, e a retomada do que ficou pela metade', () => {

    const soDia = (d: Date) => d.toISOString().slice(0, 10);

    it('emitida no dia 16, a fatura NÃO vence no passado', async () => {
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();

      const hoje = new Date(Date.UTC(2026, 7, 16)); // 16/08/2026
      const r = await comGateway(g).emitirFatura({ organizationId: c.org.id, hoje });

      expect(r.emitida).toBe(true);
      /* hoje + 10 dias. Antes saía 2026-08-11 — cinco dias ATRÁS. */
      expect(r.vencimentoEm).toBe('2026-08-26');
      expect(soDia(g.ultimoVencimento!)).toBe('2026-08-26');
    });

    it('emitida no dia 1º, o vencimento é o de sempre — o cron não mudou', async () => {
      /* A metade que não podia quebrar: se o máximo tivesse mudado o caso do
         cron, o conserto teria trocado um defeito por outro. */
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();

      const hoje = new Date(Date.UTC(2026, 7, 1));
      const r = await comGateway(g).emitirFatura({ organizationId: c.org.id, hoje });

      expect(r.vencimentoEm).toBe('2026-08-11'); // competência + 10
    });

    it('gateway falhou: a fatura fica ABERTA, sem id externo e sem link', async () => {
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();
      g.falharAgora = true;

      await expect(
        comGateway(g).emitirFatura({ organizationId: c.org.id }),
      ).rejects.toThrow(/vencimento inferior a hoje/);

      const f = await prisma.fatura.findFirstOrThrow({
        select: { status: true, idExterno: true, urlPagamento: true },
      });
      expect(f.status).toBe('ABERTA');
      expect(f.idExterno).toBeNull();
      expect(f.urlPagamento).toBeNull();
    });

    it('a chamada seguinte RETOMA: volta ao gateway e completa a MESMA fatura', async () => {
      /* O coração do conserto. Antes, esta segunda chamada devolvia
         "já existe" e o cliente ficava preso para sempre. */
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();
      const servico = comGateway(g);

      g.falharAgora = true;
      await expect(servico.emitirFatura({ organizationId: c.org.id })).rejects.toThrow();
      const idOrfa = (await prisma.fatura.findFirstOrThrow({ select: { id: true } })).id;

      const r = await servico.emitirFatura({ organizationId: c.org.id });

      expect(r.emitida).toBe(true);
      expect(r.faturaId).toBe(idOrfa); // a MESMA linha, não uma segunda
      expect(await prisma.fatura.count()).toBe(1);
      expect(g.cobrancasEmitidas).toBe(1);

      const f = await prisma.fatura.findUniqueOrThrow({
        where: { id: idOrfa },
        select: { idExterno: true, urlPagamento: true },
      });
      expect(f.idExterno).toBe('pay_1');
      expect(f.urlPagamento).toMatch(/exemplo\.invalido/);
    });

    it('retomar CORRIGE o vencimento vencido que causou a falha', async () => {
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();
      const servico = comGateway(g);
      const hoje = new Date(Date.UTC(2026, 7, 16));

      g.falharAgora = true;
      await expect(servico.emitirFatura({ organizationId: c.org.id, hoje })).rejects.toThrow();
      const r = await servico.emitirFatura({ organizationId: c.org.id, hoje });

      /* Reaproveitar a linha sem corrigir a data reproduziria a falha original. */
      expect(r.vencimentoEm).toBe('2026-08-26');
    });

    it('fatura já COMPLETA continua intocada — a idempotência não foi afrouxada', async () => {
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();
      const servico = comGateway(g);

      await servico.emitirFatura({ organizationId: c.org.id });
      const segunda = await servico.emitirFatura({ organizationId: c.org.id });

      expect(segunda.emitida).toBe(false);
      expect(segunda.motivo).toMatch(/já existe/);
      expect(g.cobrancasEmitidas).toBe(1); // NÃO chamou o gateway de novo
    });

    it('fatura PAGA sem id externo NÃO é retomada', async () => {
      /* O caso perigoso: dinheiro já entrou. Emitir cobrança nova por cima
         cobraria o cliente duas vezes pelo mesmo mês. */
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const g = new GatewayFalso();
      const servico = comGateway(g);

      g.falharAgora = true;
      await expect(servico.emitirFatura({ organizationId: c.org.id })).rejects.toThrow();
      const orfa = await prisma.fatura.findFirstOrThrow({ select: { id: true } });
      await prisma.fatura.update({ where: { id: orfa.id }, data: { status: 'PAGA' } });

      const r = await servico.emitirFatura({ organizationId: c.org.id });

      expect(r.emitida).toBe(false);
      expect(g.cobrancasEmitidas).toBe(0);
    });

    it('no provedor MANUAL, id externo nulo é normal e NÃO dispara retomada', async () => {
      /* A armadilha da condição ingênua: no manual TODA fatura tem idExterno
         nulo por definição. "Nulo = incompleta" faria o manual re-emitir a
         mesma fatura em toda chamada, destruindo a idempotência. */
      const c = await semearCliente();
      await assinar(c.org.id, 799);

      const primeira = await cobranca.emitirFatura({ organizationId: c.org.id });
      const segunda = await cobranca.emitirFatura({ organizationId: c.org.id });

      expect(primeira.emitida).toBe(true);
      expect(segunda.emitida).toBe(false);
      expect(segunda.motivo).toMatch(/já existe/);
      expect(await prisma.fatura.count()).toBe(1);
    });
  });

  /**
   * Pagou, recebe.
   *
   * Antes disto, pagar só tirava o 402 da frente: a assinatura virava ATIVA, o
   * painel abria e a carteira continuava VAZIA até alguém rodar a distribuição
   * à mão. O cliente pagava, entrava e não via nada — foi exatamente o que
   * aconteceu com o primeiro cliente real.
   */
  describe('pagar dispara a entrega', () => {
    /** Cria a org INTERNA dona da base e `quantos` processos disponíveis. */
    async function semearBase(quantos: number) {
      const interna = await semearOrganizacao(`Base ${Math.random().toString(36).slice(2, 8)}`);
      for (let i = 0; i < quantos; i++) {
        await semearProcesso({ organizationId: interna.org.id });
      }
      return interna;
    }

    /** Quantos processos a carteira DESTE cliente enxerga. */
    const naCarteira = (organizationId: string) =>
      prisma.processoLiberado.count({ where: { organizationId } });

    /**
     * `inicioEm` é datado para trás de propósito nos casos de dois ciclos.
     *
     * O motor RECUSA competência anterior ao início da assinatura — ninguém
     * recebe ciclo de antes de ter assinado, e essa recusa é correta. Sem
     * recuar o início, o teste de acumulação pediria julho a uma assinatura
     * nascida em agosto e receberia zero, medindo a trava em vez da regra.
     */
    async function assinarCom(
      organizationId: string,
      porCiclo: number,
      inicioEm?: Date,
      intervaloMeses = 1,
    ) {
      const plano = await prisma.plano.create({
        data: {
          nome: `Plano ${Math.random().toString(36).slice(2, 8)}`,
          processosPorCiclo: porCiclo,
          preco: 799,
          intervaloMeses,
        },
        select: { id: true },
      });
      await prisma.assinatura.create({
        data: {
          organizationId,
          planoId: plano.id,
          status: 'PENDENTE',
          ...(inicioEm ? { inicioEm } : {}),
        },
      });
    }

    /**
     * ⚠ O CONTRATO DO PLANO ANUAL, inteiro num caso.
     *
     * Paga UMA vez e recebe TODO MÊS. As duas cadências são independentes:
     * `pagoAte` cala a cobrança por 12 meses; `proximaRenovacaoEm` anda de 1 em
     * 1 mês e mantém a entrega viva. A versão anterior somava o intervalo do
     * PLANO na renovação da entrega — o cliente anual receberia UMA entrega no
     * ano, o oposto exato do que foi vendido.
     */
    it('plano ANUAL: paga uma vez, recebe todo mês — e sem fatura nova no meio', async () => {
      await semearBase(12);
      const c = await semearCliente();
      /* Tudo no PASSADO: `gerarLote` recusa competência futura (e recusa
         CERTO — antecipar entrega é dar cota que ainda não chegou). Janeiro
         pago, fevereiro entregue: o mesmo contrato, datas que já existiram. */
      await assinarCom(c.org.id, 5, new Date(Date.UTC(2025, 11, 1)), 12);

      const ago = await cobranca.emitirFatura({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 0, 1)),
      });
      await cobranca.registrarPagamento(ago.faturaId!);
      expect(await naCarteira(c.org.id)).toBe(5);

      const a = await prisma.assinatura.findUniqueOrThrow({
        where: { organizationId: c.org.id },
        select: { proximaRenovacaoEm: true, pagoAte: true },
      });
      /* A ENTREGA anda 1 mês; o DINHEIRO cobre 12. É o par que define o anual. */
      expect(a.proximaRenovacaoEm?.toISOString().slice(0, 10)).toBe('2026-02-01');
      expect(a.pagoAte?.toISOString().slice(0, 10)).toBe('2027-01-01');

      /* Fevereiro: NENHUMA fatura nova (o ciclo está pago até jan/2027)... */
      const r = await cobranca.emitirFatura({
        organizationId: c.org.id,
        hoje: new Date(Date.UTC(2026, 1, 2)),
      });
      expect(r.emitida).toBe(false);
      expect(r.motivo).toBe('ciclo já pago');

      /* ...e a entrega de FEVEREIRO sai, sem pagamento novo — é o produto. */
      const lote = await distribuicao.gerarLote({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 1, 1)),
      });
      expect(lote.gerado).toBe(true);
      expect(await naCarteira(c.org.id)).toBe(10);
    });

    it('a baixa do pagamento libera o lote do ciclo, sem ninguém pedir', async () => {
      await semearBase(7);
      const c = await semearCliente();
      await assinarCom(c.org.id, 5);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });

      expect(await naCarteira(c.org.id)).toBe(0); // antes de pagar, nada

      await cobranca.registrarPagamento(f.faturaId!);

      expect((await assinaturaDe(c.org.id)).status).toBe('ATIVA');
      expect(await naCarteira(c.org.id)).toBe(5);
    });

    it('o ciclo seguinte SOMA e nunca repete o que o cliente já tem', async () => {
      /* A regra de negócio inteira num caso: 5 no primeiro ciclo, 10 no segundo,
         e nenhum processo aparecendo duas vezes. */
      await semearBase(12);
      const c = await semearCliente();
      await assinarCom(c.org.id, 5, new Date(Date.UTC(2026, 5, 1)));

      const jul = await cobranca.emitirFatura({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 6, 1)),
      });
      await cobranca.registrarPagamento(jul.faturaId!);
      const aposPrimeiro = await prisma.processoLiberado.findMany({
        where: { organizationId: c.org.id },
        select: { processoId: true },
      });

      const ago = await cobranca.emitirFatura({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 7, 1)),
      });
      await cobranca.registrarPagamento(ago.faturaId!);
      const apósSegundo = await prisma.processoLiberado.findMany({
        where: { organizationId: c.org.id },
        select: { processoId: true },
      });

      expect(aposPrimeiro).toHaveLength(5);
      expect(apósSegundo).toHaveLength(10); // ACUMULOU, não substituiu
      /* Nunca repetidos: 10 liberações, 10 processos distintos. */
      expect(new Set(apósSegundo.map((p) => p.processoId)).size).toBe(10);
    });

    it('reenvio do webhook não entrega duas vezes', async () => {
      /* A fila do Asaas reenvia o que não recebeu 200. A trava é a idempotência
         da própria baixa: a segunda passagem sai antes de chegar na entrega. */
      await semearBase(9);
      const c = await semearCliente();
      await assinarCom(c.org.id, 4);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });

      await cobranca.registrarPagamento(f.faturaId!);
      await cobranca.registrarPagamento(f.faturaId!);

      expect(await naCarteira(c.org.id)).toBe(4);
      expect(await prisma.loteAssinatura.count()).toBe(1);
    });

    it('entrega que FALHA não desfaz o pagamento', async () => {
      /* A regra que protege o dinheiro: entre "carteira vazia, conserta-se" e
         "pagamento sem baixa", a primeira é sempre melhor. Se o erro
         propagasse, o webhook responderia != 200, o Asaas reenviaria e o evento
         acabaria penalizado. */
      await semearBase(3);
      const c = await semearCliente();
      await assinarCom(c.org.id, 2);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });

      const motorQuebrado = {
        gerarLote: async () => {
          throw new Error('motor de distribuição fora do ar');
        },
      };
      const servico = new CobrancaService(
        prisma as never,
        config,
        new ManualProvider() as never,
        motorQuebrado as never,
      );

      const r = await servico.registrarPagamento(f.faturaId!);

      expect(r.alterado).toBe(true);
      expect(r.status).toBe('PAGA');
      expect((await assinaturaDe(c.org.id)).status).toBe('ATIVA');
      expect(await naCarteira(c.org.id)).toBe(0); // a entrega falhou, e tudo bem
    });

    it('base vazia não gera lote nem quebra o pagamento', async () => {
      /* O caso silencioso: sem processo nenhum na base, `gerarLote` devolve
         gerado:false SEM erro. O pagamento tem de seguir válido. */
      const c = await semearCliente();
      await assinarCom(c.org.id, 250);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });

      const r = await cobranca.registrarPagamento(f.faturaId!);

      expect(r.status).toBe('PAGA');
      expect((await assinaturaDe(c.org.id)).status).toBe('ATIVA');
      expect(await naCarteira(c.org.id)).toBe(0);
    });

    it('a fatura órfã sai marcada como RETOMÁVEL para a tela do cliente', async () => {
      /* O sinal que a tela usa para parar de dizer "não é preciso fazer nada".
         É booleano de PRODUTO: a resposta do cliente não expõe idExterno. */
      await semearBase(3);
      const c = await semearCliente();
      await assinarCom(c.org.id, 2);
      const g = new GatewayFalso();
      const servico = comGateway(g);

      g.falharAgora = true;
      await expect(servico.emitirFatura({ organizationId: c.org.id })).rejects.toThrow();

      const vista = await servico.minhaAssinatura(c.org.id);

      expect(vista.faturas).toHaveLength(1);
      expect(vista.faturas[0].retomavel).toBe(true);
      /* O id do gateway NÃO pode vazar para o cliente. */
      expect(vista.faturas[0]).not.toHaveProperty('idExterno');
    });

    it('fatura COMPLETA não é retomável — o botão não deve aparecer', async () => {
      await semearBase(3);
      const c = await semearCliente();
      await assinarCom(c.org.id, 2);
      const servico = comGateway(new GatewayFalso());

      await servico.emitirFatura({ organizationId: c.org.id });

      const vista = await servico.minhaAssinatura(c.org.id);
      expect(vista.faturas[0].retomavel).toBe(false);
    });

    it('no provedor MANUAL nada é retomável — não há gateway para retomar', async () => {
      /* A armadilha: no manual TODA fatura tem idExterno nulo. Sem olhar o
         provedor, a tela ofereceria "gerar cobrança" a quem paga por PIX na
         mão, e o botão não faria nada. */
      const c = await semearCliente();
      await assinarCom(c.org.id, 2);
      await cobranca.emitirFatura({ organizationId: c.org.id });

      const vista = await cobranca.minhaAssinatura(c.org.id);

      expect(vista.faturas[0].urlPagamento).toBeNull();
      expect(vista.faturas[0].retomavel).toBe(false);
    });

    it('retomar pela mão do cliente completa a MESMA fatura', async () => {
      /* O que a rota nova faz: chama o mesmo emitirFatura, sem regra nova. */
      await semearBase(4);
      const c = await semearCliente();
      await assinarCom(c.org.id, 2);
      const g = new GatewayFalso();
      const servico = comGateway(g);

      g.falharAgora = true;
      await expect(servico.emitirFatura({ organizationId: c.org.id })).rejects.toThrow();
      const antes = await servico.minhaAssinatura(c.org.id);
      expect(antes.faturas[0].retomavel).toBe(true);

      await servico.emitirFatura({ organizationId: c.org.id });

      const depois = await servico.minhaAssinatura(c.org.id);
      expect(depois.faturas).toHaveLength(1); // a MESMA linha
      expect(depois.faturas[0].retomavel).toBe(false);
      expect(depois.faturas[0].urlPagamento).toMatch(/exemplo\.invalido/);
    });

    it('pagar UMA fatura com outra vencida NÃO entrega — segue inadimplente', async () => {
      /* A alavanca comercial: quem tem dívida em aberto não recebe bloco novo de
         dados pessoais. Reter PII de inadimplente é problema de LGPD antes de
         ser de receita.

         ⚠ Quem faz cumprir isto é o MOTOR (`gerarLote` recusa assinatura
         não-ATIVA), e não o `if` do serviço de cobrança — confirmado por
         mutação: forçar aquele `if` a `true` mantém este teste verde. O caso
         segue valendo pelo comportamento de ponta a ponta, mas não credite a
         ele a cobertura de uma trava que mora noutro arquivo. */
      await semearBase(6);
      const c = await semearCliente();
      await assinarCom(c.org.id, 3, new Date(Date.UTC(2026, 5, 1)));

      const jul = await cobranca.emitirFatura({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 6, 1)),
      });
      const ago = await cobranca.emitirFatura({
        organizationId: c.org.id,
        competencia: new Date(Date.UTC(2026, 7, 1)),
      });
      await prisma.fatura.update({ where: { id: jul.faturaId! }, data: { status: 'VENCIDA' } });

      await cobranca.registrarPagamento(ago.faturaId!);

      expect((await assinaturaDe(c.org.id)).status).toBe('INADIMPLENTE');
      expect(await naCarteira(c.org.id)).toBe(0);
    });
  });

  // ── Estorno não ressuscita ──

  /**
   * O GATILHO É O CARTÃO: no Asaas, o PAYMENT_RECEIVED do cartão chega ~32
   * dias depois do CONFIRMED (quando o dinheiro liquida). Se houve estorno no
   * meio, esse RECEIVED atrasado encontrava a fatura ESTORNADA e a ressuscitava
   * a PAGA — reabrindo o acesso de quem tomou o dinheiro de volta.
   */
  it('um pagamento atrasado NÃO ressuscita fatura estornada', async () => {
    const { org } = await semearCliente();
    await assinar(org.id, 799);
    const f = await cobranca.emitirFatura({ organizationId: org.id });

    await cobranca.registrarPagamento(f.faturaId!);
    await prisma.fatura.update({ where: { id: f.faturaId! }, data: { status: 'ESTORNADA' } });

    const r = await cobranca.registrarPagamento(f.faturaId!);
    expect(r).toEqual({ alterado: false, status: 'ESTORNADA' });

    const depois = await prisma.fatura.findUniqueOrThrow({
      where: { id: f.faturaId! },
      select: { status: true },
    });
    expect(depois.status).toBe('ESTORNADA');
  });

  /**
   * ── A COBRANÇA SOME (OU VOLTA) PELO PAINEL DO GATEWAY ──
   *
   * PAYMENT_DELETED e PAYMENT_RESTORED caíam no "evento ignorado". O efeito era
   * uma fatura ABERTA para sempre: o cliente via um botão "Pagar" apontando
   * para uma cobrança que não existe mais, e a régua suspendia a assinatura por
   * uma dívida que ninguém tinha como quitar.
   *
   * Aqui também se fixa a TABELA DE TRANSIÇÕES — que evento pode sair de que
   * estado. É ela que impede um evento atrasado de reescrever um estado mais
   * recente, num webhook entregue fora de ordem por desenho.
   */
  describe('cobrança removida e restaurada', () => {
    /** Dublê que despacha QUALQUER tipo de evento para uma cobrança externa. */
    const provedorQueDespacha = (tipo: string) =>
      ({
        nome: 'teste',
        verificarWebhook: () => true,
        interpretarEvento: (p: { idEvento: string; cobranca: string }) => ({
          idExterno: p.idEvento,
          tipo,
          cobrancaExternaId: p.cobranca,
        }),
        registrarCliente: async () => null,
        emitirCobranca: async () => ({ idExterno: null, urlPagamento: null }),
        cancelarCobranca: async () => {},
      }) as never;

    const enviar = (tipo: string, cobrancaId: string, idEvento: string) =>
      criarCobranca(provedorQueDespacha(tipo)).receberEvento(
        '{}',
        {},
        { idEvento, cobranca: cobrancaId },
      );

    const status = async (faturaId: string) =>
      (
        await prisma.fatura.findUniqueOrThrow({
          where: { id: faturaId },
          select: { status: true },
        })
      ).status;

    /** Cliente + assinatura + fatura já ligada a uma cobrança externa. */
    async function cenario() {
      const c = await semearCliente();
      await assinar(c.org.id, 799);
      const f = await cobranca.emitirFatura({ organizationId: c.org.id });
      const idExterno = `cob_${Math.random().toString(36).slice(2, 10)}`;
      await prisma.fatura.update({ where: { id: f.faturaId! }, data: { idExterno } });
      return { faturaId: f.faturaId!, idExterno };
    }

    it('cobrança apagada no painel CANCELA a fatura — ela não fica "Aberta" para sempre', async () => {
      const { faturaId, idExterno } = await cenario();

      const r = await enviar('COBRANCA_REMOVIDA', idExterno, `ev-del-${idExterno}`);

      expect(r.aplicado).toBe(true);
      expect(await status(faturaId)).toBe('CANCELADA');
    });

    it('restaurada volta para ABERTA — nunca direto para VENCIDA', async () => {
      const { faturaId, idExterno } = await cenario();
      await enviar('COBRANCA_REMOVIDA', idExterno, `ev-del2-${idExterno}`);

      const r = await enviar('COBRANCA_RESTAURADA', idExterno, `ev-res-${idExterno}`);

      expect(r.aplicado).toBe(true);
      /* ABERTA, e não VENCIDA: quem marca vencimento é processarVencimentos, e
         essa transição continua com um dono só. A fatura restaurada já nasce
         elegível para a próxima rodada dele. */
      expect(await status(faturaId)).toBe('ABERTA');
    });

    it('apagar a cobrança NÃO cancela fatura já PAGA — dinheiro que entrou não se desfaz lá fora', async () => {
      const { faturaId, idExterno } = await cenario();
      await cobranca.registrarPagamento(faturaId);
      expect(await status(faturaId)).toBe('PAGA');

      const r = await enviar('COBRANCA_REMOVIDA', idExterno, `ev-del3-${idExterno}`);

      expect(r.aplicado).toBe(false);
      expect(await status(faturaId)).toBe('PAGA');
    });

    /**
     * O DEFEITO QUE JÁ EXISTIA, e que a tabela de transições fecha de quebra.
     *
     * O UPDATE era cego: um PAYMENT_OVERDUE que chegasse DEPOIS do
     * PAYMENT_CONFIRMED marcava VENCIDA uma fatura já PAGA, e a régua suspendia
     * quem tinha pagado. Quem paga no próprio dia do vencimento dispara os dois
     * eventos com segundos de diferença, e o webhook está configurado como "não
     * sequencial" — ordem de chegada não é garantida.
     */
    it('PAYMENT_OVERDUE atrasado NÃO derruba um pagamento já confirmado', async () => {
      const { faturaId, idExterno } = await cenario();
      await cobranca.registrarPagamento(faturaId);

      const r = await enviar('PAGAMENTO_VENCIDO', idExterno, `ev-late-${idExterno}`);

      expect(r.aplicado).toBe(false);
      expect(await status(faturaId)).toBe('PAGA');

      /* E o evento fica registrado como VISTO e recusado — não perdido. */
      const evento = await prisma.eventoCobranca.findUniqueOrThrow({
        where: { idExterno: `ev-late-${idExterno}` },
        select: { erro: true, processadoEm: true },
      });
      expect(evento.erro).toMatch(/não aceita PAGAMENTO_VENCIDO/);
      expect(evento.processadoEm).not.toBeNull();
    });
  });

  // ── Período coberto: a fundação do plano anual ──

  describe('período pago', () => {
    /**
     * ⚠ O CASO QUE MOTIVOU A COLUNA.
     *
     * `competenciaDe` sempre trunca para o mês CORRENTE. No dia 1º do mês
     * seguinte a competência muda, o unique de (assinatura, competência) não
     * acha nada, e o serviço emitiria cobrança nova pelo valor CHEIO. Num plano
     * de 12 meses isso é o cliente pagando o ano doze vezes.
     */
    it('plano anual pago não é refaturado no mês seguinte', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 7670, 12);

      const agosto = new Date(Date.UTC(2026, 7, 10));
      const emitida = await cobranca.emitirFatura({ organizationId: org.id, hoje: agosto });
      await cobranca.registrarPagamento(emitida.faturaId!);

      /* Um mês depois — a data em que o cron rodaria de novo. */
      const setembro = new Date(Date.UTC(2026, 8, 1));
      const r = await cobranca.emitirFatura({ organizationId: org.id, hoje: setembro });

      expect(r.emitida).toBe(false);
      expect(r.motivo).toBe('ciclo já pago');
      expect(await prisma.fatura.count({ where: { assinatura: { organizationId: org.id } } })).toBe(1);
    });

    /* O CONTRAPONTO INDISPENSÁVEL: sem ele, um bug que barrasse TUDO passaria
       como "período coberto funcionando" — e ninguém mais seria cobrado. */
    it('o mensal volta a ser cobrado no mês seguinte, como sempre foi', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 799, 1);

      const agosto = new Date(Date.UTC(2026, 7, 10));
      const primeira = await cobranca.emitirFatura({ organizationId: org.id, hoje: agosto });
      await cobranca.registrarPagamento(primeira.faturaId!);

      const setembro = new Date(Date.UTC(2026, 8, 1));
      const segunda = await cobranca.emitirFatura({ organizationId: org.id, hoje: setembro });

      expect(segunda.emitida).toBe(true);
      expect(await prisma.fatura.count({ where: { assinatura: { organizationId: org.id } } })).toBe(2);
    });

    /* A FRONTEIRA: `pagoAte` é EXCLUSIVO. No dia exato em que o ciclo termina a
       cobrança volta — nem um dia antes, nem um mês depois. */
    it('no primeiro dia DEPOIS do ciclo, cobra de novo', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 799, 1);

      const paga = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 7, 10)),
      });
      await cobranca.registrarPagamento(paga.faturaId!);

      const assinatura = await prisma.assinatura.findUniqueOrThrow({
        where: { organizationId: org.id },
        select: { pagoAte: true },
      });
      expect(assinatura.pagoAte?.toISOString().slice(0, 10)).toBe('2026-09-01');

      /* 31/08 ainda está coberto. */
      const ultimoDia = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 7, 31)),
      });
      expect(ultimoDia.emitida).toBe(false);

      /* 01/09 não está. */
      const virada = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 8, 1)),
      });
      expect(virada.emitida).toBe(true);
    });

    /**
     * Quitar uma fatura ATRASADA não pode ENCURTAR o período coberto.
     *
     * Pagar agosto em outubro, com setembro já quitado, não pode fazer
     * `pagoAte` voltar para 1º de setembro — isso religaria a cobrança de um mês
     * que está pago. É o `Math.max` do `registrarPagamento`.
     */
    it('pagar uma fatura atrasada não anda com o período para trás', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 799, 1);

      const agosto = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 7, 5)),
      });
      const setembro = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 8, 5)),
      });

      /* Setembro é pago PRIMEIRO — pagoAte vai a 1º de outubro. */
      await cobranca.registrarPagamento(setembro.faturaId!);
      /* Só então a de agosto é quitada, e ela terminaria em 1º de setembro. */
      await cobranca.registrarPagamento(agosto.faturaId!);

      const a = await prisma.assinatura.findUniqueOrThrow({
        where: { organizationId: org.id },
        select: { pagoAte: true },
      });
      expect(a.pagoAte?.toISOString().slice(0, 10)).toBe('2026-10-01');
    });

    /* Quem NUNCA pagou não tem período coberto — nulo não é "vencido". */
    it('assinatura sem pagamento nenhum é faturada normalmente', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 799, 12);

      const r = await cobranca.emitirFatura({ organizationId: org.id });
      expect(r.emitida).toBe(true);
    });

    /**
     * A trava vale também para a competência EXPLÍCITA — inclusive a da rota de
     * ADMIN. É ali que uma segunda cobrança do mesmo período nasceria sem
     * ninguém perceber, e desfazer cobrança emitida no gateway é trabalho manual.
     */
    it('competência forçada na mão não fura o período pago', async () => {
      const { org } = await semearCliente();
      await assinar(org.id, 7670, 12);

      const paga = await cobranca.emitirFatura({
        organizationId: org.id,
        hoje: new Date(Date.UTC(2026, 7, 10)),
      });
      await cobranca.registrarPagamento(paga.faturaId!);

      const forcada = await cobranca.emitirFatura({
        organizationId: org.id,
        competencia: new Date(Date.UTC(2026, 10, 1)),
        hoje: new Date(Date.UTC(2026, 10, 1)),
      });
      expect(forcada.emitida).toBe(false);
      expect(forcada.motivo).toBe('ciclo já pago');
    });
  });
});
