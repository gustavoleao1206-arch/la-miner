'use client';

import { motion } from 'framer-motion';
import { BadgeCheck, RefreshCw, ShieldCheck, Zap, ChevronRight } from 'lucide-react';
import { RedeNeural } from '@/components/rede-neural';

const surgir = {
  oculto: { opacity: 0, y: 22, filter: 'blur(6px)' },
  visivel: (i: number) => ({
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { delay: 0.12 + i * 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

const PILARES = [
  { Icone: BadgeCheck, titulo: 'Nascidos nos autos', sub: 'Direto do PJe', cor: 'text-aurora-2' },
  { Icone: RefreshCw, titulo: 'Atualização diária', sub: 'Base versionada', cor: 'text-aurora-4' },
  { Icone: ShieldCheck, titulo: 'Conformidade LGPD', sub: 'Registro auditável', cor: 'text-aurora-3' },
  { Icone: Zap, titulo: 'Busca instantânea', sub: 'Do CPF ao precatório', cor: 'text-aurora-1' },
];

/**
 * As seis regiões da Justiça Federal.
 *
 * Substitui a lista das 6 UFs do TRF5 que ficava aqui. O descritor de cada uma
 * é geográfico e curto de propósito: cabe no cartão e não exige do visitante
 * saber de cor qual estado pertence a qual região.
 */
const REGIOES = [
  { sigla: 'TRF1', onde: 'Norte, Centro-Oeste, BA/MA/PI' },
  { sigla: 'TRF2', onde: 'Rio de Janeiro e Espírito Santo' },
  { sigla: 'TRF3', onde: 'São Paulo e Mato Grosso do Sul' },
  { sigla: 'TRF4', onde: 'Região Sul' },
  { sigla: 'TRF5', onde: 'Nordeste oriental' },
  { sigla: 'TRF6', onde: 'Minas Gerais' },
];

/** Cartão de vidro flutuante, ancorado no mapa. */
function CartaoFlutuante({
  children, className, delay = 0, flutuar = 0,
}: {
  children: React.ReactNode; className?: string; delay?: number; flutuar?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.94, filter: 'blur(8px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      transition={{ delay, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      <motion.div
        animate={{ y: [0, -9, 0] }}
        transition={{ duration: 6 + flutuar, repeat: Infinity, ease: 'easeInOut', delay: flutuar }}
        className="rounded-[14px] border border-white/[0.09] bg-white/[0.045] px-4 py-3 shadow-vidro backdrop-blur-2xl"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

export function LoginHero() {
  return (
    <div className="relative">
      {/* ── Mapa como protagonista ── */}
      <div className="pointer-events-none absolute inset-x-0 -top-20 hidden h-[34rem] lg:block">
        <RedeNeural className="mx-auto h-full w-[29rem] -translate-x-6" />
        {/* brilho por trás do mapa, dá o "aceso" */}
        <div
          className="absolute left-1/2 top-1/2 -z-10 h-[30rem] w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-25 blur-[100px]"
          style={{ background: 'radial-gradient(circle,#3b82f6,transparent 65%)' }}
        />

        {/* Cards ancorados no mapa.
            Os números aqui descrevem a COBERTURA do produto, não a carteira de
            ninguém. Antes havia "R$ 1,19 Bi — Valor total", que é a carteira do
            próprio Leão Amorim chumbada na tela de entrada: num SaaS vendido a
            milhares de escritórios, isso é o número de um cliente exibido para
            todos os outros, e envelhece errado a cada importação. */}
        <CartaoFlutuante className="absolute right-[2%] top-[4%]" delay={0.9} flutuar={0.4}>
          <div className="num font-display text-lg font-semibold text-ink">6</div>
          <div className="text-[11px] text-muted">Tribunais federais</div>
        </CartaoFlutuante>

        <CartaoFlutuante className="absolute left-0 top-[38%]" delay={1.05} flutuar={1.2}>
          <div className="num font-display text-lg font-semibold text-ink">27</div>
          <div className="text-[11px] text-muted">Unidades da federação</div>
        </CartaoFlutuante>

        <CartaoFlutuante className="absolute -right-2 top-[58%] w-56" delay={1.2} flutuar={0.8}>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-display text-sm font-semibold text-ink">Cobertura nacional</span>
            <ChevronRight aria-hidden className="h-3.5 w-3.5 text-muted-2" />
          </div>
          <div className="mb-2.5 text-[10px] uppercase tracking-wider text-muted-2">
            Regiões atendidas
          </div>
          <ul className="space-y-1">
            {REGIOES.map((r) => (
              <li key={r.sigla} className="flex items-baseline gap-2 text-[11px]">
                <span className="h-1 w-1 shrink-0 translate-y-[-2px] rounded-full bg-marca-ciano" />
                <span className="num shrink-0 font-medium text-ink-2">{r.sigla}</span>
                <span className="truncate text-muted-2" title={r.onde}>
                  {r.onde}
                </span>
              </li>
            ))}
          </ul>
        </CartaoFlutuante>
      </div>

      {/* ── Texto do hero ── */}
      <div className="relative max-w-2xl lg:pt-[23rem]">
        <motion.h1
          custom={0}
          variants={surgir}
          initial="oculto"
          animate="visivel"
          className="font-display text-[clamp(2.5rem,5vw,4.25rem)] font-bold leading-[1.02] tracking-[-0.03em] text-ink"
        >
          Inteligência de
          <br />
          <span className="relative inline-block">
            <span className="bg-gradient-to-r from-aurora-2 via-aurora-4 to-aurora-3 bg-clip-text text-transparent">
              precatórios
            </span>
            <motion.span
              aria-hidden
              className="absolute -inset-x-5 -inset-y-2 -z-10 rounded-full opacity-40 blur-2xl"
              style={{ background: 'linear-gradient(90deg,#8b5cf6,#3b82f6,#22d3ee)' }}
              animate={{ opacity: [0.25, 0.5, 0.25] }}
              transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}
            />
          </span>
          <br />
          <span className="text-ink">em um só lugar.</span>
        </motion.h1>

        <motion.p
          custom={1}
          variants={surgir}
          initial="oculto"
          animate="visivel"
          lang="pt-BR"
          className="mt-6 max-w-xl text-justify text-sm leading-relaxed hyphens-auto"
        >
          {/* Contraste tipográfico: o problema recua, a resposta avança. Usa
              muted-2 (#7d88a6, 5,6:1) e não muted (#909bbb, 7,1:1) — este ficou
              perto demais de ink-2 e o parágrafo lia como bloco tonal único. */}
          <span className="text-muted-2">
            O mercado de precatórios ainda roda em planilhas soltas e conferência manual.
          </span>{' '}
          <span className="text-ink-2">
            A Leão Amorim consolidou tudo em uma base única: cada titular identificado na
            origem, cada valor rastreável até o processo e cada consulta registrada para
            auditoria.
          </span>
        </motion.p>

        {/* Pilares */}
        <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          {PILARES.map((p, i) => (
            <motion.div
              key={p.titulo}
              custom={2 + i}
              variants={surgir}
              initial="oculto"
              animate="visivel"
              className="flex items-start gap-2.5"
            >
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04]">
                <p.Icone className={`h-3.5 w-3.5 ${p.cor}`} />
              </span>
              <span>
                <span className="block text-[11px] font-medium text-ink">{p.titulo}</span>
                <span className="block text-[10px] text-muted">{p.sub}</span>
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
