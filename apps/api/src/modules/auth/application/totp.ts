import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * TOTP (RFC 6238) — o segundo fator, sem dependência nova.
 *
 * ── POR QUE ESCRITO AQUI, E NÃO IMPORTADO ──
 *
 * "Não implemente criptografia" é uma regra boa, e ela não se aplica: TOTP não
 * inventa primitiva nenhuma. É uma CONSTRUÇÃO sobre HMAC-SHA1, e o HMAC vem do
 * `node:crypto`, auditado. O que sobra é contagem de tempo e truncamento —
 * aritmética, especificada linha a linha na RFC.
 *
 * E há uma prova que fecha o argumento: a RFC 6238 publica VETORES DE TESTE
 * OFICIAIS. O spec ao lado roda todos, para SHA-1, SHA-256 e SHA-512. Uma
 * biblioteca de terceiro seria verificada exatamente do mesmo jeito — só que
 * com mais uma dependência numa árvore que o B6 e o B7 acabaram de limpar.
 *
 * ── O QUE NÃO ESTÁ AQUI ──
 *
 * Nada de armazenamento, política ou fluxo de login. Este arquivo só sabe
 * responder "este código confere com este segredo, neste instante?". É o que
 * torna a peça testável contra a RFC sem banco nenhum por perto.
 */

/** Alfabeto do Base32 (RFC 4648), que é o formato que os apps autenticadores leem. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function paraBase32(buffer: Buffer): string {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += BASE32[(valor << (5 - bits)) & 31];
  return saida;
}

export function deBase32(texto: string): Buffer {
  /* Espaços e minúsculas são o que a pessoa digita quando copia do app à mão;
     o padding `=` é opcional na prática. Recusar por isso seria transformar um
     detalhe de formatação em "código inválido". */
  const limpo = texto.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const c of limpo) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error(`Caractere inválido no segredo Base32: "${c}"`);
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo. 20 bytes = 160 bits, o tamanho que a RFC 4226 recomenda. */
export function gerarSegredo(): string {
  return paraBase32(randomBytes(20));
}

export type AlgoritmoTotp = 'sha1' | 'sha256' | 'sha512';

interface Opcoes {
  digitos?: number;
  periodoSegundos?: number;
  algoritmo?: AlgoritmoTotp;
}

/**
 * O código para um instante.
 *
 * `contador` é o número de períodos desde a época Unix — é ele que faz o código
 * mudar sozinho a cada 30 segundos, sem nenhuma comunicação entre o telefone e
 * o servidor.
 */
export function gerarCodigo(
  segredoBase32: string,
  emSegundos: number,
  { digitos = 6, periodoSegundos = 30, algoritmo = 'sha1' }: Opcoes = {},
): string {
  const contador = Math.floor(emSegundos / periodoSegundos);

  /* Big-endian de 8 bytes, como a RFC especifica. Escrever só 4 bytes daria o
     mesmo resultado por milênios (o contador só passa de 2^32 lá pelo ano
     6000) — mas é o campo de 8 bytes que entra no HMAC, e desviar do spec para
     economizar quatro bytes é o tipo de atalho que quebra na interoperabilidade
     com algum app, não aqui. */
  const bloco = Buffer.alloc(8);
  bloco.writeBigUInt64BE(BigInt(contador));

  const hmac = createHmac(algoritmo, deBase32(segredoBase32)).update(bloco).digest();

  /* Truncamento dinâmico da RFC 4226: os 4 bits finais escolhem de ONDE ler os
     4 bytes do código. O `& 0x7fffffff` zera o bit de sinal — sem ele, metade
     dos códigos sairia negativa. */
  const deslocamento = hmac[hmac.length - 1] & 0x0f;
  const binario =
    ((hmac[deslocamento] & 0x7f) << 24) |
    (hmac[deslocamento + 1] << 16) |
    (hmac[deslocamento + 2] << 8) |
    hmac[deslocamento + 3];

  return String(binario % 10 ** digitos).padStart(digitos, '0');
}

/**
 * Confere um código, tolerando relógio fora de sincronia.
 *
 * `janela = 1` aceita o período anterior e o seguinte — 90 segundos no total.
 * Sem tolerância, quem digita no fim do ciclo ou tem o telefone alguns segundos
 * adiantado é recusado com o código CERTO, e a pessoa conclui que o MFA está
 * quebrado. Aceitar demais é o erro oposto: cada período a mais é uma janela a
 * mais para um código interceptado.
 *
 * A comparação é em tempo CONSTANTE. Comparar com `===` vazaria, pelo tempo de
 * resposta, quantos dígitos iniciais estavam certos — e um código de 6 dígitos
 * é curto o bastante para isso importar.
 */
export function conferirCodigo(
  segredoBase32: string,
  codigo: string,
  emSegundos: number,
  opcoes: Opcoes & { janela?: number } = {},
): boolean {
  return conferirComContador(segredoBase32, codigo, emSegundos, opcoes).confere;
}

/**
 * O mesmo que `conferirCodigo`, mas diz TAMBÉM qual período casou.
 *
 * Existe por causa do replay. Um código vale por até 90 segundos (a janela de
 * tolerância acima), e nesse intervalo ele funciona quantas vezes for
 * apresentado — quem interceptar um código digitado, por phishing ou por um
 * ombro, tem uma janela real para usá-lo.
 *
 * Quem guarda o último contador aceito fecha essa janela: um código só serve uma
 * vez por conta. Mas para guardar é preciso SABER qual foi, e é só isso que este
 * retorno acrescenta. A decisão de recusar a repetição é de quem chama — aqui
 * não há estado.
 */
export function conferirComContador(
  segredoBase32: string,
  codigo: string,
  emSegundos: number,
  { janela = 1, ...opcoes }: Opcoes & { janela?: number } = {},
): { confere: boolean; contador: number | null } {
  const limpo = (codigo ?? '').replace(/\D/g, '');
  const digitos = opcoes.digitos ?? 6;
  if (limpo.length !== digitos) return { confere: false, contador: null };

  const periodo = opcoes.periodoSegundos ?? 30;
  let contador: number | null = null;

  /* Sem `break` ao acertar: sair mais cedo faz o tempo de resposta revelar QUAL
     período casou, o que é informação sobre o relógio do usuário. O laço é de
     três voltas — o custo de terminá-lo é irrelevante. */
  for (let salto = -janela; salto <= janela; salto++) {
    const instante = emSegundos + salto * periodo;
    const esperado = gerarCodigo(segredoBase32, instante, opcoes);
    const a = Buffer.from(esperado);
    const b = Buffer.from(limpo);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      contador = Math.floor(instante / periodo);
    }
  }
  return { confere: contador !== null, contador };
}

/**
 * A URI que vira QR code no app autenticador.
 *
 * O `issuer` aparece duas vezes de propósito: no rótulo e como parâmetro. Os
 * apps divergem sobre qual deles leem, e sem os dois a conta entra na lista
 * sem nome — o usuário fica com "Chave 1", "Chave 2" e não sabe qual é qual.
 */
export function uriDeProvisionamento(params: {
  segredoBase32: string;
  conta: string;
  emissor: string;
}): string {
  const rotulo = encodeURIComponent(`${params.emissor}:${params.conta}`);
  const q = new URLSearchParams({
    secret: params.segredoBase32,
    issuer: params.emissor,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${rotulo}?${q}`;
}
