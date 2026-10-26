import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { Space_Grotesk, Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ProvedorTema, SCRIPT_ANTI_FOUC } from '@/lib/tema';

const display = Space_Grotesk({ subsets: ['latin'], weight: ['400','500','600','700'], variable: '--font-display', display: 'swap' });
const body = Inter({ subsets: ['latin'], weight: ['400','500','600','700'], variable: '--font-body', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: ['400','500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Leão Amorim Miner',
  description: 'Sistema de Inteligência de Precatórios',
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * O Next marca com o nonce os scripts que ELE gera; este é nosso, escrito à
   * mão, e precisa recebê-lo explicitamente — sem isso a CSP o bloqueia e o
   * site abre piscando no tema errado (o problema que este script existe para
   * evitar). O `middleware.ts` põe o nonce em `x-nonce` a cada requisição.
   *
   * `await` porque o Next 15 tornou `headers()` assíncrono — daí o componente
   * ser `async`. Ler sem esperar devolvia uma Promise, e o `.get` nela não
   * existe: o TypeScript acusou, mas em JavaScript puro isso teria virado
   * `undefined` em silêncio, o script perderia o nonce e a CSP o bloquearia.
   */
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    /* suppressHydrationWarning: o script inline mexe na classe do <html> antes do
       React montar, então o HTML do servidor e o do cliente divergem de
       propósito nesse atributo — é o preço de não piscar no tema errado. */
    <html
      lang="pt-BR"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/* suppressHydrationWarning: por segurança, o navegador APAGA o atributo
            `nonce` do DOM depois de aplicá-lo (o valor sobrevive só em
            `element.nonce`). Na hidratação o React lê o atributo, encontra "" e
            acusa divergência contra o nonce que acabou de renderizar. É esperado
            e não indica erro — sem esta linha, o console de produção nasceria
            com um aviso permanente que ensinaria todo mundo a ignorar avisos. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: SCRIPT_ANTI_FOUC }}
        />
      </head>
      <body>
        <ProvedorTema>{children}</ProvedorTema>
      </body>
    </html>
  );
}
