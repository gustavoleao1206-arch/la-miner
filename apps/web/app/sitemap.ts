import type { MetadataRoute } from 'next';

/**
 * O sitemap — três páginas, e é isso mesmo.
 *
 * Só entra aqui o que tem sentido para quem CHEGA de um buscador: a landing e
 * os dois documentos legais. Painel, cadastro e telas transacionais ficam de
 * fora, coerentes com o `robots.ts` — sitemap que anuncia rota bloqueada é
 * contradição que os próprios buscadores reportam como erro.
 *
 * As datas são FIXAS, e não `new Date()`: `lastModified` que muda a cada
 * requisição diz ao buscador que a página mudou toda vez que ele olha, o que
 * ensina o rastreador a ignorar o campo. A data das páginas legais é a mesma
 * vigência declarada nelas — quando o texto mudar, o número aqui muda junto.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://laminer.com.br';
  const legaisEm = new Date('2026-08-20T00:00:00.000Z');

  return [
    {
      url: base,
      lastModified: new Date('2026-08-19T00:00:00.000Z'),
      changeFrequency: 'monthly',
      priority: 1,
    },
    { url: `${base}/termos`, lastModified: legaisEm, changeFrequency: 'yearly', priority: 0.3 },
    {
      url: `${base}/privacidade`,
      lastModified: legaisEm,
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ];
}
