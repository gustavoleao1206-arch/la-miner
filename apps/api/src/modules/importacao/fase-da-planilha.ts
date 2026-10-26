import type { FaseProcesso } from '@miner/database';

/**
 * Traduz o que a planilha diz sobre o estágio para `FaseProcesso`.
 *
 * ── POR QUE ISTO NÃO ADIVINHA ──
 *
 * A fase decide o que é distribuído (ver `FASES_DISTRIBUIVEIS`) e o que o
 * cliente vê como estágio na tela. Um palpite aqui vira venda errada: marcar
 * como "precatório expedido" uma oportunidade que ainda está em trânsito em
 * julgado promete exigibilidade que não existe.
 *
 * Então a regra é: reconheceu, traduz; não reconheceu, devolve `null` — e quem
 * chama recusa a LINHA, com o texto original na mensagem. Nunca há default.
 *
 * ── AS DUAS FORMAS QUE A PLANILHA USA ──
 *
 * O arquivo de 03/09/2026 traz DUAS colunas para a mesma coisa: "Fase", com um
 * número de 1 a 4, e "Descrição da fase", com o texto. O mapa de colunas do
 * perfil lista as duas como aliases do mesmo campo interno, e o leitor devolve a
 * primeira que tiver conteúdo — na prática, o número.
 *
 * Aceitar as duas formas não é indulgência: é o que faz o perfil continuar
 * lendo o arquivo se um dia a coluna numérica sair, ou se outra fonte trouxer
 * só o texto.
 */

/** Reduz o texto à forma comparável: sem acento, sem caixa, sem pontuação. */
function normalizar(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Os quatro estágios que a planilha nomeia, pelo código E pelo texto.
 *
 * ⚠ `PRECATORIO_EXPEDIDO` NÃO está aqui, e a ausência é deliberada. Ele é o que
 * a dívida consolidada dos TRFs traz — precatório já na fila orçamentária —, e
 * a planilha de pré-precatórios, por definição, não alcança esse estágio. Se um
 * dia ela passar a alcançar, o texto novo entra aqui explicitamente, e não por
 * um `else` que aceite qualquer coisa.
 */
const POR_CODIGO: Record<string, FaseProcesso> = {
  '1': 'TRANSITO_EM_JULGADO',
  '2': 'CALCULOS_HOMOLOGADOS',
  '3': 'REQUISITORIO_EXPEDIDO',
  '4': 'PRECATORIO_AUTUADO',
};

const POR_TEXTO: Record<string, FaseProcesso> = {
  transitoemjulgado: 'TRANSITO_EM_JULGADO',
  calculoshomologados: 'CALCULOS_HOMOLOGADOS',
  requisitorioexpedido: 'REQUISITORIO_EXPEDIDO',
  precatorioautuado: 'PRECATORIO_AUTUADO',
  /* O que a dívida consolidada dos TRFs seria, se um dia uma planilha o
     nomeasse por extenso. Nenhuma nomeia hoje — a fase de lá é decidida pelo
     perfil, não pela linha. */
  precatorioexpedido: 'PRECATORIO_EXPEDIDO',
};

/**
 * `null` significa "não reconheci", e é responsabilidade de quem chama recusar a
 * linha. Nunca significa "assuma o padrão".
 */
export function faseDaPlanilha(bruto: string | null): FaseProcesso | null {
  if (bruto === null) return null;
  const texto = bruto.trim();
  if (texto === '') return null;

  /* O código vem primeiro porque é o que a coluna "Fase" traz. `Number` e não
     regex: a célula pode chegar do Excel como 2, "2" ou "2.0", e todas as três
     são o mesmo estágio. Fracionário não é código de fase e cai fora. */
  const n = Number(texto);
  if (Number.isInteger(n) && String(n) in POR_CODIGO) return POR_CODIGO[String(n)];

  return POR_TEXTO[normalizar(texto)] ?? null;
}
