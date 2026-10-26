import { montarCronograma, somaDoCronograma, somarMeses, deCentavos, paraCentavos } from './cronograma';

/**
 * A DIVISÃO DAS PARCELAS.
 *
 * O erro aqui não aparece na tela: aparece na conferência do contrato, meses
 * depois, com o titular reclamando de dez centavos. Por isso a regra mora em
 * código puro e é testada sem banco nenhum.
 */
describe('Cronograma — a soma tem de FECHAR', () => {
  it('300.000,00 em 7 vezes fecha em 300.000,00', () => {
    /**
     * 30.000.000 centavos ÷ 7 = 4.285.714, resto 2. O resíduo vai para a
     * PRIMEIRA parcela. Em aritmética decimal, arredondar 42.857,142857… sete
     * vezes daria 299.999,99 ou 300.000,01 — um total que NÃO é o combinado.
     */
    const linhas = montarCronograma({
      total: '300000.00',
      parcelas: 7,
      primeiroVencimento: '2026-09-10',
    });

    expect(linhas).toHaveLength(7);
    expect(linhas[0].valor).toBe('42857.16');
    expect(linhas.slice(1).every((l) => l.valor === '42857.14')).toBe(true);
    expect(somaDoCronograma(linhas)).toBe('300000.00');
  });

  it('com entrada, o resíduo vai para a primeira PARCELA — nunca para a entrada', () => {
    /* A entrada é número que o operador digitou e combinou com o titular.
       Alterá-la em um centavo por conta do arredondamento seria o sistema
       mudando, sozinho, um valor acordado. */
    const linhas = montarCronograma({
      total: '300000.00',
      entrada: '50000.00',
      parcelas: 6,
      primeiroVencimento: '2026-09-10',
      hoje: new Date('2026-08-11T12:00:00.000Z'),
    });

    expect(linhas[0]).toMatchObject({ numero: 0, valor: '50000.00', vencimento: '2026-08-11' });
    expect(linhas[1].valor).toBe('41666.70');
    expect(linhas.slice(2).every((l) => l.valor === '41666.66')).toBe(true);
    expect(somaDoCronograma(linhas)).toBe('300000.00');
  });

  it('divisão exata não inventa resíduo', () => {
    const linhas = montarCronograma({
      total: '300000.00',
      parcelas: 6,
      primeiroVencimento: '2026-09-10',
    });
    expect(linhas.every((l) => l.valor === '50000.00')).toBe(true);
    expect(somaDoCronograma(linhas)).toBe('300000.00');
  });

  it('fecha para QUALQUER número de parcelas de 1 a 60', () => {
    /* A prova que uma tabela de casos escolhidos a dedo não dá: sessenta
       divisões, todas fechando no centavo. */
    for (let n = 1; n <= 60; n++) {
      const linhas = montarCronograma({
        total: '4018773.35',
        parcelas: n,
        primeiroVencimento: '2026-09-10',
      });
      expect(somaDoCronograma(linhas)).toBe('4018773.35');
    }
  });

  it('à vista é UMA parcela, e continua fechando', () => {
    const linhas = montarCronograma({
      total: '300000.00',
      parcelas: 1,
      primeiroVencimento: '2026-09-10',
    });
    expect(linhas).toEqual([{ numero: 1, valor: '300000.00', vencimento: '2026-09-10' }]);
  });
});

describe('Cronograma — as datas', () => {
  it('31/01 não vaza para março: vira 28/02, 31/03, 30/04', () => {
    /**
     * `new Date(2026, 0, 31)` + 1 mês em JavaScript dá 03/03, porque 31 de
     * fevereiro não existe e a data transborda. Num cronograma isso pularia
     * fevereiro inteiro e cobraria duas vezes em março.
     */
    const linhas = montarCronograma({
      total: '4000.00',
      parcelas: 4,
      primeiroVencimento: '2026-01-31',
    });

    expect(linhas.map((l) => l.vencimento)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('fevereiro de ano bissexto ganha o dia 29', () => {
    expect(somarMeses('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('o intervalo pode não ser mensal', () => {
    const linhas = montarCronograma({
      total: '3000.00',
      parcelas: 3,
      primeiroVencimento: '2026-09-10',
      intervaloMeses: 3,
    });
    expect(linhas.map((l) => l.vencimento)).toEqual(['2026-09-10', '2026-12-10', '2027-03-10']);
  });

  it('a virada do ano é só mais um mês', () => {
    expect(somarMeses('2026-11-15', 3)).toBe('2027-02-15');
  });
});

describe('Cronograma — o que ele RECUSA', () => {
  it('parcela abaixo de um centavo é recusada, e não vira linha de zero', () => {
    /* Um cronograma de zeros parece dado, não erro. */
    expect(() =>
      montarCronograma({ total: '5.00', parcelas: 700, primeiroVencimento: '2026-09-10' }),
    ).toThrow(/não se divide/);
  });

  it('entrada maior ou igual ao total não deixa nada para parcelar', () => {
    expect(() =>
      montarCronograma({
        total: '300000.00',
        entrada: '300000.00',
        parcelas: 3,
        primeiroVencimento: '2026-09-10',
      }),
    ).toThrow(/não há o que parcelar/);
  });

  it('total zerado ou negativo é recusado', () => {
    expect(() =>
      montarCronograma({ total: '0.00', parcelas: 3, primeiroVencimento: '2026-09-10' }),
    ).toThrow(/positivo/);
  });

  it('número de parcelas inválido é recusado', () => {
    expect(() =>
      montarCronograma({ total: '300000.00', parcelas: 0, primeiroVencimento: '2026-09-10' }),
    ).toThrow(/em quantas vezes/);
  });
});

describe('Cronograma — centavos', () => {
  it('vai e volta sem perder um centavo', () => {
    for (const v of ['0.01', '1.99', '4018773.35', '999999999.99']) {
      expect(deCentavos(paraCentavos(v))).toBe(v);
    }
  });

  it('R$ 4.018.773,35 não vira 4018773.3499999', () => {
    /* O valor real do maior precatório da base. Em float de dupla precisão,
       multiplicar por 100 já perde o centavo. */
    expect(paraCentavos('4018773.35')).toBe(401877335n);
  });
});
