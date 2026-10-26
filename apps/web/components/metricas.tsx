'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

/**
 * Conta de 0 até o valor com easeOutCubic.
 *
 * Parado, "R$ 1,19 Bi" é só um número. Subindo, o olho acompanha a escala e
 * sente o tamanho da carteira — é a diferença entre informar e impressionar.
 * Guarda o último valor num ref para que atualizações partam de onde estavam,
 * em vez de piscar de volta ao zero.
 */
export function useContador(valor: number, duracao = 1500) {
  const [n, setN] = useState(0);
  const de = useRef(0);

  useEffect(() => {
    /* Sem animação possível → vai DIRETO ao valor final. São dois casos, e o
       segundo custava um "R$ 0,00" na tela:
        1. o usuário pediu menos movimento;
        2. a ABA ESTÁ OCULTA — aí o navegador suspende o requestAnimationFrame,
           `passo` nunca roda, e o contador congela no quadro inicial: ZERO. Quem
           abre o painel em aba de fundo (ctrl+clique, sessão restaurada) via a
           própria carteira valendo R$ 0,00, com o resto da tela certo em volta.
           Número ERRADO é pior que número nenhum — que é exatamente a regra
           enunciada no `useAnimavel` logo abaixo e que este hook não aplicava. */
    const semAnimacao =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.visibilityState !== 'visible';
    if (semAnimacao) {
      de.current = valor;
      setN(valor);
      return;
    }
    const inicio = performance.now();
    const partida = de.current;
    let raf = 0;
    const passo = (t: number) => {
      const p = Math.min((t - inicio) / duracao, 1);
      const atual = partida + (valor - partida) * (1 - Math.pow(1 - p, 3));
      de.current = atual;
      setN(atual);
      if (p < 1) raf = requestAnimationFrame(passo);
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
  }, [valor, duracao]);

  return n;
}

/** Número animado já formatado. `formatar` recebe o valor em curso. */
export function Contador({
  valor,
  formatar,
  className,
}: {
  valor: number;
  formatar: (n: number) => string;
  className?: string;
}) {
  const n = useContador(valor);
  return <span className={className}>{formatar(n)}</span>;
}

/**
 * Em aba oculta o navegador suspende o requestAnimationFrame, então animações
 * de entrada nunca saem do quadro inicial — e um gráfico que anima a partir do
 * zero fica simplesmente em branco. Quando não dá para animar, renderizamos
 * direto no estado final: melhor sem animação do que sem conteúdo.
 */
export function useAnimavel() {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    setOk(document.visibilityState === 'visible');
  }, []);
  return ok;
}

/** Anel de progresso com varredura animada. */
export function AnelProgresso({
  percentual,
  tamanho = 132,
  espessura = 9,
  children,
}: {
  percentual: number;
  tamanho?: number;
  espessura?: number;
  children?: React.ReactNode;
}) {
  const r = (tamanho - espessura) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, percentual));
  const animar = useAnimavel();
  const alvo = circ - (circ * pct) / 100;

  return (
    <div className="relative shrink-0" style={{ width: tamanho, height: tamanho }}>
      <svg width={tamanho} height={tamanho} className="-rotate-90">
        <defs>
          <linearGradient id="anel-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8b5cff" />
            <stop offset="50%" stopColor="#4f7cff" />
            <stop offset="100%" stopColor="#26d5ee" />
          </linearGradient>
        </defs>
        <circle
          cx={tamanho / 2}
          cy={tamanho / 2}
          r={r}
          fill="none"
          strokeWidth={espessura}
          className="stroke-superficie-2"
        />
        <motion.circle
          cx={tamanho / 2}
          cy={tamanho / 2}
          r={r}
          fill="none"
          stroke="url(#anel-grad)"
          strokeWidth={espessura}
          strokeLinecap="round"
          strokeDasharray={circ}
          initial={{ strokeDashoffset: animar ? circ : alvo }}
          animate={{ strokeDashoffset: alvo }}
          transition={{ duration: animar ? 1.4 : 0, ease: [0.16, 1, 0.3, 1], delay: animar ? 0.25 : 0 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/**
 * Cartão de indicador. O glow no hover nasce de um pseudo-elemento em opacity 0
 * para que a transição seja de composição (barata) e não de box-shadow.
 */
export function CartaoKpi({
  Icone,
  rotulo,
  children,
  sub,
  destaque,
  indice = 0,
}: {
  Icone: React.ComponentType<{ className?: string }>;
  rotulo: string;
  children: React.ReactNode;
  sub?: React.ReactNode;
  destaque?: boolean;
  indice?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ delay: 0.06 * indice, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="group relative"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[17px] opacity-0 blur-[2px] transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'linear-gradient(135deg,rgba(139,92,255,.5),rgba(38,213,238,.35))' }}
      />
      <div
        className={cn(
          'relative h-full rounded-[16px] border border-linha bg-vidro p-5 backdrop-blur-xl',
          'transition-transform duration-300 group-hover:-translate-y-0.5',
          destaque && 'ring-1 ring-marca-azul/25',
        )}
      >
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border',
              destaque
                ? 'border-marca-ciano/30 bg-marca-ciano/10'
                : 'border-white/[0.07] bg-white/[0.04]',
            )}
          >
            <Icone className={cn('h-3.5 w-3.5', destaque ? 'text-marca-ciano' : 'text-muted')} />
          </span>
          <span className="rotulo">{rotulo}</span>
        </div>
        <div className="mt-4">{children}</div>
        {sub && <div className="mt-2.5 text-[11px] text-muted">{sub}</div>}
      </div>
    </motion.div>
  );
}

/** Esqueleto com a mesma altura do conteúdo real, para não haver salto de layout. */
export function Esqueleto({ className }: { className?: string }) {
  return <div className={cn('animate-pulsar rounded-sm bg-superficie', className)} />;
}
