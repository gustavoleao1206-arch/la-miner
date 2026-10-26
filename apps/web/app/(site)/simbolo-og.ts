/**
 * O símbolo da marca embutido, para o cartão de compartilhamento.
 *
 * ── POR QUE EMBUTIDO, E NÃO LIDO DO DISCO ──
 *
 * A primeira tentativa foi o padrão documentado do Next,
 * `fetch(new URL('../../public/...', import.meta.url))`. Ele responde 500 aqui:
 * `import.meta.url` resolve para `file://`, e o fetch do Node recusa esse
 * esquema ("not implemented... yet"). Trocar por `readFileSync` funcionaria em
 * desenvolvimento, mas o caminho relativo passa a depender de onde o bundle
 * pousa em produção — e a falha seria um cartão quebrado que ninguém vê, porque
 * quem compartilha o link não é quem o abre.
 *
 * Embutido não tem esse modo de falha: se o arquivo compila, a arte está lá.
 * O custo é este blob de ~8 KB no fonte, e ele é pequeno de propósito — 86×124,
 * o dobro dos 43×62 que o cartão renderiza.
 *
 * ── PARA REGERAR ──
 *
 * Fonte: apps/web/public/marca/simbolo-miner.png (354×512, com alpha).
 * Reduzir para 86×124 com LANCZOS e reescrever este arquivo. Não editar à mão.
 */
export const SIMBOLO_OG_DATA_URI =
  'data:image/png;base64,' +
  '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';
