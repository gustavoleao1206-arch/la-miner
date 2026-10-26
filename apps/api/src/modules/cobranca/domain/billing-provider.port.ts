/**
 * Porta (hexagonal) do provedor de cobrança.
 *
 * Nenhum caso de uso conhece o nome de um gateway. Todos dependem desta
 * interface, então trocar de provedor — ou voltar para o manual — é mudança de
 * CONFIGURAÇÃO, não de domínio. Mesmo desenho da porta de enriquecimento, pela
 * mesma razão: o dia em que o gateway mudar de preço ou de país, o domínio não
 * pode precisar mudar junto.
 */

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export interface DadosCliente {
  nome: string;
  email?: string | null;
  cnpjCpf?: string | null;
  /**
   * Telefone do sacado, só dígitos ou como o usuário digitou — quem normaliza é
   * o adaptador, porque o formato aceitável é regra DO gateway, não do domínio.
   *
   * Opcional porque as organizações criadas antes do cadastro público não têm.
   * Ausente não impede emitir: o Asaas cobra sem telefone; ele apenas perde um
   * canal de aviso ao sacado.
   */
  telefone?: string | null;
}

export interface PedidoCobranca {
  /** Id do cliente NO GATEWAY. Nulo quando ainda não foi registrado lá. */
  clienteExternoId: string | null;
  valor: number;
  vencimentoEm: Date;
  descricao: string;
  /** NOSSO id da fatura — vai ao gateway como referência externa, e é o que
   *  permite reconciliar mesmo se o webhook se perder. */
  referencia: string;
}

export interface CobrancaEmitida {
  /** Nulo no provedor manual: não existe cobrança externa. */
  idExterno: string | null;
  urlPagamento: string | null;
}

/**
 * Evento do gateway, já traduzido para o nosso vocabulário.
 *
 * Os dois últimos falam da COBRANÇA, não do dinheiro: alguém apagou (ou
 * restaurou) a cobrança pelo painel do gateway. Sem eles, uma cobrança apagada
 * lá fora deixava a fatura "Aberta" para sempre aqui dentro — o cliente via um
 * "Pagar" que levava a uma cobrança inexistente, e a régua de vencimento
 * suspendia a assinatura por uma dívida que ninguém mais podia quitar.
 */
export type TipoEventoCobranca =
  | 'PAGAMENTO_CONFIRMADO'
  | 'PAGAMENTO_VENCIDO'
  | 'PAGAMENTO_ESTORNADO'
  | 'COBRANCA_REMOVIDA'
  | 'COBRANCA_RESTAURADA';

export interface EventoNormalizado {
  /** Id do EVENTO no gateway — é a chave de idempotência do webhook. */
  idExterno: string;
  tipo: TipoEventoCobranca;
  /** Id da COBRANÇA no gateway, por onde a fatura é encontrada. */
  cobrancaExternaId: string;
  pagoEm?: Date;
  /**
   * Quanto o gateway diz que foi pago, em reais.
   *
   * Existe para ser COMPARADO com o valor da fatura antes da baixa. Sem essa
   * conferência, o webhook aceitava "pagou" sem olhar quanto: um pagamento
   * parcial — ou uma cobrança emitida com valor errado — liberava a assinatura
   * inteira, e o rombo só apareceria na conciliação, meses depois.
   *
   * Opcional porque nem todo provedor informa (o manual não tem cobrança
   * externa). Ausente = não dá para conferir, e isso fica REGISTRADO no evento
   * em vez de virar um "conferido" que não houve.
   */
  valorPago?: number;
}

export interface BillingProvider {
  readonly nome: string;

  /** Registra (ou reaproveita) o cliente no gateway. Manual devolve `null`. */
  registrarCliente(dados: DadosCliente): Promise<string | null>;

  emitirCobranca(pedido: PedidoCobranca): Promise<CobrancaEmitida>;

  cancelarCobranca(idExterno: string): Promise<void>;

  /**
   * Confere que o webhook veio MESMO do gateway.
   *
   * É a função mais crítica de qualquer adaptador: a URL de webhook é pública, e
   * sem esta checagem quem a descobrir marca as próprias faturas como pagas.
   * Um adaptador que não souber verificar deve devolver `false` — nunca `true`.
   */
  verificarWebhook(corpoBruto: string, cabecalhos: Record<string, string | undefined>): boolean;

  /** Traduz o payload do gateway. `null` = evento que não nos interessa. */
  interpretarEvento(payload: unknown): EventoNormalizado | null;
}
