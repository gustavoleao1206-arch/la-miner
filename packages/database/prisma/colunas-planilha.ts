/**
 * Resolução de colunas de planilha a partir de um PerfilImportacao.
 *
 * ⚠ ARQUIVO ESPELHADO. Existem duas cópias que devem ser byte a byte idênticas:
 *     packages/database/prisma/colunas-planilha.ts        (seed)
 *     apps/api/src/modules/importacao/colunas-planilha.ts (API)
 *
 * Mesmo motivo do `timeline-processo.ts`: `@miner/database` publica apenas o
 * client gerado e o tsconfig da API compila só `src/**`, então um import
 * atravessando os dois pacotes quebraria o `nest build`. A duplicação é
 * tolerável porque o arquivo é puro — zero imports, zero Prisma.
 *
 * POR QUE existe: o seed lia a planilha por rótulos LITERAIS
 * ("Número do processo de precatório no TRF5") enquanto a API lia pelo perfil,
 * com aliases normalizados. Duas leituras diferentes do MESMO arquivo: uma
 * planilha com o cabeçalho levemente diferente entrava por um caminho e falhava
 * no outro, e ninguém saberia dizer qual estava certo. Agora os dois passam por
 * aqui, e o perfil é a única fonte de verdade sobre cabeçalho.
 */

/**
 * Reduz um cabeçalho à sua forma comparável.
 *
 * Sem acento, sem caixa, sem pontuação e sem espaço: "Situação do Requisitório",
 * "SITUACAO DO REQUISITORIO" e "situacao_do_requisitorio" viram a mesma chave.
 * É o que permite uma planilha real casar com o alias do perfil sem exigir que
 * o operador acerte o cabeçalho caractere a caractere.
 */
export function chaveColuna(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** `{ campoInterno: ["alias aceito", ...] }` — o formato de PerfilImportacao.mapaColunas. */
export type MapaColunas = Record<string, string[]>;

/**
 * Devolve um leitor de campos para uma linha bruta da planilha.
 *
 * O primeiro alias que existir na linha E tiver conteúdo vence. Ordem importa:
 * o perfil lista do mais específico para o mais genérico, então uma planilha com
 * "valor" e "valor atualizado individual" pega o que o perfil priorizou, e não o
 * que o Excel devolveu primeiro.
 */
export function lerCampos(bruto: Record<string, unknown>, mapa: MapaColunas) {
  const porChave = new Map<string, unknown>();
  for (const [k, v] of Object.entries(bruto)) porChave.set(chaveColuna(k), v);

  return (campo: string): string | null => {
    for (const alias of mapa[campo] ?? []) {
      const v = porChave.get(chaveColuna(alias));
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  };
}

/**
 * Valor monetário de planilha brasileira OU americana.
 *
 * Decide pelo ÚLTIMO separador: em "1.234,56" a vírgula vem depois, então ela é
 * o decimal; em "1,234.56" é o ponto. Assumir um dos dois formatos faria
 * "1.234" virar 1,234 — um precatório de mil reais lido como um real e vinte.
 */
export function valorDePlanilha(v: string | null): number | null {
  if (!v) return null;
  const limpo = v.replace(/[^\d.,-]/g, '');

  /* Sem dígito nenhum não é zero, é AUSÊNCIA. Antes, "sem valor" ou "-" viravam
     0 porque `Number('')` é 0 e `Number.isFinite(0)` é true — e num precatório
     R$ 0,00 é uma afirmação sobre o quanto a pessoa tem a receber, não um
     "não sei". O agregado do dashboard somaria zeros como se fossem medidos. */
  if (!/\d/.test(limpo)) return null;

  const ultimaVirgula = limpo.lastIndexOf(',');
  const ultimoPonto = limpo.lastIndexOf('.');

  let normalizado: string;
  if (ultimaVirgula > ultimoPonto) {
    // "1.234,56" — vírgula por último: ela é o decimal.
    normalizado = limpo.replace(/\./g, '').replace(',', '.');
  } else if (ultimaVirgula === -1 && /^-?\d{1,3}(\.\d{3})+$/.test(limpo)) {
    /* "1.234" e "1.234.567": só pontos, e cada grupo com EXATAMENTE 3 dígitos.
       É milhar brasileiro, não decimal americano.

       A ambiguidade é real — "1.234" isolado pode ser mil e duzentos (BR) ou um
       e pouco (US). O desempate é que dinheiro tem 2 casas decimais, não 3:
       um valor com três dígitos após o ponto quase nunca é decimal. E o custo
       de errar não é simétrico — ler R$ 1.234,00 como R$ 1,23 subestima um
       precatório em mil vezes. */
    normalizado = limpo.replace(/\./g, '');
  } else {
    // "1,234.56" ou "1234.56" — ponto é o decimal.
    normalizado = limpo.replace(/,/g, '');
  }

  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

/**
 * Converte a matriz de células em objetos, do mesmo jeito que o
 * `sheet_to_json` do SheetJS fazia: a primeira linha é o cabeçalho, célula
 * vazia vira `null`, e coluna sem cabeçalho é ignorada.
 *
 * Cabeçalho REPETIDO: fica a primeira ocorrência. O SheetJS sufixava a segunda
 * com "_1", que nenhum perfil de importação procura — nos dois casos a coluna
 * duplicada não é lida, e manter a primeira é o comportamento previsível.
 */
export function linhasEmObjetos(linhas: unknown[][]): Record<string, unknown>[] {
  const [cabecalho = [], ...corpo] = linhas;
  const colunas = cabecalho.map((c) => (c === null || c === undefined ? '' : String(c)));

  return corpo.map((linha) => {
    const registro: Record<string, unknown> = {};
    colunas.forEach((nome, i) => {
      if (nome === '' || nome in registro) return;
      const v = linha[i];
      registro[nome] = v === undefined ? null : v;
    });
    return registro;
  });
}
