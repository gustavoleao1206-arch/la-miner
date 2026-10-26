import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifra simétrica para o segredo TOTP.
 *
 * ── POR QUE CIFRAR, E NÃO GUARDAR HASH ──
 *
 * Senha a gente guarda em hash porque nunca precisa dela de volta — basta
 * comparar. O segredo TOTP é o contrário: o servidor precisa DELE, em claro,
 * para calcular o código de cada 30 segundos. Hash não serve. Ou fica legível,
 * ou fica cifrado.
 *
 * E o modelo de ameaça aqui é justamente o banco. Todo o sentido do segundo
 * fator é sobreviver ao comprometimento do primeiro; um dump com os segredos em
 * claro entrega os dois de uma vez — quem tiver o arquivo gera os códigos de
 * qualquer usuário, para sempre, sem tocar no sistema. É o cenário que o C2
 * (backup cifrado, papel de menor privilégio) já tratava do lado do banco.
 *
 * Com a chave no AMBIENTE e o dado no banco, um vazamento só do banco não basta.
 *
 * ── AES-256-GCM, E NÃO CBC ──
 *
 * GCM é autenticado: a decifragem FALHA se o texto cifrado tiver sido alterado.
 * Em CBC, mexer no cifrado produz lixo que passa por segredo válido — o usuário
 * simplesmente nunca mais conseguiria entrar, sem nada indicar adulteração.
 *
 * ── O CAMPO `v1.` NO COMEÇO ──
 *
 * Trocar de algoritmo ou de chave um dia exige saber com o que cada linha foi
 * cifrada. Sem o prefixo, a migração seria adivinhação.
 */

const VERSAO = 'v1';
const ALGORITMO = 'aes-256-gcm';
/* 96 bits é o tamanho de nonce que o GCM foi projetado para usar: com ele o
   contador interno é usado direto, sem a derivação extra que outros tamanhos
   exigem. */
const TAM_IV = 12;
const TAM_TAG = 16;

/**
 * Deriva a chave de 32 bytes a partir do segredo do ambiente.
 *
 * HKDF em vez de usar a variável como chave crua por dois motivos: ela é texto
 * de tamanho livre (e o AES-256 quer exatamente 32 bytes), e o rótulo `info`
 * amarra a chave a ESTE uso — se o mesmo segredo um dia servir a outra coisa,
 * as duas chaves saem diferentes.
 */
const cache = new Map<string, Buffer>();

function derivarChave(segredo: string): Buffer {
  const emCache = cache.get(segredo);
  if (emCache) return emCache;

  const chave = Buffer.from(
    hkdfSync('sha256', Buffer.from(segredo, 'utf8'), Buffer.from('miner-mfa'), Buffer.from('totp-v1'), 32),
  );
  cache.set(segredo, chave);
  return chave;
}

export function cifrarSegredo(claro: string, chaveDoAmbiente: string): string {
  const iv = randomBytes(TAM_IV);
  const cipher = createCipheriv(ALGORITMO, derivarChave(chaveDoAmbiente), iv);
  const cifrado = Buffer.concat([cipher.update(claro, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSAO, iv.toString('base64url'), tag.toString('base64url'), cifrado.toString('base64url')].join(
    '.',
  );
}

export function decifrarSegredo(guardado: string, chaveDoAmbiente: string): string {
  const partes = guardado.split('.');
  if (partes.length !== 4 || partes[0] !== VERSAO) {
    throw new Error('Segredo MFA em formato desconhecido');
  }

  const [, ivB64, tagB64, cifradoB64] = partes;
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== TAM_IV || tag.length !== TAM_TAG) {
    throw new Error('Segredo MFA em formato desconhecido');
  }

  const decipher = createDecipheriv(ALGORITMO, derivarChave(chaveDoAmbiente), iv);
  decipher.setAuthTag(tag);
  /* `final()` é quem confere a tag. Chave errada ou texto adulterado estouram
     aqui — e é isso que se quer: falhar alto, e não devolver um segredo
     silenciosamente errado que faria todo código do usuário ser recusado sem
     explicação. */
  return Buffer.concat([
    decipher.update(Buffer.from(cifradoB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
