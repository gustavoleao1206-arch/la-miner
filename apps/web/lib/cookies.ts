/**
 * O registro da decisão sobre cookies — a memória do aviso.
 *
 * ── O QUE O SITE GRAVA HOJE, MEDIDO ──
 *
 * Um cookie só: `miner_refresh`, httpOnly, criado no LOGIN para manter a sessão.
 * É "estritamente necessário" na definição do Guia de Cookies da ANPD, e
 * cookie necessário dispensa consentimento: a base é a execução do contrato.
 * A landing não grava cookie nenhum. Não há analytics, pixel ou rastreador.
 * O vídeo do YouTube só é carregado depois do clique, no domínio nocookie.
 *
 * Por isso o aviso de hoje é INFORMATIVO, com um botão só ("Entendi"). Um
 * "Aceitar / Recusar" sem nada que se possa recusar é exatamente o padrão que
 * a ANPD classifica como enganoso, e o comprador deste produto é advogado.
 *
 * ── POR QUE EXISTE ESTE ARQUIVO, ENTÃO ──
 *
 * Porque o dia em que entrar um analytics é o dia em que o aviso precisa virar
 * CONSENTIMENTO de verdade, com categorias. Este registro já nasce versionado e
 * com a categoria `analitica` em false: quem for ligar um rastreador amanhã
 * incrementa `VERSAO_AVISO` (todo visitante decide de novo), acrescenta a
 * pergunta na interface e condiciona o script a `decisao().analitica`. Nada
 * além disso.
 */

export const CHAVE_COOKIES = 'laminer.cookies';

/** Incrementar quando o aviso mudar de natureza, nunca por texto. */
export const VERSAO_AVISO = 1;

export interface DecisaoDeCookies {
  versao: number;
  decidiuEm: string;
  /** Sempre verdadeiro: é o que mantém a sessão; não se recusa. */
  essenciais: true;
  /** Hoje não existe rastreador; o campo existe para o dia em que existir. */
  analitica: boolean;
}

export function decisaoDeCookies(): DecisaoDeCookies | null {
  if (typeof window === 'undefined') return null;
  try {
    const cru = window.localStorage.getItem(CHAVE_COOKIES);
    if (!cru) return null;
    const d = JSON.parse(cru) as Partial<DecisaoDeCookies>;
    /* Versão antiga vale como "nunca decidiu": o aviso volta a aparecer, que é
       o comportamento certo quando a natureza dele mudou. */
    if (d.versao !== VERSAO_AVISO) return null;
    return d as DecisaoDeCookies;
  } catch {
    /* localStorage bloqueado (modo privado antigo, política de empresa): trata
       como não decidido, e o aviso aparece a cada visita. Pior seria quebrar. */
    return null;
  }
}

/**
 * ── O BLOQUEIO PRÉVIO ──
 *
 * Nenhum script de terceiro entra na página sem passar por aqui. Hoje a lista
 * de categorias não essenciais está vazia (não há analytics), e é exatamente
 * por isso que o mecanismo precisa existir ANTES: o dia em que alguém colar
 * uma tag do GA "só para testar" é o dia em que o consentimento passa a ser
 * exigido, e a tag tem que ser recusada pelo código, não por memória.
 */
export type CategoriaDeCookie = 'essenciais' | 'analitica';

export function permitido(categoria: CategoriaDeCookie): boolean {
  if (categoria === 'essenciais') return true;
  return decisaoDeCookies()?.analitica === true;
}

/**
 * Injeta um script externo SOMENTE se a categoria estiver consentida.
 * Devolve `false` quando recusa, e recusa em silêncio, sem erro no console,
 * porque o comportamento normal de quem não consentiu é nada acontecer.
 */
export function carregarScriptSeConsentido(categoria: CategoriaDeCookie, src: string): boolean {
  if (typeof document === 'undefined' || !permitido(categoria)) return false;
  if (document.querySelector(`script[src="${src}"]`)) return true;
  const s = document.createElement('script');
  s.src = src;
  s.async = true;
  s.dataset.categoria = categoria;
  document.head.appendChild(s);
  return true;
}

export function registrarDecisao(analitica = false): DecisaoDeCookies {
  const d: DecisaoDeCookies = {
    versao: VERSAO_AVISO,
    decidiuEm: new Date().toISOString(),
    essenciais: true,
    analitica,
  };
  try {
    window.localStorage.setItem(CHAVE_COOKIES, JSON.stringify(d));
  } catch {
    /* Sem armazenamento, a decisão vale só para esta página. */
  }
  return d;
}
