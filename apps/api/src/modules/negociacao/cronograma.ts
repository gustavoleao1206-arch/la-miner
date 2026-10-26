import { Prisma } from '@miner/database';

/**
 * A DIVISÃO DAS PARCELAS — código puro, sem banco e sem Nest.
 *
 * ── POR QUE ISTO É UM ARQUIVO SEPARADO ──
 *
 * É a única parte do parcelamento onde um erro não aparece na tela: aparece na
 * conferência do contrato, meses depois, com o titular reclamando de dez
 * centavos. Fora do serviço, ela é testável sem subir nada e é o lugar onde a
 * regra "a soma FECHA" mora de verdade.
 *
 * ── EM CENTAVOS INTEIROS, NUNCA EM DECIMAL DIVIDIDO ──
 *
 * Dividir 300.000,00 por 7 em qualquer aritmética decimal dá 42.857,142857…, e
 * arredondar sete vezes dá 300.000,01 ou 299.999,99 — um total que NÃO é o
 * combinado. Aqui a conta é feita em centavos inteiros, onde não existe dízima:
 * o quociente vai para todas, e o RESTO vai para a primeira parcela. A soma
 * fecha por construção, sem `CHECK` no banco e sem gatilho.
 */

/** R$ 300.000,00 → 30000000. Entra como texto porque dinheiro trafega como texto. */
export function paraCentavos(valor: string | Prisma.Decimal): bigint {
  const d = new Prisma.Decimal(valor.toString()).toDecimalPlaces(2);
  return BigInt(d.mul(100).toFixed(0));
}

/** 30000000 → "300000.00". */
export function deCentavos(centavos: bigint): string {
  const neg = centavos < 0n;
  const abs = neg ? -centavos : centavos;
  const inteiros = abs / 100n;
  const resto = abs % 100n;
  return `${neg ? '-' : ''}${inteiros}.${resto.toString().padStart(2, '0')}`;
}

export interface LinhaDoCronograma {
  numero: number;
  valor: string;
  vencimento: string;
}

/**
 * Monta o cronograma: entrada opcional (número 0) e N parcelas mensais.
 *
 * @param total quanto o escritório paga ao titular, no todo
 * @param entrada quanto sai no ato (número digitado pelo operador — NÃO muda)
 * @param parcelas quantas vezes o restante é dividido
 * @param primeiroVencimento AAAA-MM-DD da primeira parcela
 * @param intervaloMeses de quantos em quantos meses
 */
export function montarCronograma(params: {
  total: string;
  entrada?: string;
  parcelas: number;
  primeiroVencimento: string;
  intervaloMeses?: number;
  /** Data do ato, para o vencimento da entrada. Padrão: hoje. */
  hoje?: Date;
}): LinhaDoCronograma[] {
  const { parcelas, primeiroVencimento, intervaloMeses = 1 } = params;

  const totalCent = paraCentavos(params.total);
  const entradaCent = params.entrada ? paraCentavos(params.entrada) : 0n;

  if (totalCent <= 0n) throw new Error('O valor total precisa ser positivo.');
  if (entradaCent < 0n) throw new Error('A entrada não pode ser negativa.');
  if (entradaCent >= totalCent) {
    throw new Error('A entrada não pode ser igual nem maior que o total: aí não há o que parcelar.');
  }
  if (!Number.isInteger(parcelas) || parcelas < 1) {
    throw new Error('Informe em quantas vezes o restante é dividido.');
  }

  const restante = totalCent - entradaCent;
  if (restante < BigInt(parcelas)) {
    /* Cada parcela precisa valer pelo menos um centavo. Sem esta recusa, dividir
       R$ 5,00 em 700 vezes geraria linhas de zero — e um cronograma de zeros
       parece dado, não erro. */
    throw new Error(
      `R$ ${deCentavos(restante)} não se divide em ${parcelas} parcelas de pelo menos um centavo.`,
    );
  }

  const linhas: LinhaDoCronograma[] = [];

  if (entradaCent > 0n) {
    linhas.push({
      numero: 0,
      valor: deCentavos(entradaCent),
      vencimento: emISO(params.hoje ?? new Date()),
    });
  }

  const cada = restante / BigInt(parcelas);
  const resto = restante % BigInt(parcelas);

  for (let i = 0; i < parcelas; i++) {
    /* O RESÍDUO vai para a PRIMEIRA parcela, e nunca para a entrada: a entrada é
       número que o operador digitou e combinou com o titular — mudá-la em um
       centavo por conta do arredondamento seria o sistema alterando, sozinho, um
       valor acordado. */
    const valor = i === 0 ? cada + resto : cada;
    linhas.push({
      numero: i + 1,
      valor: deCentavos(valor),
      vencimento: somarMeses(primeiroVencimento, i * intervaloMeses),
    });
  }

  return linhas;
}

/**
 * A soma das linhas, para a tela e o teste conferirem contra o combinado.
 *
 * Pede só `{ valor }`, e não uma `LinhaDoCronograma` inteira: quem soma o que
 * já está gravado no banco não tem uma linha recém-calculada em mãos, e exigir
 * uma obrigaria o chamador a inventar um `vencimento` de mentira só para
 * satisfazer o tipo — o começo de um campo falso que um dia alguém lê.
 */
export function somaDoCronograma(linhas: { valor: string }[]): string {
  return deCentavos(linhas.reduce((s, l) => s + paraCentavos(l.valor), 0n));
}

const emISO = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Soma meses a uma data AAAA-MM-DD, SEM deixar o dia transbordar.
 *
 * 31/01 + 1 mês em JavaScript vira 03/03, porque 31 de fevereiro não existe e a
 * data "vaza" para o mês seguinte. Num cronograma isso significaria pular
 * fevereiro inteiro e cobrar duas vezes em março. Aqui o dia é limitado ao
 * último do mês de destino: 31/01 → 28/02 → 31/03 → 30/04.
 */
export function somarMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 + meses, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimoDia));
  return emISO(alvo);
}
