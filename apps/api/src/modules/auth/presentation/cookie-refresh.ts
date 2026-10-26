import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';

/**
 * O refresh token vive num cookie httpOnly — nunca em sessionStorage.
 *
 * ── O QUE ISTO RESOLVE, E O QUE NÃO RESOLVE ──
 *
 * Resolve: um XSS não consegue mais LER o refresh e levá-lo embora. Antes ele
 * saía com `sessionStorage.getItem('miner.refresh')` e valia por dias — tomada
 * de conta duradoura, usável de outra máquina, muito depois do XSS ter sido
 * corrigido.
 *
 * NÃO resolve: um XSS na nossa própria origem continua podendo CHAMAR
 * `/auth/refresh` com o cookie do usuário e usar a resposta enquanto a página
 * estiver aberta. httpOnly impede a exfiltração, não o uso local. A defesa
 * contra isso é a CSP (item B4), não o cookie.
 *
 * ── PORQUE A LEITURA É À MÃO, SEM cookie-parser ──
 *
 * É um cookie só, de nome conhecido. Trocar isso por uma dependência nova
 * numa árvore de produção que já tem 1 vulnerabilidade crítica e 7 altas — e
 * que o item B6 existe para limpar — seria andar para trás.
 */

export const COOKIE_REFRESH = 'miner_refresh';

/**
 * Lê o cookie do cabeçalho cru.
 *
 * Cuidados que um `split(';')[0]` ingênuo erraria: o valor pode conter `=`
 * (JWT não contém, mas depender disso é frágil), pode vir entre aspas conforme
 * a RFC 6265, e o cookie procurado pode não ser o primeiro da lista.
 */
export function lerCookieRefresh(req: Request): string | undefined {
  const cru = req.headers.cookie;
  if (!cru) return undefined;

  for (const parte of cru.split(';')) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    if (parte.slice(0, igual).trim() !== COOKIE_REFRESH) continue;

    const valor = parte.slice(igual + 1).trim();
    const semAspas = valor.startsWith('"') && valor.endsWith('"') ? valor.slice(1, -1) : valor;
    try {
      return decodeURIComponent(semAspas);
    } catch {
      /* Valor malformado é entrada hostil ou lixo — tratar como ausente faz o
         fluxo cair em 401, que é o comportamento correto. */
      return undefined;
    }
  }
  return undefined;
}

/** `7d` → milissegundos. Mesmo formato de `JWT_REFRESH_TTL` usado no TokenService. */
function ttlParaMs(ttl: string): number {
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 7 * 86_400_000;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] ?? 1000;
  return Number(m[1]) * mult;
}

/**
 * Opções do cookie.
 *
 * `path` restringe o envio às rotas de autenticação: o cookie não acompanha as
 * centenas de chamadas da carteira, então não aparece em log, proxy ou aba de
 * rede de quem depura outra coisa. Também encolhe a superfície de CSRF para
 * duas rotas.
 *
 * `sameSite` é CONFIGURÁVEL porque depende de onde web e API forem publicadas:
 *  - subdomínios do MESMO domínio (app.x.com.br / api.x.com.br) → mesmo site,
 *    `strict` funciona e é o mais seguro;
 *  - domínios padrão da Render (miner-web.onrender.com / miner-api.onrender.com)
 *    → sites DIFERENTES, porque `onrender.com` está na Public Suffix List. Aí
 *    `strict` faria o navegador NUNCA enviar o cookie e a sessão jamais
 *    renovaria — falha silenciosa que só aparece 15 min depois do login.
 *    Nesse caso é `none`, que a validação de env obriga a vir com `secure`.
 */
export function opcoesCookieRefresh(config: ConfigService): CookieOptions {
  const producao = config.get('NODE_ENV') === 'production';
  const prefixo = config.get<string>('API_PREFIX', 'api');
  const sameSite = config.get<'lax' | 'strict' | 'none'>('COOKIE_SAMESITE', 'strict');

  return {
    httpOnly: true,
    secure: config.get<boolean>('COOKIE_SECURE', producao),
    sameSite,
    path: `/${prefixo}/v1/auth`,
    maxAge: ttlParaMs(config.get<string>('JWT_REFRESH_TTL', '7d')),
  };
}

export function definirCookieRefresh(res: Response, token: string, config: ConfigService): void {
  res.cookie(COOKIE_REFRESH, token, opcoesCookieRefresh(config));
}

/**
 * Apaga o cookie.
 *
 * `maxAge` fora: o navegador só descarta o cookie se path, domain, secure e
 * sameSite baterem com os da criação. Mandar `maxAge` junto do `clearCookie`
 * é o engano clássico que deixa o cookie vivo no logout.
 */
export function limparCookieRefresh(res: Response, config: ConfigService): void {
  const { maxAge: _ignorado, ...resto } = opcoesCookieRefresh(config);
  res.clearCookie(COOKIE_REFRESH, resto);
}
