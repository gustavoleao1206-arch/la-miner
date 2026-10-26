import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Vitest para o front. Separado do Jest da API de propósito: o back é Node puro
 * e o front precisa de DOM (jsdom) e do transform de JSX. Um runner só serviria
 * mal aos dois — aqui cada workspace usa a ferramenta certa.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mesmo alias do tsconfig (`@/*` → raiz do app), senão os imports dos
    // testes divergiriam dos imports do código.
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    // Só arquivos de teste sob test/ ou co-locados; nunca o build.
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
  },
});
