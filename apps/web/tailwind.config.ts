import type { Config } from 'tailwindcss';

/**
 * Tokens do Design System Leão Amorim.
 *
 * Cada cor aponta para uma variável CSS definida em globals.css — canais RGB
 * consumidos como `rgb(var(--x) / <alpha-value>)`, o que mantém o modificador de
 * opacidade do Tailwind funcionando (`bg-bg/50`, `border-linha/60`) e faz o tema
 * claro/escuro trocar sozinho, sem `dark:` espalhado pelos componentes.
 *
 * Nada de cor solta: o que não estiver aqui não deve aparecer na interface.
 */
const cor = (nome: string) => `rgb(var(--${nome}) / <alpha-value>)`;

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: cor('bg'), 2: cor('bg-2'), 3: cor('bg-3') },
        ink: { DEFAULT: cor('ink'), 2: cor('ink-2') },
        muted: { DEFAULT: cor('muted'), 2: cor('muted-2') },
        superficie: { DEFAULT: cor('superficie'), 2: cor('superficie-2') },
        linha: { DEFAULT: cor('linha'), 2: cor('linha-2') },
        /* Vidro carrega o próprio alfa (canais + opacidade na variável): é a
           única superfície translúcida, porque o blur precisa do fundo. */
        vidro: 'rgb(var(--vidro))',
        marca: {
          azul: cor('marca-azul'),
          'azul-2': cor('marca-azul-2'),
          ciano: cor('marca-ciano'),
          violeta: cor('marca-violeta'),
          ouro: cor('marca-ouro'),
        },
        aurora: { 1: cor('aurora-1'), 2: cor('aurora-2'), 3: cor('aurora-3'), 4: cor('aurora-4') },
        ok: cor('ok'),
        alerta: cor('alerta'),
        erro: cor('erro'),
      },
      fontFamily: {
        display: ['var(--font-display)', 'Segoe UI', 'system-ui', 'sans-serif'],
        body: ['var(--font-body)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: { DEFAULT: '16px', sm: '12px', lg: '20px', xl: '24px' },
      backgroundImage: {
        marca: 'linear-gradient(120deg, rgb(var(--marca-azul)) 0%, rgb(var(--marca-ciano)) 100%)',
        'marca-3':
          'linear-gradient(120deg, rgb(var(--marca-violeta)) 0%, rgb(var(--marca-azul)) 45%, rgb(var(--marca-ciano)) 100%)',
      },
      backdropBlur: { xs: '2px', '3xl': '64px' },
      boxShadow: {
        /* Sombras trocam com o tema — leves de dia, profundas de noite. */
        vidro: 'var(--sombra-vidro)',
        elevado: 'var(--sombra-elevado)',
        cartao: 'var(--sombra-cartao)',
        aura: '0 0 80px -20px rgb(var(--aurora-1) / 0.5)',
        brilho: 'var(--glow-marca)',
        'brilho-ciano': '0 0 32px -10px rgb(var(--marca-ciano) / 0.5)',
      },
      keyframes: {
        surgir: { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'none' } },
        pulsar: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.45' } },
        'brilho-passa': { '0%': { transform: 'translateX(-120%)' }, '100%': { transform: 'translateX(320%)' } },
      },
      animation: {
        surgir: 'surgir .4s cubic-bezier(.2,.7,.3,1) both',
        pulsar: 'pulsar 2s ease-in-out infinite',
        'brilho-passa': 'brilho-passa 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
