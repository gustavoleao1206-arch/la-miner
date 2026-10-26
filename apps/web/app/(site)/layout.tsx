import type { Metadata } from 'next';

import { AvisoCookies } from '@/components/aviso-cookies';

/**
 * Layout do site público. Vive fora do painel de propósito: nada de sidebar,
 * de header autenticado ou de provider que dependa de sessão.
 *
 * ── POR QUE ESTE ARQUIVO PRECISA EXISTIR SÓ PARA O `robots` ──
 *
 * O layout raiz declara `robots: { index: false, follow: false }`, e está certo:
 * ele cobre o painel, e painel indexado é vazamento de superfície. Mas o Next
 * herda metadata de cima para baixo — sem esta sobrescrita, a landing comercial
 * nasceria com `noindex` e o domínio que vai ser divulgado seria invisível para
 * buscador. É uma linha de configuração que decide se o site existe ou não para
 * quem procura.
 *
 * `metadataBase` alimenta as URLs absolutas do Open Graph. Sem ela o Next
 * resolve caminhos relativos contra `localhost` e o card compartilhado no
 * WhatsApp aponta para a máquina de quem compilou.
 */
export const metadata: Metadata = {
  metadataBase: new URL('https://laminer.com.br'),
  title: {
    default: 'Leão Amorim Miner: precatórios e pré-precatórios com o titular já identificado',
    template: '%s · Leão Amorim Miner',
  },
  description:
    'Todo mês, 250 créditos judiciais com o titular identificado e o contato conferido. ' +
    'A parte difícil da prospecção já vem pronta.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    url: '/',
    siteName: 'Leão Amorim Miner',
    title: 'Precatórios e pré-precatórios com o titular já identificado',
    description:
      'Todo mês, 250 créditos judiciais com o titular identificado e o contato conferido.',
  },
};

export default function LayoutDoSite({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg text-ink antialiased">
      {children}
      {/* O aviso de cookies mora nas páginas PÚBLICAS (e no login): é onde um
          visitante chega sem nunca ter decidido nada. Dentro do painel ele seria
          ruído, porque ninguém entra lá sem ter passado por aqui antes. */}
      <AvisoCookies />
    </div>
  );
}
