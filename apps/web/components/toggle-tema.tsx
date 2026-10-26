'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Moon, Sun } from 'lucide-react';
import { useTema } from '@/lib/tema';
import { cn } from '@/lib/utils';

/**
 * Alterna claro/escuro. O ícone atual sai girando e desbotando enquanto o novo
 * entra — a troca de tema tem de PARECER uma troca, não um pisca-pisca.
 *
 * `aria-pressed` e o rótulo dinâmico deixam o controle legível para leitor de
 * tela; sem o ícone, ele ainda diz o que faz.
 */
export function ToggleTema({ className }: { className?: string }) {
  const { tema, alternar } = useTema();
  const escuro = tema === 'escuro';

  return (
    <button
      type="button"
      onClick={alternar}
      aria-pressed={escuro}
      aria-label={escuro ? 'Mudar para o tema claro' : 'Mudar para o tema escuro'}
      title={escuro ? 'Tema claro' : 'Tema escuro'}
      className={cn(
        'relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-sm',
        'border border-linha bg-superficie text-ink-2',
        'transition-colors duration-200 hover:border-linha-2 hover:text-ink',
        'focus-visible:ring-2 focus-visible:ring-marca-ciano/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        className,
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={tema}
          initial={{ y: 12, opacity: 0, rotate: -35 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          exit={{ y: -12, opacity: 0, rotate: 35 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="absolute"
        >
          {escuro ? <Moon className="h-[17px] w-[17px]" /> : <Sun className="h-[17px] w-[17px]" />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
