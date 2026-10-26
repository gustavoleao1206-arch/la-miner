import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  BillingProvider,
  CobrancaEmitida,
  DadosCliente,
  EventoNormalizado,
  PedidoCobranca,
  TipoEventoCobranca,
} from '../domain/billing-provider.port';

/**
 * Como o evento do Asaas chega. Só os campos que usamos — o resto do payload é
 * gravado cru em EventoCobranca, então nada se perde por não estar tipado aqui.
 */
interface EventoAsaas {
  id?: string;
  event?: string;
  payment?: {
    id?: string;
    /** Valor BRUTO da cobrança, em reais. É o que se compara com a fatura. */
    value?: number;
    /** Líquido, já descontada a taxa do gateway. NÃO serve para conferência. */
    netValue?: number;
  };
  dateCreated?: string;
}

/**
 * Tradução dos eventos do Asaas para o nosso vocabulário.
 *
 * ⚠ CONFIRMED **e** RECEIVED contam como pagamento, e isso é decisão de negócio,
 * não descuido. No Asaas eles são estados diferentes: CONFIRMED = o cliente
 * pagou, mas o dinheiro ainda não está disponível; RECEIVED = o saldo caiu. No
 * boleto o fluxo é CREATED → CONFIRMED → RECEIVED, com a liquidação chegando um
 * ou mais dias depois. Escutar só RECEIVED deixaria um cliente que JÁ PAGOU
 * suspenso esperando a compensação — cobrar de novo de quem pagou é o pior erro
 * que uma régua de cobrança pode cometer.
 *
 * Receber os dois não duplica nada: `registrarPagamento` é idempotente e a
 * segunda passagem devolve `alterado: false`, preservando a data do primeiro
 * pagamento.
 *
 * PAYMENT_PARTIALLY_REFUNDED fica de FORA de propósito: estorno parcial não diz
 * se a assinatura segue paga ou não, e chutar erra para os dois lados — ou corta
 * o acesso de quem está em dia, ou libera quem não está. Cai no `null` (evento
 * ignorado) e o receberEvento LOGA o nome do evento — antes este comentário
 * prometia um registro que não existia.
 *
 * Os eventos de ANÁLISE DE RISCO do cartão (AWAITING/APPROVED/REPROVED_BY_
 * RISK_ANALYSIS) também caem no ignorado, e isso é seguro: nada é liberado até
 * o CONFIRMED. O log é o que avisa a operação de que há um pagamento parado em
 * análise — ticket alto no cartão (o anual) é exatamente o perfil que cai lá.
 */
const EVENTOS: Record<string, TipoEventoCobranca> = {
  PAYMENT_CONFIRMED: 'PAGAMENTO_CONFIRMADO',
  PAYMENT_RECEIVED: 'PAGAMENTO_CONFIRMADO',
  PAYMENT_OVERDUE: 'PAGAMENTO_VENCIDO',
  PAYMENT_REFUNDED: 'PAGAMENTO_ESTORNADO',
  /* Chargeback é dinheiro tomado de volta pela adquirente: para a nossa régua,
     vale o mesmo que estorno. */
  PAYMENT_CHARGEBACK_REQUESTED: 'PAGAMENTO_ESTORNADO',
  /* ── A COBRANÇA SOME (OU VOLTA) PELO PAINEL ──
     Estes dois não falam de dinheiro, e sim da EXISTÊNCIA da cobrança. Antes
     caíam no ignorado, e o efeito era uma fatura "Aberta" eternamente: o
     cliente via um botão "Pagar" apontando para uma cobrança que não existe
     mais, e a régua de vencimento suspendia a assinatura por uma dívida que
     ninguém tinha como quitar. */
  PAYMENT_DELETED: 'COBRANCA_REMOVIDA',
  PAYMENT_RESTORED: 'COBRANCA_RESTAURADA',
};

@Injectable()
export class AsaasProvider implements BillingProvider {
  readonly nome = 'ASAAS';
  private readonly logger = new Logger(AsaasProvider.name);

  constructor(private readonly config: ConfigService) {}

  private get chave(): string {
    return this.config.getOrThrow<string>('ASAAS_API_KEY');
  }

  /**
   * A URL SAI DO PREFIXO DA CHAVE, não de uma variável separada.
   *
   * Chave de sandbox começa com `$aact_hmlg_`; a de produção, com `$aact_prod_`.
   * Com duas configurações independentes (ambiente + chave), a combinação errada
   * é possível — e a mais perigosa delas, chave de produção apontada para
   * sandbox, cobraria de verdade sem nunca aparecer no painel de homologação.
   * Derivando do prefixo, essa combinação deixa de existir.
   */
  private get base(): string {
    return this.chave.startsWith('$aact_prod_')
      ? 'https://api.asaas.com/v3'
      : 'https://api-sandbox.asaas.com/v3';
  }

  get producao(): boolean {
    return this.chave.startsWith('$aact_prod_');
  }

  private async chamar<T>(caminho: string, init: RequestInit = {}): Promise<T> {
    /* O timeout é explícito: sem ele, um Asaas lento seguraria a transação de
       emissão e, com o cron faturando todos os clientes em sequência, uma
       chamada pendurada travaria a rodada inteira. */
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), 20_000);
    try {
      const r = await fetch(`${this.base}${caminho}`, {
        ...init,
        signal: controle.signal,
        headers: {
          'Content-Type': 'application/json',
          /* Header próprio do Asaas — não é `Authorization: Bearer`. */
          access_token: this.chave,
          ...init.headers,
        },
      });
      const corpo = await r.text();
      if (!r.ok) {
        /* O Asaas devolve { errors: [{ code, description }] }. A descrição é
           acionável ("CPF/CNPJ inválido"), então ela sobe; a chave, jamais. */
        let detalhe = corpo.slice(0, 300);
        try {
          const j = JSON.parse(corpo);
          if (Array.isArray(j?.errors)) {
            detalhe = j.errors.map((e: { description?: string }) => e.description).join('; ');
          }
        } catch {
          /* corpo não-JSON: fica o trecho cru mesmo */
        }
        throw new BadRequestException(`Asaas (${r.status}): ${detalhe}`);
      }
      return corpo ? (JSON.parse(corpo) as T) : ({} as T);
    } finally {
      clearTimeout(relogio);
    }
  }

  /**
   * Registra o cliente no Asaas e devolve o id dele (`cus_...`).
   *
   * O Asaas EXIGE cpfCnpj. Como `Organization.cnpj` é opcional no nosso schema, a
   * falta dele viraria um 400 obscuro vindo de fora; a mensagem daqui diz o que
   * fazer.
   */
  async registrarCliente(dados: DadosCliente): Promise<string | null> {
    const cpfCnpj = (dados.cnpjCpf ?? '').replace(/\D/g, '');
    if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) {
      throw new BadRequestException(
        'O Asaas exige CPF ou CNPJ do cliente para emitir cobrança. Cadastre o CNPJ da empresa antes de faturar.',
      );
    }

    /* Só dígitos, e só se sobrar telefone plausível. O Asaas recusa o cadastro
       inteiro quando o campo vem malformado — e perder a emissão por causa de
       um telefone é trocar a cobrança por um detalhe de contato. Na dúvida,
       omitir: cobrança sem telefone funciona; cadastro recusado, não.

       10 dígitos = fixo com DDD, 11 = celular com DDD. Fora disso não dá para
       afirmar o que é, então não vai. */
    const telefone = (dados.telefone ?? '').replace(/\D/g, '');
    const telefoneValido = telefone.length === 10 || telefone.length === 11;

    const r = await this.chamar<{ id: string }>('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: dados.nome,
        cpfCnpj,
        ...(dados.email ? { email: dados.email } : {}),
        /* `mobilePhone` para 11 dígitos, `phone` para 10: são campos distintos
           no Asaas, e mandar celular no campo de fixo faz o aviso por SMS não
           sair. */
        ...(telefoneValido
          ? telefone.length === 11
            ? { mobilePhone: telefone }
            : { phone: telefone }
          : {}),
      }),
    });
    this.logger.log(`Cliente registrado no Asaas: ${r.id}`);
    return r.id;
  }

  /**
   * Cria UMA cobrança avulsa — não uma "assinatura" do Asaas.
   *
   * Decisão deliberada: a régua de vencimento, carência e suspensão vive no
   * CobrancaService, e é dela que sai o corte de lotes novos e o 402 no acesso.
   * Usar a assinatura recorrente do Asaas colocaria uma SEGUNDA máquina de
   * estados do outro lado da rede, e as duas divergiriam no primeiro atraso —
   * exatamente o motivo pelo qual o gateway foi escolhido no lugar de uma
   * plataforma que fosse dona da venda. O Asaas move dinheiro e avisa; a verdade
   * continua aqui.
   */
  async emitirCobranca(pedido: PedidoCobranca): Promise<CobrancaEmitida> {
    if (!pedido.clienteExternoId) {
      throw new BadRequestException('Cobrança sem cliente registrado no Asaas.');
    }

    /* O corpo INDISPENSÁVEL: sem qualquer um destes campos não existe cobrança. */
    const corpo = {
      customer: pedido.clienteExternoId,
      /* UNDEFINED oferece na fatura TODOS os meios habilitados na conta
         Asaas — PIX, boleto E cartão. (Até 19/08/2026 este comentário dizia
         "PIX e boleto", e a mentira quase custou uma implementação de
         cartão que não era necessária: quem habilita ou não o cartão é o
         painel do Asaas, não este código.) Configurável para o dia em que
         fizer sentido forçar um meio. */
      billingType: this.config.get<string>('ASAAS_BILLING_TYPE', 'UNDEFINED'),
      value: pedido.valor,
      /* AAAA-MM-DD, que é o formato do Asaas e também o da nossa coluna DATE
         — vencimento é DIA, e nenhum fuso entra no meio. */
      dueDate: pedido.vencimentoEm.toISOString().slice(0, 10),
      description: pedido.descricao,
      /* Nosso id da fatura viaja junto: é o que permite reconciliar mesmo se
         todo webhook se perder. */
      externalReference: pedido.referencia,
    };

    /**
     * ── O CAMINHO DE VOLTA, E POR QUE ELE É DESCARTÁVEL ──
     *
     * Sem `callback`, quem paga termina numa tela do Asaas sem porta de saída —
     * a jornada "cadastrou → pagou → está dentro" morre no gateway. O retorno
     * cai no login com um marcador que a tela troca por "pagamento confirmado".
     * `autoRedirect: true` volta sozinho, sem exigir clique num botão que
     * ninguém acha.
     *
     * ⚠ MAS O ASAAS SÓ ACEITA CALLBACK PARA DOMÍNIO CADASTRADO NA CONTA. Em
     * 19/08/2026 este campo derrubou a emissão inteira em produção: a WEB_URL
     * não estava declarada na Render, o successUrl saiu como
     * `http://localhost:3000/...`, e o gateway respondeu 400 na cara de quem
     * clicou em "Gerar cobrança". Trocar receita por um redirecionamento é o
     * pior negócio possível — cobrança que não abre é dinheiro que não entra;
     * retorno que não volta é uma tela a mais.
     */
    const callback = {
      successUrl: `${this.config
        .get<string>('WEB_URL', 'http://localhost:3000')
        .replace(/\/$/, '')}/login?pagamento=confirmado`,
      autoRedirect: true,
    };

    const criar = (payload: object) =>
      this.chamar<{ id: string; invoiceUrl?: string; bankSlipUrl?: string }>('/payments', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

    let r: { id: string; invoiceUrl?: string; bankSlipUrl?: string };
    try {
      r = await criar({ ...corpo, callback });
    } catch (erro) {
      /**
       * O `callback` é a ÚNICA coisa OPCIONAL que mandamos. Então, diante de um
       * 400, largá-lo e repetir é ao mesmo tempo o conserto e o DIAGNÓSTICO: se
       * a segunda tentativa passa, o culpado era ele, e o WARN abaixo diz o que
       * fazer no painel. Se falha de novo, o erro sobe intacto — nada é
       * engolido.
       *
       * A condição casa com a NOSSA mensagem (`Asaas (400): …`, formatada em
       * `chamar`), nunca com o texto do gateway: o dia em que o Asaas reescrever
       * "Não há nenhum domínio configurado" em outras palavras não pode ser o
       * dia em que a emissão volta a quebrar. Só 400 — um 401 é chave errada, e
       * repetir não conserta chave.
       */
      if (!(erro instanceof BadRequestException) || !erro.message.startsWith('Asaas (400')) {
        throw erro;
      }
      r = await criar(corpo);
      this.logger.warn(
        `A cobrança ${r.id} abriu SEM o retorno automático: o Asaas recusou o callback ` +
          `para ${callback.successUrl}. Quem pagar vai parar numa tela do gateway sem porta ` +
          'de saída. Conserto: cadastre o domínio em Minha Conta → Informações no painel do ' +
          'Asaas, e confira se WEB_URL aponta para o endereço público do sistema.',
      );
    }

    return {
      idExterno: r.id,
      /* `invoiceUrl` é a fatura do Asaas, onde o pagador escolhe entre os meios
         habilitados na conta (PIX, boleto, cartão). O bankSlipUrl só existe
         quando o meio já está fixado em boleto. */
      urlPagamento: r.invoiceUrl ?? r.bankSlipUrl ?? null,
    };
  }

  async cancelarCobranca(idExterno: string): Promise<void> {
    await this.chamar(`/payments/${idExterno}`, { method: 'DELETE' });
  }

  /**
   * Confere que o webhook veio mesmo do Asaas.
   *
   * ⚠ O QUE ESTA CHECAGEM GARANTE, E O QUE NÃO GARANTE.
   *
   * O Asaas NÃO assina o corpo (não há HMAC). O que ele oferece é um SEGREDO
   * COMPARTILHADO no header `asaas-access-token`, configurado ao cadastrar o
   * webhook. Então isto prova que quem chamou conhece o segredo — e nada além
   * disso: não há integridade do corpo nem proteção contra reenvio.
   *
   * O que compensa cada lacuna:
   *  - reenvio: a idempotência por `EventoCobranca.idExterno` (o `id` do evento,
   *    que o próprio Asaas manda para isso) faz o segundo processamento ser
   *    inócuo;
   *  - integridade: como o corpo só nos dá o ID da cobrança, e a fatura é
   *    encontrada por esse id no NOSSO banco, um corpo adulterado não consegue
   *    inventar valor nem beneficiário — no máximo aponta para outra cobrança
   *    nossa, e o valor pago não vem do payload.
   *
   * Daí a exigência de HTTPS: em texto claro, o segredo viajaria legível.
   *
   * A comparação é por DIGEST de tamanho fixo e `timingSafeEqual`: comparar as
   * strings direto vazaria o segredo caractere a caractere pelo tempo de
   * resposta, e comparar os bytes crus ainda vazaria o comprimento.
   */
  verificarWebhook(_corpoBruto: string, cabecalhos: Record<string, string | undefined>): boolean {
    const esperado = this.config.get<string>('ASAAS_WEBHOOK_TOKEN', '');
    if (!esperado) {
      /* Sem segredo configurado, RECUSA — nunca "aceita tudo". Um webhook aberto
         é um "marque como pago" público. */
      this.logger.error('ASAAS_WEBHOOK_TOKEN não configurado: recusando todo webhook.');
      return false;
    }

    /* Header chega em minúsculas no Node; a variação fica por garantia. */
    const recebido = cabecalhos['asaas-access-token'] ?? cabecalhos['Asaas-Access-Token'];
    if (!recebido) return false;

    const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
    return timingSafeEqual(digest(recebido), digest(esperado));
  }

  interpretarEvento(payload: unknown): EventoNormalizado | null {
    const e = payload as EventoAsaas | null;
    if (!e?.event || !e.payment?.id) return null;

    const tipo = EVENTOS[e.event];
    if (!tipo) return null; // evento que não muda o estado da assinatura

    /* `id` do evento é a chave de idempotência que o próprio Asaas recomenda. Se
       vier ausente (payload fora do contrato), sintetizamos uma chave estável a
       partir do que dá — repetir o MESMO evento continua sendo bloqueado, em vez
       de escaparmos para "processa sempre". */
    const idExterno = e.id ?? `${e.event}:${e.payment.id}:${e.dateCreated ?? ''}`;

    return {
      idExterno,
      tipo,
      cobrancaExternaId: e.payment.id,
      /* A data do evento vem "AAAA-MM-DD HH:MM:SS", sem fuso. Tratamos como
         horário de Brasília, que é o do Asaas, em vez de deixar o `new Date`
         interpretar como UTC e gravar o pagamento 3 horas adiantado. */
      ...(tipo === 'PAGAMENTO_CONFIRMADO' && e.dateCreated
        ? { pagoEm: new Date(`${e.dateCreated.replace(' ', 'T')}-03:00`) }
        : {}),
      /* `value`, e NUNCA `netValue`: o líquido já vem descontado da taxa do
         Asaas, então compará-lo com a fatura acusaria pagamento a menor em
         TODA cobrança legítima. O bruto é o que o cliente pagou. */
      ...(typeof e.payment.value === 'number' ? { valorPago: e.payment.value } : {}),
    };
  }
}
