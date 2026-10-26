'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { ListChecks } from 'lucide-react';
import type { Prioridade } from '@/lib/api';
import { Esqueleto, useAnimavel } from '@/components/metricas';

/**
 * Processos por prioridade — donut.
 *
 * As cores saem de tokens do tema (`rgb(var(--erro))`, …): o SVG resolve a
 * variável, então o gráfico troca de tema junto com o resto, sem hex solto.
 */
const COR: Record<Prioridade, string> = {
  URGENTE: 'rgb(var(--erro))',
  ALTA: 'rgb(var(--alerta))',
  NORMAL: 'rgb(var(--marca-azul))',
  BAIXA: 'rgb(var(--muted))',
};
const ROTULO: Record<Prioridade, string> = {
  URGENTE: 'Urgente',
  ALTA: 'Alta',
  NORMAL: 'Normal',
  BAIXA: 'Baixa',
};

export function DonutPrioridade({
  dados,
  carregando,
}: {
  dados: { prioridade: Prioridade; quantidade: number; valor: string }[] | null;
  carregando?: boolean;
}) {
  const animar = useAnimavel();
  const { fatias, total } = useMemo(() => {
    const fatias = (dados ?? []).filter((d) => d.quantidade > 0);
    const total = (dados ?? []).reduce((s, d) => s + d.quantidade, 0);
    return { fatias, total };
  }, [dados]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.06, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-prioridade"
      className="cartao flex flex-col p-6"
    >
      <div className="mb-5 flex items-center gap-2.5">
        <ListChecks aria-hidden className="h-4 w-4 text-marca-ciano" />
        <h2 id="titulo-prioridade" className="font-display text-sm font-semibold text-ink">
          Processos por prioridade
        </h2>
      </div>

      {carregando ? (
        <div className="flex items-center gap-6">
          <Esqueleto className="h-40 w-40 rounded-full" />
          <div className="flex-1 space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Esqueleto key={i} className="h-6" />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-6 sm:flex-row">
          <div className="relative h-44 w-44 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={fatias.length ? fatias : [{ prioridade: 'BAIXA', quantidade: 1, valor: '0' }]}
                  dataKey="quantidade"
                  nameKey="prioridade"
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={84}
                  paddingAngle={fatias.length > 1 ? 2 : 0}
                  startAngle={90}
                  endAngle={-270}
                  isAnimationActive={animar}
                  animationDuration={900}
                  stroke="none"
                >
                  {(fatias.length ? fatias : [{ prioridade: 'BAIXA' as Prioridade }]).map((d, i) => (
                    <Cell key={i} fill={fatias.length ? COR[d.prioridade] : 'rgb(var(--superficie-2))'} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="num font-display text-[26px] font-semibold leading-none text-ink">
                {total.toLocaleString('pt-BR')}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-[0.14em] text-muted">processos</span>
            </div>
          </div>

          {/* Legenda */}
          <ul className="w-full flex-1 space-y-2.5">
            {(dados ?? []).map((d) => {
              const pct = total > 0 ? (d.quantidade / total) * 100 : 0;
              return (
                <li key={d.prioridade} className="flex items-center gap-3">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: COR[d.prioridade] }}
                  />
                  <span className="text-[13px] text-ink-2">{ROTULO[d.prioridade]}</span>
                  <span className="num ml-auto text-[13px] font-medium text-ink">
                    {d.quantidade.toLocaleString('pt-BR')}
                  </span>
                  <span className="num w-12 text-right text-[11px] text-muted">
                    {pct.toFixed(1).replace('.', ',')}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </motion.section>
  );
}
