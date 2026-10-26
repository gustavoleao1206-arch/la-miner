import type { MetadataRoute } from 'next';

/**
 * O `robots.txt`, que não existia — o domínio respondia 404 nele.
 *
 * ── POR QUE ISTO NÃO É DETALHE ──
 *
 * O layout do site declara `robots: { index: true }` para a landing ser
 * encontrada, e o layout raiz declara `noindex` para o painel. Essa meta tag,
 * porém, só é lida DEPOIS que o buscador baixa a página — e para baixar uma
 * página do painel ele precisa primeiro tentar acessá-la. O robots.txt é o que
 * evita a tentativa: barreira na porta, e não aviso na parede de dentro.
 *
 * O `disallow` lista as rotas por prefixo, e inclui as PÚBLICAS que não devem
 * ser indexadas mesmo assim — confirmação de e-mail e redefinição de senha
 * carregam token na URL, e página com credencial no endereço não pode acabar
 * num índice de buscador.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        /* O sistema. */
        '/login',
        '/dashboard',
        '/carteira',
        '/funil',
        '/consulta',
        '/meu-dia',
        '/equipe',
        '/fila',
        '/importacao',
        '/processo/',
        '/seguranca',
        '/assinatura',
        '/auditoria',
        '/cobranca',
        '/clientes',
        /* Públicas, mas transacionais: levam token na URL ou dependem de um
           fluxo iniciado por e-mail. Não têm o que oferecer a quem busca. */
        '/cadastro',
        '/confirmar-email',
        '/esqueci-senha',
        '/redefinir-senha',
      ],
    },
    sitemap: 'https://laminer.com.br/sitemap.xml',
  };
}
