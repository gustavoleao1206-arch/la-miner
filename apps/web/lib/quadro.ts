import type { Estagio, ItemFila } from '@/lib/api';

/**
 * O MIOLO DO QUADRO — regra pura, sem React e sem gesto.
 *
 * ── POR QUE ISTO É UM ARQUIVO SEPARADO ──
 *
 * A Etapa 5 acrescenta o arraste, e arraste é a única parte deste projeto que o
 * teste automático NÃO alcança: o ambiente de teste do front não calcula posição
 * de tela, então nenhum caso conseguiria afirmar "arrastei o cartão da coluna A
 * para a B". Se a regra morasse no manipulador do gesto, ela nasceria sem prova.
 *
 * Aqui a regra fica fora do gesto. O arraste e o menu "Mover para…" chamam AS
 * MESMAS funções — o menu é testado, e o que sobra sem cobertura é só a física
 * do ponteiro, que é o que a conferência no navegador de fato consegue ver.
 */

/** Uma coluna do quadro: o estágio, o que está carregado e o total de verdade. */
export interface Coluna {
  estagio: Estagio;
  itens: ItemFila[];
  /**
   * Quantos existem no servidor — NÃO `itens.length`.
   *
   * A coluna "Novos" de um cliente grande tem 3.000 processos e a tela carrega
   * 50. Um cabeçalho que contasse os cartões diria "50" e o escritório
   * concluiria que perdeu 2.950 — o número tem de vir do servidor, e a coluna
   * precisa dizer que está mostrando uma parte.
   */
  total: number;
}

/**
 * Estágios terminais: entrar neles encerra a negociação.
 *
 * Pedem confirmação porque o servidor NÃO valida transição nenhuma — mover de
 * "Novo" direto para "Fechado" passa e ainda escreve uma linha permanente na
 * timeline do processo. Num quadro, onde a distância entre duas colunas é um
 * gesto curto, isso é fácil de fazer sem querer.
 */
export const TERMINAIS: Estagio[] = ['FECHADO', 'PERDIDO'];

export function ehTerminal(estagio: Estagio): boolean {
  return TERMINAIS.includes(estagio);
}

/** O que fazer quando um cartão é solto (ou escolhido no menu). */
export type Movimento =
  | { tipo: 'nada' }
  | { tipo: 'grava'; de: Estagio; para: Estagio }
  | { tipo: 'confirma'; de: Estagio; para: Estagio; pedeMotivo: boolean };

/**
 * Decide o que acontece ao mover um cartão — sem executar nada.
 *
 * Devolver a decisão em vez de agir é o que permite ao teste afirmar a REGRA sem
 * simular rede, e ao arraste reaproveitá-la inteira.
 */
export function decidirMovimento(de: Estagio, para: Estagio): Movimento {
  /* Soltar na mesma coluna de onde saiu é o gesto mais comum de todos — a
     desistência. Gravar aqui encheria a timeline de linhas dizendo que nada
     aconteceu, e cada uma delas é permanente. */
  if (de === para) return { tipo: 'nada' };

  if (ehTerminal(para)) {
    return { tipo: 'confirma', de, para, pedeMotivo: para === 'PERDIDO' };
  }
  return { tipo: 'grava', de, para };
}

/**
 * Move o cartão entre as colunas do estado local, na posição certa.
 *
 * ── POR QUE A POSIÇÃO IMPORTA ──
 *
 * A fila ordena por VALOR, do maior para o menor. Empilhar o cartão no fim da
 * coluna de destino o colocaria abaixo de precatórios de R$ 5 mil sendo ele de
 * R$ 4 milhões — e na recarga seguinte ele saltaria para o topo sozinho, o que
 * parece defeito. Inserir ordenado deixa a tela igual ao que o servidor
 * devolveria.
 *
 * Devolve colunas NOVAS: o React só re-renderiza o que muda de identidade, e
 * mutar o array em lugar deixaria a tela parada com o dado certo por baixo.
 */
export function moverNoQuadro(
  colunas: Coluna[],
  processoId: string,
  de: Estagio,
  para: Estagio,
): Coluna[] {
  const origem = colunas.find((c) => c.estagio === de);
  const item = origem?.itens.find((i) => i.id === processoId);
  if (!item) return colunas;

  const movido: ItemFila = { ...item, estagio: para, estagioEm: new Date().toISOString() };

  return colunas.map((c) => {
    if (c.estagio === de) {
      return {
        ...c,
        itens: c.itens.filter((i) => i.id !== processoId),
        /* O total do servidor acompanha: o cabeçalho não pode continuar dizendo
           3.000 depois de o cartão ter saído da coluna. */
        total: Math.max(0, c.total - 1),
      };
    }
    if (c.estagio === para) {
      const itens = [...c.itens];
      const posicao = itens.findIndex((i) => valor(i) < valor(movido));
      itens.splice(posicao === -1 ? itens.length : posicao, 0, movido);
      return { ...c, itens, total: c.total + 1 };
    }
    return c;
  });
}

const valor = (i: ItemFila) => Number(i.valor ?? 0);

/**
 * Remove um cartão de todas as colunas — para quando o servidor diz 404.
 *
 * Devolver o cartão à origem seria reafirmar na tela o que o servidor acabou de
 * negar: aquele processo não está mais na carteira desta organização (saiu do
 * lote, foi devolvido, a assinatura mudou). Ele some, e o aviso explica.
 */
export function removerDoQuadro(colunas: Coluna[], processoId: string): Coluna[] {
  return colunas.map((c) =>
    c.itens.some((i) => i.id === processoId)
      ? { ...c, itens: c.itens.filter((i) => i.id !== processoId), total: Math.max(0, c.total - 1) }
      : c,
  );
}
