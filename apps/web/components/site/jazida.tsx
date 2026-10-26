'use client';

import { useEffect, useRef } from 'react';

/**
 * A JAZIDA — a arte-assinatura do Miner.
 *
 * Uma coluna de pontos apagados em rotação lenta (a massa de dados), um feixe
 * ciano que desce varrendo (a tecnologia), e ~1,5% dos pontos que acendem no
 * azul da marca quando o feixe os encontra — e PERMANECEM acesos, esmaecendo devagar
 * (o achado). É a promessa do produto executada como física.
 *
 * ── POR QUE CANVAS 2D COM PROJEÇÃO PRÓPRIA, E NÃO THREE.JS ──
 *
 * O efeito precisa de pontos, profundidade e um feixe — nada de malha, luz ou
 * material. three.js custaria ~130 KB gzip para isso; a projeção perspectiva
 * cabe em uma linha (esc = f / (f + z)). Decisão aprovada com registro na
 * direção de arte: performance é prioridade declarada da página.
 *
 * ── ORÇAMENTO ──
 *
 * Um requestAnimationFrame, pausado fora da viewport (IntersectionObserver) e
 * DPR limitado a 2. `prefers-reduced-motion` congela num único quadro com os
 * veios já acesos — a cena inteira, sem o movimento. No mobile o chamador
 * reduz os pontos e o tilt desliga (não há mouse).
 */
export function Jazida({
  pontos = 900,
  centroX = 0.5,
  className,
}: {
  pontos?: number;
  /** Posição horizontal da coluna (0–1) — o herói a desloca para a direita. */
  centroX?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduz = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const movel = window.innerWidth < 760;
    const N = movel ? Math.round(pontos * 0.45) : pontos;
    const PROF = 900;

    type Ponto = { a: number; r: number; y: number; veio: boolean; brilho: number };
    const pts: Ponto[] = [];
    for (let i = 0; i < N; i++) {
      pts.push({
        a: Math.random() * Math.PI * 2,
        r: 90 + Math.random() * 140 * (0.6 + 0.4 * Math.sin(i * 0.7)),
        y: (Math.random() - 0.5) * PROF,
        veio: false,
        brilho: 0,
      });
    }
    /* Os achados: ~1,5% — a proporção É a mensagem (quase tudo não é veio). */
    const veios: Ponto[] = [];
    for (let v = 0; v < Math.max(8, N * 0.015); v++) {
      const p = pts[(Math.random() * N) | 0];
      p.veio = true;
      veios.push(p);
    }

    let rot = 0;
    let feixeY = -PROF / 2;
    let mouseX = 0;
    let vivo = false;
    let quadroAgendado = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const aoMover = (e: PointerEvent) => {
      mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    };
    if (!movel && !reduz) window.addEventListener('pointermove', aoMover, { passive: true });

    const medir = () => {
      const b = canvas.getBoundingClientRect();
      canvas.width = Math.round(b.width * dpr);
      canvas.height = Math.round(b.height * dpr);
    };
    medir();
    window.addEventListener('resize', medir);

    function quadro() {
      if (!ctx) return;
      const W = canvas!.width;
      const H = canvas!.height;
      ctx.clearRect(0, 0, W, H);
      const cx = W * (movel ? 0.5 : centroX);
      const cy = H * 0.5;
      const f = H * 0.9;
      const tilt = reduz || movel ? 0 : mouseX * 0.18;

      rot += reduz ? 0 : 0.0016;
      feixeY += reduz ? 0 : 1.1;
      if (feixeY > PROF / 2 + 60) feixeY = -PROF / 2 - 60;

      for (const p of pts) {
        const x3 = Math.cos(p.a + rot) * p.r;
        const z3 = Math.sin(p.a + rot) * p.r + 320;
        const y3 = p.y + x3 * tilt;
        const esc = f / (f + z3);
        const x2 = cx + x3 * esc * dpr;
        const y2 = cy + y3 * esc * dpr * 0.9;

        const noFeixe = Math.abs(p.y - feixeY) < 26;
        if (noFeixe && p.veio) p.brilho = 1;
        if (p.brilho > 0.18) p.brilho *= 0.9992;

        let tam: number, cor: string, alfa: number;
        if (p.veio && p.brilho > 0.2) {
          tam = (2.4 + p.brilho * 2.2) * esc * dpr;
          cor = '79,124,255';
          alfa = 0.35 + 0.6 * p.brilho;
          ctx.shadowColor = `rgba(79,124,255,${0.55 * p.brilho})`;
          ctx.shadowBlur = 14 * p.brilho * dpr;
        } else if (noFeixe) {
          tam = 1.7 * esc * dpr;
          cor = '42,212,232';
          alfa = 0.85;
          ctx.shadowBlur = 0;
        } else {
          tam = 1.25 * esc * dpr;
          cor = '110,130,175';
          alfa = 0.1 + 0.25 * esc;
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.arc(x2, y2, Math.max(tam, 0.6), 0, 6.2832);
        ctx.fillStyle = `rgba(${cor},${alfa})`;
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (!reduz) {
        const yF = cy + feixeY * (f / (f + 320)) * dpr * 0.9;
        const g = ctx.createLinearGradient(0, yF - 14 * dpr, 0, yF + 14 * dpr);
        g.addColorStop(0, 'rgba(42,212,232,0)');
        g.addColorStop(0.5, 'rgba(42,212,232,0.10)');
        g.addColorStop(1, 'rgba(42,212,232,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, yF - 14 * dpr, W, 28 * dpr);
      }
    }

    function laco() {
      if (!vivo) return;
      quadro();
      if (!reduz) quadroAgendado = requestAnimationFrame(laco);
    }

    const observador = new IntersectionObserver(
      (entradas) => {
        const dentro = entradas[0]?.isIntersecting ?? false;
        if (dentro && !vivo) {
          vivo = true;
          laco();
        } else if (!dentro) {
          vivo = false;
          cancelAnimationFrame(quadroAgendado);
        }
      },
      { threshold: 0.05 },
    );
    observador.observe(canvas);

    if (reduz) {
      for (const p of veios) p.brilho = 0.9;
      quadro();
    }

    return () => {
      vivo = false;
      cancelAnimationFrame(quadroAgendado);
      observador.disconnect();
      window.removeEventListener('resize', medir);
      window.removeEventListener('pointermove', aoMover);
    };
  }, [pontos, centroX]);

  /* Decorativa por definição: a informação dela está no texto ao lado. */
  return <canvas ref={ref} aria-hidden className={className} />;
}
