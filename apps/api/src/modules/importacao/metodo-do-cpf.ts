/**
 * COMO O RADAR ACHOU O CPF — e se vale pagar para enriquecê-lo.
 *
 * ── DE ONDE ISTO VEM ──
 *
 * Nenhuma fonte pública devolve o CPF do credor em campo: o radar o extrai do
 * TEXTO da publicação, e a planilha dele diz como, na coluna "Como o CPF foi
 * obtido". São três métodos, e eles não valem o mesmo. Medido em 20/09/2026,
 * cruzando 4.279 processos com o veredito da conferência de nome em produção:
 *
 *   junto ao nome do credor ....... ~90% confere   (o resto da base)
 *   rotulado CPF, credor unico ....  21% confere · 33% diverge · 45% sem veredito
 *
 * No método "rotulado", o radar acha um CPF com rótulo no texto e ASSUME que é
 * do único credor do polo ativo. Onde deu para conferir, 61% eram de outra
 * pessoa. São 28% das linhas de um radar e rendem um CPF bom a cada ~4,8
 * consultas pagas, contra ~1,1 no outro método — e cada CPF errado é dado
 * pessoal de um terceiro sem relação com o processo, comprado e gravado.
 *
 * O dono decidiu: essas linhas NÃO ENTRAM. Nem processo, nem pessoa, nem
 * consulta. Ficam registradas como IGNORADAS na importação, com o motivo, e a
 * simulação diz quantas são antes de qualquer gasto.
 *
 * ── LISTA DE NEGAÇÃO, E POR QUÊ ──
 *
 * Só o método MEDIDO como ruim é recusado. Método ausente (as planilhas dos
 * TRFs não têm a coluna) e método novo que o radar venha a inventar PASSAM:
 * recusar o desconhecido derrubaria em silêncio uma carga inteira no dia em que
 * o radar mudasse um rótulo. Se um método novo aparecer, ele entra, é
 * conferido como os outros, e a medição diz se merece vir para cá.
 */

/** Sem acento, sem caixa, sem pontuação — a mesma redução de `chaveColuna`. */
function chave(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const METODOS_RECUSADOS = new Set([chave('rotulado CPF, credor unico')]);

/** O texto que vai para o relatório da importação e para a tela. */
export const MOTIVO_METODO_RECUSADO =
  'CPF obtido pelo método "rotulado CPF, credor único", que erra mais do que acerta — linha não importada';

/** `true` quando a linha NÃO deve entrar por causa de como o CPF foi obtido. */
export function cpfDeMetodoRecusado(metodo: string | null | undefined): boolean {
  if (!metodo) return false;
  return METODOS_RECUSADOS.has(chave(metodo));
}
