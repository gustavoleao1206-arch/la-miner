import type { Prisma } from '@miner/database';

/**
 * Conferência do valor pago contra o valor devido.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * O webhook aceitava "pagou" sem olhar QUANTO. Um pagamento parcial — ou uma
 * cobrança emitida com valor errado — dava baixa na fatura inteira e liberava a
 * assinatura. O rombo só apareceria na conciliação, meses depois, com o cliente
 * já tendo recebido lotes que não pagou.
 *
 * Não é defesa contra webhook forjado: para isso existe o segredo compartilhado,
 * conferido antes. É defesa contra pagamento a menor e erro de emissão, que são
 * muito mais prováveis do que um atacante de posse da nossa chave.
 *
 * ── EM CENTAVOS INTEIROS, E NÃO EM PONTO FLUTUANTE ──
 *
 * `499.90 !== 499.9000000000001` é exatamente como se recusa um pagamento
 * legítimo. Ambos os lados têm no máximo duas casas, então o inteiro de
 * centavos é exato e a comparação é exata.
 */

export interface ResultadoConferencia {
  aceitar: boolean;
  /** Preenchido quando `aceitar` é falso — vai para o evento e para o log. */
  motivo?: string;
  /** Preenchido quando aceita, mas há algo digno de registro. */
  observacao?: string;
}

const emCentavos = (v: number) => Math.round(v * 100);
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function conferirValorPago(
  valorDevido: Prisma.Decimal | number | string,
  valorPago?: number,
): ResultadoConferencia {
  /**
   * Provedor que não informa valor (o manual não tem cobrança externa).
   *
   * Aceita, mas REGISTRA que não houve conferência. Recusar aqui suspenderia
   * quem pagou por causa de uma limitação nossa — e cobrar de novo de quem já
   * pagou é o pior erro possível nesta parte do sistema. O registro no evento
   * é o que impede isso de virar um "conferido" que não aconteceu.
   */
  if (valorPago === undefined || valorPago === null || !Number.isFinite(valorPago)) {
    return {
      aceitar: true,
      observacao: 'baixa sem conferência de valor: o provedor não informou quanto foi pago',
    };
  }

  const devido = emCentavos(Number(valorDevido));
  const pago = emCentavos(valorPago);

  if (pago < devido) {
    const falta = (devido - pago) / 100;
    return {
      aceitar: false,
      motivo:
        `pagamento a menor: recebido ${brl(pago / 100)} para uma fatura de ` +
        `${brl(devido / 100)} (faltam ${brl(falta)})`,
    };
  }

  if (pago > devido) {
    /**
     * A MAIOR aceita, de propósito.
     *
     * Quem pagou mais do que devia não pode ficar sem acesso — o problema dele
     * é receber a diferença de volta, e isso é conversa com o financeiro, não
     * motivo para bloquear a conta. Fica registrado para que alguém veja.
     */
    return {
      aceitar: true,
      observacao:
        `pagamento a maior: recebido ${brl(pago / 100)} para uma fatura de ` +
        `${brl(devido / 100)} — conferir com o financeiro`,
    };
  }

  return { aceitar: true };
}
