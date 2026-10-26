'use client';

import { motion } from 'framer-motion';

/**
 * Camada de iluminação cinematográfica.
 *
 * Três efeitos que a referência usa e que fazem a diferença entre
 * "fundo escuro" e "cena iluminada":
 *   1. Feixes diagonais (god rays) atravessando o quadro
 *   2. Arcos finos e elegantes na borda direita
 *   3. Varredura lenta de luz, que dá vida sem chamar atenção
 */
export function LuzCinematica() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* ── Feixes diagonais ── */}
      <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id="feixe" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6ea8ff" stopOpacity="0" />
            <stop offset="45%" stopColor="#8ec5ff" stopOpacity="0.055" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="feixe2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0" />
            <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>

        {[
          { d: 'M -200 900 L 500 -150 L 640 -150 L -60 900 Z', g: 'feixe', dur: 14 },
          { d: 'M 100 950 L 760 -120 L 830 -120 L 170 950 Z', g: 'feixe2', dur: 18 },
          { d: 'M 420 980 L 1020 -140 L 1075 -140 L 475 980 Z', g: 'feixe', dur: 16 },
        ].map((f, i) => (
          <motion.path
            key={i}
            d={f.d}
            fill={`url(#${f.g})`}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.28, 0.55, 0.28] }}
            transition={{ duration: f.dur, repeat: Infinity, ease: 'easeInOut', delay: i * 2.5 }}
          />
        ))}
      </svg>

      {/* ── Arcos finos na borda direita ── */}
      <svg
        className="absolute -right-24 top-0 h-full w-[36rem] opacity-[0.38]"
        viewBox="0 0 600 900"
        fill="none"
        preserveAspectRatio="xMaxYMid slice"
      >
        <defs>
          <linearGradient id="arco" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity="0" />
            <stop offset="40%" stopColor="#60a5fa" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: 9 }).map((_, i) => {
          const off = i * 34;
          return (
            <motion.path
              key={i}
              d={`M ${120 + off} -60 C ${300 + off} 220, ${330 + off} 520, ${140 + off} 960`}
              stroke="url(#arco)"
              strokeWidth={0.9}
              fill="none"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{
                pathLength: { duration: 2.4, delay: 0.5 + i * 0.11, ease: [0.16, 1, 0.3, 1] },
                opacity: { duration: 1, delay: 0.5 + i * 0.11 },
              }}
            />
          );
        })}
      </svg>

      {/* ── Varredura lenta ── */}
      <motion.div
        className="absolute inset-y-0 w-[38rem] opacity-[0.05]"
        style={{
          background: 'linear-gradient(90deg,transparent,#9ec5ff 45%,transparent)',
          filter: 'blur(46px)',
        }}
        animate={{ x: ['-40rem', '110rem'] }}
        transition={{ duration: 20, repeat: Infinity, ease: 'linear', repeatDelay: 6 }}
      />
    </div>
  );
}
