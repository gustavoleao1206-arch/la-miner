import { stdSerializers } from 'pino';

/**
 * Mascara CPF e CNPJ em texto que vai para LOG.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * O `redact` do pino trabalha por CAMINHO (`req.body.cpf`, `req.headers.cookie`).
 * Serve para campo nomeado, e não alcança o CPF que viaja DENTRO de uma string —
 * que é exatamente onde ele estava:
 *
 *   GET /auditoria/cpf/39053344705                  ← no caminho
 *   GET /auditoria/consultas?cpfConsultado=390…     ← na query
 *   GET /carteira/buscar?termo=390…                 ← na query, quando se busca por CPF
 *
 * O serializer padrão do pino-http registra `url` e `query`, então as três
 * gravavam CPF em claro no log — um arquivo que se retém por meses, se replica
 * para agregador e não se apaga sob pedido do titular (LGPD art. 18).
 *
 * ── POR QUE MÁSCARA TOTAL, E NÃO OS 4 ÚLTIMOS DÍGITOS ──
 *
 * Log de HTTP é volumoso e serve para diagnosticar rota, status e latência.
 * Quem consultou qual CPF já é respondido pela tabela `ConsultaCliente`, que
 * existe para isso, é consultável e — ao contrário do log — é apagável. Guardar
 * dígito no log não acrescentaria capacidade de investigação; só espalharia o
 * dado por mais um lugar.
 *
 * ⚠ ALCANCE: isto protege o log DA APLICAÇÃO. A URL continua trafegando, e o
 * log de acesso do proxy/Render está fora do nosso alcance — tirar o CPF da URL
 * de vez é decisão à parte, com efeito no contrato da API.
 */

/* `(?<!\d)` e `(?!\d)` impedem que um número maior seja fatiado: sem eles,
   os 11 primeiros dígitos de um protocolo de 15 virariam "[CPF]" e o resto
   ficaria pendurado, produzindo log mais confuso que o original. */
const PADROES: RegExp[] = [
  /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, // CPF com máscara
  /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, // CNPJ com máscara
  /(?<!\d)\d{11}(?!\d)/g, // CPF só dígitos
  /(?<!\d)\d{14}(?!\d)/g, // CNPJ só dígitos
];

const SUBSTITUTO = '[documento]';

/**
 * Troca todo CPF/CNPJ reconhecível por `[documento]`.
 *
 * Falso positivo aceito de propósito: um telefone com DDD também tem 11
 * dígitos e será mascarado. Telefone é dado pessoal igual — mascarar de
 * sobra custa uma linha de log menos informativa; mascarar de menos vaza.
 */
export function mascararDocumento(texto: string): string {
  return PADROES.reduce((s, padrao) => s.replace(padrao, SUBSTITUTO), texto);
}

/** Aplica a máscara nas folhas de string de um objeto raso (query string). */
function mascararValores(valor: unknown): unknown {
  if (typeof valor === 'string') return mascararDocumento(valor);
  if (Array.isArray(valor)) return valor.map(mascararValores);
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, mascararValores(v)]),
    );
  }
  return valor;
}

/**
 * Serializer de requisição: o do pino, com `url` e `query` saneados.
 *
 * Envolve o padrão em vez de substituí-lo — assim `method`, `headers`,
 * `remoteAddress` e o que a biblioteca vier a acrescentar continuam vindo de
 * lá, e o `redact` configurado no app.module segue valendo por cima.
 */
export function serializarRequisicaoSemDocumento(req: unknown) {
  const base = stdSerializers.req(req as Parameters<typeof stdSerializers.req>[0]);
  return {
    ...base,
    url: typeof base.url === 'string' ? mascararDocumento(base.url) : base.url,
    query: mascararValores((base as { query?: unknown }).query),
  };
}
