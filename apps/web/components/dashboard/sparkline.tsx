'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

/**
 * Sparkline — a série de um KPI em miniatura.
 *
 * Só desenha com histórico DE VERDADE (≥ 2 pontos). Com menos, mostra
 * "coletando" em vez de inventar uma curva — o snapshot começou a ser gravado
 * agora, então a linha nasce vazia e enche a cada dia. É a mesma disciplina do
 * resto do dashboard: nada de dado ilustrativo.
 *
 * `preserveAspectRatio="none"` estica a curva para preencher a caixa larga e
 * baixa; `vectorEffect="non-scaling-stroke"` mantém o traço fino mesmo esticado.
 */
export function Sparkline({
  serie,
  cor = 'rgb(var(--marca-ciano))',
  className,
}: {
  serie: number[];
  cor?: string;
  className?: string;
}) {
  const id = useId();

  if (serie.length < 2) {
    return (
      <div className={cn('flex h-full items-center', className)}>
        <span className="inline-flex items-center gap-1.5 text-[10px] text-muted-2">
          <span className="h-px w-6 bg-linha-2" />
          coletando histórico
        </span>
      </div>
    );
  }

  const W = 100;
  const H = 32;
  const P = 3;
  const min = Math.min(...serie);
  const max = Math.max(...serie);
  const span = max - min || 1;

  const pts = serie.map((v, i) => {
    const x = P + (i / (serie.length - 1)) * (W - 2 * P);
    const y = H - P - ((v - min) / span) * (H - 2 * P);
    return [x, y] as const;
  });

  const linha = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${linha} L${pts[pts.length - 1][0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={cn('h-full w-full', className)}>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={cor} stopOpacity={0.3} />
          <stop offset="100%" stopColor={cor} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path
        d={linha}
        fill="none"
        stroke={cor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
