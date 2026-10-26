import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy por NONCE.
 *
 * ── POR QUE ESTE ARQUIVO EXISTE ──
 *
 * O B3 tirou o refresh token do alcance do JavaScript, mas fez questão de
 * registrar o que NÃO resolvia: um XSS na nossa origem continua podendo agir
 * enquanto a página está aberta. A CSP é a defesa contra isso — e ela só existe
 * aqui, no site. A API já vem com CSP e HSTS do helmet; o Next não põe nada.
 *
 * ── POR QUE NONCE, E NÃO `unsafe-inline` ──
 *
 * `script-src 'unsafe-inline'` é o jeito fácil, e não protege de quase nada:
 * script injetado é justamente script inline. Uma CSP assim passaria num
 * checklist e não pararia o ataque que ela promete parar — pior que não ter,
 * porque cria confiança falsa.
 *
 * Com nonce, só executa o script que carrega a marca sorteada nesta requisição.
 * O Next lê o nonce do cabeçalho `Content-Security-Policy` da REQUISIÇÃO (é por
 * isso que ele é reescrito abaixo, e não só na resposta) e o aplica sozinho nos
 * próprios scripts de hidratação.
 *
 * `strict-dynamic` completa: o navegador passa a ignorar lista de domínios para
 * script e confia apenas no que a cadeia com nonce carregar. É o que faz o
 * carregamento por chunks do Next continuar funcionando sem abrir a porta.
 *
 * ── CUSTO ASSUMIDO ──
 *
 * O nonce muda a cada requisição, então nenhuma página pode ser servida de
 * cache estático. Aqui isso não custa nada: tudo atrás do login já é dinâmico,
 * e a própria tela de login é um componente de cliente.
 *
 * `style-src` NÃO tem mais `unsafe-inline` — e a separação vale a explicação,
 * porque é sutil e um pentest a cobra pelo nome.
 *
 * A CSP nível 3 divide o que era um só: `style-src` governa BLOCOS `<style>`,
 * e `style-src-attr` governa o ATRIBUTO `style="..."`. Os dois usos que este
 * site faz caem em lados diferentes dessa linha:
 *
 *   • o Next injeta blocos `<style>` e recebe o MESMO nonce dos scripts — então
 *     `style-src 'self' 'nonce-...'` basta para eles;
 *   • o framer-motion escreve no atributo `style` a cada quadro de animação, e
 *     não há nonce que alcance atributo. Esse uso, e só ele, continua com
 *     `unsafe-inline`, agora confinado em `style-src-attr`.
 *
 * O ganho é real: antes, uma injeção de HTML conseguia plantar um `<style>`
 * inteiro (útil para exfiltrar dado com seletor de atributo e `background:
 * url()`); agora, não. Sobra o atributo, que é superfície bem menor.
 *
 * ⚠ Navegador antigo sem `style-src-attr` ignora a diretiva e cai no
 * `style-src`, que agora é restrito — a animação perderia o estilo inline. É o
 * lado seguro do erro (degrada visual, não abre brecha), e vale a pena porque
 * Chrome, Edge, Firefox e Safari atuais implementam a diretiva.
 */

/** Origem da API, para o `connect-src`. Sem ela, todo fetch seria bloqueado. */
function origemDaApi(): string {
  const bruta = process.env.NEXT_PUBLIC_API_URL?.trim() || 'http://localhost:3333/api';
  try {
    return new URL(bruta).origin;
  } catch {
    /* URL inválida: devolver vazio deixaria o connect-src só com 'self' e
       quebraria o site inteiro de um jeito difícil de diagnosticar. O build de
       produção já barra a ausência (lib/config.ts); aqui o fallback mantém o
       desenvolvimento de pé. */
    return 'http://localhost:3333';
  }
}

/**
 * O mesmo app serve DOIS sites: a landing comercial no ápice
 * (`laminer.com.br`) e o painel em `app.laminer.com.br`.
 *
 * ── POR QUE NO MESMO SERVIÇO ──
 *
 * Separar em dois apps custaria outro serviço na Render e duplicaria CSP,
 * tema, fontes e tokens — que já existem aqui e precisam ser os mesmos para os
 * dois parecerem o mesmo produto. Como `.com.br` é sufixo público, o ápice e o
 * subdomínio são *same-site*, então o cookie de sessão `SameSite=strict`
 * atravessa sem ajuste.
 *
 * ── O QUE ESTA FUNÇÃO DECIDE ──
 *
 * Só uma coisa: quem é dono da raiz `/`. No ápice, a landing. No `app.`, o
 * painel — que antes tinha um `app/page.tsx` só para redirecionar, e agora não
 * pode mais tê-lo, porque a landing ocupa esse arquivo.
 *
 * Hostname desconhecido (localhost, o `.onrender.com` de fábrica, um preview)
 * cai na landing. É o padrão certo: o painel continua alcançável digitando
 * `/dashboard`, enquanto a landing é o que se quer ver ao abrir a raiz durante
 * o desenvolvimento.
 */
function ehSubdominioDoPainel(request: NextRequest): boolean {
  /* `request.nextUrl.hostname` perde o host real atrás do proxy da Render; o
     cabeçalho `host` é o que o navegador pediu. A porta é descartada para
     `localhost:3000` e `localhost` se comportarem igual. */
  const host = (request.headers.get('host') ?? '').split(':')[0].toLowerCase();
  return host.startsWith('app.');
}

export function middleware(request: NextRequest) {
  /* Antes de qualquer trabalho: se o painel foi pedido pela raiz, o destino é
     o dashboard. Redirecionar aqui evita renderizar a landing para quem
     digitou `app.laminer.com.br` esperando entrar no sistema. */
  if (request.nextUrl.pathname === '/' && ehSubdominioDoPainel(request)) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const producao = process.env.NODE_ENV === 'production';

  const politica = [
    `default-src 'self'`,
    /* 'unsafe-eval' SÓ em desenvolvimento: o hot reload do Next compila com
       eval. Em produção ele não existe, que é onde a regra precisa valer.
       Montado por `filter` e não por interpolação: um ternário vazio deixava
       "'strict-dynamic' ;" com espaço solto antes do ponto e vírgula. */
    ['script-src', `'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`, producao ? '' : `'unsafe-eval'`]
      .filter(Boolean)
      .join(' '),
    /* Blocos `<style>`: nonce, como os scripts. O Next propaga o mesmo nonce. */
    `style-src 'self' 'nonce-${nonce}'`,
    /* Atributo `style="..."`: é o framer-motion, e só ele. Nonce não alcança
       atributo — por isso esta é a única diretiva que ainda abre a mão. */
    `style-src-attr 'unsafe-inline'`,
    /* i.ytimg.com: a miniatura do player da apresentacao (landing). A teoria
       diz que a CSP do pai nao alcanca o interior de um iframe cross-origin —
       e uma revisao chegou a mandar remover esta linha por "peso morto". O
       EXPERIMENTO diz outra coisa: sem a origem, o clique no play gera
       violacao de img-src no console citando a NOSSA politica, e o poster do
       player e bloqueado; com ela, console limpo. Reproduzido 2x em aba
       zerada (Chrome, 21/08/2026). Na duvida entre o modelo mental e o
       navegador, vale o navegador. So imagens, origem exata. */
    `img-src 'self' data: blob: https://i.ytimg.com`,
    `font-src 'self' data:`,
    /* O gateway do CNJ entra NOMEADO: a calculadora oficial de saldo é chamada
       DIRETO do navegador (o CNJ bloqueia IP estrangeiro e a nossa API mora nos
       EUA — ver lib/calculadora-cnj.ts). Esquecê-lo aqui foi um defeito real:
       a CSP matava o fetch antes de sair da página e a tela dizia "o CNJ não
       respondeu" para um bloqueio que era NOSSO. Origem exata, nunca *. */
    `connect-src 'self' ${origemDaApi()} https://gateway.cloud.pje.jus.br${producao ? '' : ' ws: wss:'}`,
    /* A apresentação em vídeo da landing é um embed do YouTube que só nasce
       depois do clique no pôster (telas-do-miner.tsx). Sem esta linha o
       `default-src 'self'` mata o iframe em silêncio — caixa vazia, sem erro
       na tela. Domínio nocookie e origem exata, nunca *: é o site inteiro que
       ganha permissão, não só aquela aba. */
    `frame-src https://www.youtube-nocookie.com`,
    /* Nada de plugin, e nada de embutir o painel num iframe alheio —
       `frame-ancestors` é o X-Frame-Options que os navegadores modernos leem. */
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    /* Impede que um formulário injetado poste as credenciais noutro servidor. */
    `form-action 'self'`,
    ...(producao ? ['upgrade-insecure-requests'] : []),
  ]
    .join('; ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  /* O nonce viaja no cabeçalho da REQUISIÇÃO porque é dali que o Next o lê para
     marcar os próprios scripts. Só na resposta, a página quebraria: a política
     valeria e nenhum script do Next teria a marca. */
  const cabecalhos = new Headers(request.headers);
  cabecalhos.set('x-nonce', nonce);
  cabecalhos.set('Content-Security-Policy', politica);

  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set('Content-Security-Policy', politica);
  return resposta;
}

export const config = {
  matcher: [
    /**
     * Tudo, menos o que não é documento: arquivo estático não executa script e
     * não precisa de nonce, e gerar um por asset tiraria o cache deles à toa.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
