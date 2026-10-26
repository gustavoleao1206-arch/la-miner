'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Cartão de indicador premium.
 *
 * Profundidade em camadas: um halo em gradiente da marca acende no hover (num
 * pseudo-elemento, para a transição ser de opacidade — composição barata, não
 * repaint de box-shadow), o cartão sobe 4px e troca a sombra por uma mais
 * elevada. Ícone num quadro tingido, número em `Contador`, e uma linha de apoio
 * que carrega o contexto (o "de quê" do número).
 *
 * A área de TENDÊNCIA (sparkline + variação) fica reservada mas só aparece com
 * dado real — o histórico começa a ser gravado agora, então até haver série a
 * carta se sustenta no número e no contexto, sem seta inventada. Ver Fase 4.
 *
 * `href` torna o cartão clicável inteiro: o dono do escritório clica no KPI e
 * cai na tela que o detalha, sem procurar o link.
 */
export function Kpi({
  Icone,
  rotulo,
  valor,
  sub,
  destaque,
  indice = 0,
  href,
  tendencia,
  sparkline,
}: {
  Icone: React.ComponentType<{ className?: string }>;
  rotulo: string;
  /** O número em si — normalmente um <Contador/> já formatado. */
  valor: React.ReactNode;
  sub?: React.ReactNode;
  destaque?: boolean;
  indice?: number;
  href?: string;
  /** Só renderiza com histórico real (Fase 4). */
  tendencia?: { texto: string; positiva: boolean };
  sparkline?: React.ReactNode;
}) {
  const conteudo = (
    <>
      <div className="flex items-start justify-between">
        <span
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-[11px] border transition-colors',
            destaque
              ? 'border-marca-ciano/30 bg-marca-ciano/10 text-marca-ciano'
              : 'border-linha bg-superficie text-muted group-hover:text-ink-2',
          )}
        >
          <Icone className="h-4 w-4" />
        </span>
        {tendencia ? (
          <span
            className={cn(
              'num flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
              tendencia.positiva ? 'bg-ok/12 text-ok' : 'bg-erro/12 text-erro',
            )}
          >
            <span aria-hidden>{tendencia.positiva ? '▲' : '▼'}</span>
            {tendencia.texto}
          </span>
        ) : (
          href && (
            <ArrowUpRight
              aria-hidden
              className="h-4 w-4 text-muted-2 opacity-0 transition-all duration-300 group-hover:translate-x-0.5 group-hover:opacity-100"
            />
          )
        )}
      </div>

      <p className="rotulo mt-4">{rotulo}</p>
      <div className="mt-1.5 leading-none">{valor}</div>

      {sub && <div className="mt-2 text-[11px] leading-relaxed text-muted">{sub}</div>}
      {sparkline && <div className="mt-3 h-9">{sparkline}</div>}
    </>
  );

  const classe = cn(
    'relative flex h-full flex-col rounded-[18px] border border-linha bg-vidro p-5 shadow-cartao backdrop-blur-xl',
    'transition-all duration-300 group-hover:-translate-y-1 group-hover:border-linha-2 group-hover:shadow-elevado',
    destaque && 'ring-1 ring-marca-azul/25',
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 16, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ delay: 0.05 * indice, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      className="group relative"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-[19px] opacity-0 blur-md transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'linear-gradient(135deg, rgb(var(--marca-violeta) / 0.45), rgb(var(--marca-ciano) / 0.3))',
        }}
      />
      {href ? (
        <Link href={href} className={cn(classe, 'cursor-pointer')}>
          {conteudo}
        </Link>
      ) : (
        <div className={classe}>{conteudo}</div>
      )}
    </motion.div>
  );
}
