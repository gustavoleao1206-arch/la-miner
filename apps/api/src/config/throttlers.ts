/**
 * Os baldes de rate limit registrados no app, com NOME.
 *
 * Extraído do `app.module.ts` pelo mesmo motivo do `log-redact.ts`: enquanto os
 * nomes viviam só dentro do `ThrottlerModule.forRoot([...])`, nenhum teste podia
 * conferir se um `@Throttle({ ... })` espalhado pelos controllers citava um balde
 * QUE EXISTE.
 *
 * E essa era a falha real, não hipotética: o login declarava
 * `@Throttle({ default: ... })` enquanto os baldes se chamam `curto` e `medio`.
 * O nome inexistente virou metadado morto — o teto anunciado era 5/min e o
 * efetivo era o global. Nada denunciou: o código parecia certo, o comentário
 * afirmava a proteção, e a suíte passava. Com os nomes exportados daqui, um
 * teste consegue cruzar decorator × registro e reprovar o erro de digitação.
 *
 * ── OS DOIS BALDES SE ACUMULAM ──
 *
 * Uma rota é limitada por TODOS os baldes ao mesmo tempo, e um `@Throttle` só
 * sobrescreve os que nomear. Sobrescrever apenas `medio` deixa `curto` valendo
 * com o valor global — o que é bom para rota de usuário e ruim para webhook de
 * gateway, que chega em rajada legítima. Quem afrouxa um teto precisa lembrar do
 * outro.
 */
export const THROTTLERS = [
  { name: 'curto', ttl: 1_000, limit: 10 },
  { name: 'medio', ttl: 60_000, limit: 120 },
];

/** Só os nomes — é contra esta lista que os `@Throttle` são conferidos. */
export const NOMES_DE_THROTTLER = THROTTLERS.map((t) => t.name);
