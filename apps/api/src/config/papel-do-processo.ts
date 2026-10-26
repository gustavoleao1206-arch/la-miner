/**
 * Que papel este processo cumpre.
 *
 * ── POR QUE SEPARAR ──
 *
 * Hoje um processo só faz tudo: serve HTTP, consome a fila de enriquecimento e
 * dispara os quatro crons. Três consequências, e a terceira é a que já mordeu
 * de verdade nesta base:
 *
 *  1. Um job pesado disputa CPU com as requisições — o cliente sente a lentidão
 *     de um trabalho que não é dele.
 *  2. Reiniciar a API (deploy) mata o job em voo. O BullMQ recupera, mas a
 *     consulta paga que estava no ar vira retentativa — e retentativa de
 *     consulta paga é dinheiro.
 *  3. Os CRONS rodam em TODA instância. Com uma só, passa. Ao escalar para
 *     duas, os quatro disparam em duplicidade — inclusive a sincronização, que
 *     gasta crédito da Contactra.
 *
 * ── POR QUE UM INTERRUPTOR, E NÃO DOIS MÓDULOS ──
 *
 * Duas árvores de módulos divergem: alguém acrescenta um provider numa e
 * esquece a outra, e o worker passa a rodar com metade da configuração. O
 * mesmo AppModule nos dois papéis mantém uma fonte só; o que muda é O QUE é
 * registrado.
 *
 * ── O PADRÃO É `tudo` DE PROPÓSITO ──
 *
 * Em desenvolvimento, subir dois processos para ver uma tela seria atrito puro.
 * `tudo` preserva exatamente o comportamento de hoje. A separação é decisão de
 * PRODUÇÃO, tomada no render.yaml — e a validação de env exige que lá seja
 * explícita.
 */
export type PapelDoProcesso = 'api' | 'worker' | 'tudo';

export function papelDoProcesso(): PapelDoProcesso {
  const bruto = (process.env.PAPEL_PROCESSO ?? 'tudo').trim().toLowerCase();
  return bruto === 'api' || bruto === 'worker' ? bruto : 'tudo';
}

/** Este processo consome a fila e dispara os crons? */
export function ehWorker(): boolean {
  const p = papelDoProcesso();
  return p === 'worker' || p === 'tudo';
}

/** Este processo serve HTTP? */
export function ehApi(): boolean {
  const p = papelDoProcesso();
  return p === 'api' || p === 'tudo';
}
