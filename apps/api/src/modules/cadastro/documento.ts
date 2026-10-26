/**
 * Validação de CPF e CNPJ pelos dígitos verificadores.
 *
 * ── POR QUE VALIDAR AQUI, SE O ASAAS TAMBÉM VALIDA ──
 *
 * Porque o erro dele chega tarde e ilegível. O cadastro grava organização,
 * usuário e assinatura ANTES de falar com o gateway (ordem deliberada: sobra
 * conta sem cobrança, que é reconciliável, e não cobrança sem conta). Um CNPJ
 * digitado errado só estouraria na emissão — depois de a conta existir, com uma
 * mensagem do gateway no meio da tela de quem estava tentando comprar.
 *
 * Conferir o dígito custa microssegundos e transforma isso num campo vermelho
 * no formulário, antes de qualquer escrita.
 *
 * ── O QUE ESTA FUNÇÃO NÃO FAZ ──
 *
 * Não diz se o documento EXISTE, nem se pertence a quem digitou. Dígito
 * verificador é só a soma de controle: pega erro de digitação, não fraude.
 * Quem confirma existência é a Receita, e não consultamos a Receita aqui.
 */

/** Só os dígitos. Aceita o documento como o usuário digitou, com ponto e traço. */
export function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * Rejeita repetições como 111.111.111-11.
 *
 * Elas passam na conta dos dígitos verificadores — o algoritmo as considera
 * válidas —, e é justamente por isso que todo validador sério as barra à parte.
 * São o valor que se digita para "preencher o campo e seguir".
 */
function todosIguais(digitos: string): boolean {
  return /^(\d)\1+$/.test(digitos);
}

/** Dígito verificador pelo módulo 11, com os pesos que a regra do documento manda. */
function digitoModulo11(base: string, pesos: number[]): number {
  const soma = base
    .split('')
    .reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
  const resto = soma % 11;
  /* Resto 0 ou 1 → dígito 0. É a regra, e escrevê-la como `< 2` é o que evita
     o clássico "resto 1 vira 10" que produz um dígito de dois algarismos. */
  return resto < 2 ? 0 : 11 - resto;
}

export function cpfValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 11 || todosIguais(d)) return false;

  const primeiro = digitoModulo11(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (primeiro !== Number(d[9])) return false;

  const segundo = digitoModulo11(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return segundo === Number(d[10]);
}

/**
 * O CPF dentro de um texto livre — SÓ quando ele está sozinho numa corrida de
 * exatamente 11 dígitos.
 *
 * ── POR QUE NÃO DESLIZA UMA JANELA DENTRO DE CORRIDAS MAIORES ──
 *
 * Seria tentador procurar o CPF dentro de "1239053344705", confiando no dígito
 * verificador como peneira. Ele só é boa peneira quando a corrida TEM 11
 * dígitos — aí derruba 99% (medido: 1,00% de falso positivo em celular com
 * DDD). Deslizando dentro de corridas longas desaba, porque cada posição é uma
 * chance nova:
 *
 *   corrida de 13 dígitos ........ 2,8%
 *   corrida de 20 dígitos ........ 8,8%
 *   nº de precatório do TRF5
 *   colado SEM máscara ........... 26,1%
 *
 * E os falsos positivos CONCENTRAM: a cauda do tribunal/ano é comum a todo
 * número do mesmo lote, então mais da metade dos acertos cai em dois valores.
 * Seria uma máquina de carimbar o mesmo CPF inexistente em milhares de linhas.
 *
 * Numa trilha de prestação de contas, não achar é recuperável; achar errado não
 * é. "39053344705 81" continua funcionando — o espaço separa as corridas.
 */
export function cpfEmTexto(texto: string): string | null {
  for (const corrida of texto.match(/\d+/g) ?? []) {
    if (corrida.length === 11 && cpfValido(corrida)) return corrida;
  }
  return null;
}

export function cnpjValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 14 || todosIguais(d)) return false;

  /* Os pesos do CNPJ ciclam de 2 a 9 — não são decrescentes contínuos como os
     do CPF. Reaproveitar a sequência do CPF aqui é o erro mais comum deste
     algoritmo, e ele valida documentos falsos em vez de recusá-los. */
  const primeiro = digitoModulo11(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (primeiro !== Number(d[12])) return false;

  const segundo = digitoModulo11(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return segundo === Number(d[13]);
}

/** CPF (11) ou CNPJ (14) — é o que o Asaas aceita como `cpfCnpj`. */
export function documentoValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

/**
 * Telefone brasileiro com DDD: 10 dígitos (fixo) ou 11 (celular).
 *
 * O DDD válido começa em 11 — não existe DDD 01..10 —, e o celular tem 9 na
 * primeira posição depois dele. Sem essas duas checagens, "0000000000" passa.
 */
export function telefoneValido(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 10 && d.length !== 11) return false;
  if (Number(d.slice(0, 2)) < 11) return false;
  if (d.length === 11 && d[2] !== '9') return false;
  return true;
}
