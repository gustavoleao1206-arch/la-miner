import { conferirValorPago } from './conferir-valor';

/**
 * A conferência de valor do webhook.
 *
 * O que se defende aqui: antes, "pagou" bastava e QUANTO não importava. Um
 * pagamento parcial dava baixa na fatura inteira e liberava a assinatura.
 *
 * A borda que mais importa é a de baixo — recusar um centavo a menos e ACEITAR
 * o valor exato. Errar para o lado severo suspende quem pagou certo, e cobrar
 * de novo de quem já pagou é o pior erro possível nesta parte do sistema.
 */
describe('conferirValorPago', () => {
  it('valor exato: aceita, sem ressalva', () => {
    expect(conferirValorPago(1990.0, 1990.0)).toEqual({ aceitar: true });
  });

  it('aceita valor com centavos, sem tropeçar em ponto flutuante', () => {
    /* 499.90 em float não é exatamente 499.90. Comparando em centavos
       inteiros a igualdade é exata — comparando em float, este caso recusaria
       um pagamento legítimo. */
    expect(conferirValorPago(499.9, 499.9)).toEqual({ aceitar: true });
    expect(conferirValorPago(0.1 + 0.2, 0.3)).toEqual({ aceitar: true });
  });

  it('UM CENTAVO a menos já recusa', () => {
    const r = conferirValorPago(1990.0, 1989.99);
    expect(r.aceitar).toBe(false);
    expect(r.motivo).toMatch(/pagamento a menor/);
    // A mensagem tem de dizer quanto falta — é o que o financeiro vai cobrar.
    expect(r.motivo).toMatch(/faltam/);
  });

  it('pagamento parcial grosseiro recusa', () => {
    const r = conferirValorPago(1990.0, 1.0);
    expect(r.aceitar).toBe(false);
    expect(r.motivo).toContain('R$');
  });

  it('valor a MAIOR aceita, com ressalva registrada', () => {
    /* Quem pagou mais não pode ficar sem acesso — o problema dele é receber a
       diferença de volta, e isso é conversa com o financeiro, não motivo para
       bloquear a conta. */
    const r = conferirValorPago(1990.0, 2000.0);
    expect(r.aceitar).toBe(true);
    expect(r.observacao).toMatch(/pagamento a maior/);
  });

  it('provedor sem valor: aceita, mas registra que NÃO houve conferência', () => {
    const r = conferirValorPago(1990.0, undefined);
    expect(r.aceitar).toBe(true);
    expect(r.observacao).toMatch(/sem conferência/);
  });

  it('valor inválido do provedor é tratado como ausente, não como zero', () => {
    /* `NaN < devido` é FALSO em JavaScript. Sem o guarda de finitude, um valor
       corrompido passaria pela comparação e viraria "aceito" silencioso — ou,
       pior, um `0` interpretado como pagamento a menor num evento legítimo. */
    for (const ruim of [NaN, Infinity]) {
      const r = conferirValorPago(1990.0, ruim);
      expect(r.aceitar).toBe(true);
      expect(r.observacao).toMatch(/sem conferência/);
    }
  });

  it('aceita o valor devido vindo como string (Decimal do Prisma)', () => {
    /* `Fatura.valor` é Decimal; serializado, chega como string. Se a conversão
       falhasse, `Number('1990.00')` viraria NaN e TODA fatura seria recusada. */
    expect(conferirValorPago('1990.00', 1990.0)).toEqual({ aceitar: true });
    expect(conferirValorPago('1990.00', 1989.99).aceitar).toBe(false);
  });

  it('fatura de valor zero aceita pagamento zero', () => {
    expect(conferirValorPago(0, 0)).toEqual({ aceitar: true });
  });
});
