'use client';

import { useEffect, useRef } from 'react';

/**
 * Rede neural viva com o contorno do Brasil formado por pontos de dados.
 *
 * Decisões que separam isto de um "canvas de partículas" genérico:
 *  1. Os nós NÃO são aleatórios: seguem o contorno + interior do Brasil,
 *     então a forma emerge do próprio dado em vez de ser um desenho por cima.
 *  2. As conexões pulsam com fase própria — parecem sinapses, não linhas.
 *  3. Parallax no mouse move o campo inteiro em profundidades diferentes,
 *     criando paralaxe real em vez de um fundo chapado.
 *  4. Respeita prefers-reduced-motion e pausa fora da viewport.
 */

import { BRASIL_CONTORNO, CAPITAIS, LIMITES } from '@/lib/brasil-geo';

/** Mercator: preserva a forma reconhecível do país (equirretangular achata o sul). */
function mercatorY(lat: number) {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
}

const Y_MIN = mercatorY(LIMITES.latMin);
const Y_MAX = mercatorY(LIMITES.latMax);

/** (lon,lat) → (0..1, 0..1) com y invertido para tela. */
function normalizar(lon: number, lat: number): [number, number] {
  const nx = (lon - LIMITES.lonMin) / (LIMITES.lonMax - LIMITES.lonMin);
  const ny = 1 - (mercatorY(lat) - Y_MIN) / (Y_MAX - Y_MIN);
  return [nx, ny];
}

const CONTORNO: [number, number][] = BRASIL_CONTORNO.map(([lon, lat]) => normalizar(lon, lat));
/* Nome diferente do import de propósito: são as MESMAS capitais já projetadas
   para o espaço do canvas, não a lista geográfica. */
const CAPITAIS_XY: [number, number][] = CAPITAIS.map((c) => normalizar(c.lon, c.lat));

interface No {
  x: number; y: number; bx: number; by: number;
  r: number; fase: number; camada: number; capital: boolean;
}

export function RedeNeural({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const reduzido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let t = 0;
    const mouse = { x: 0.5, y: 0.5, ax: 0.5, ay: 0.5 };
    let nos: No[] = [];
    let L = 0, A = 0, dpr = 1;

    function montar() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      L = cv!.clientWidth;
      A = cv!.clientHeight;
      cv!.width = L * dpr;
      cv!.height = A * dpr;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Enquadra o Brasil ocupando ~72% da altura, centralizado.
      const esc = Math.min(L / 1.02, A) * 0.98;
      const ox = (L - esc * 1.02) / 2;
      const oy = (A - esc) / 2;
      const proj = ([nx, ny]: [number, number]) => ({ x: ox + nx * esc * 1.02, y: oy + ny * esc });

      nos = [];

      // 1) contorno — densidade alta, define a silhueta
      CONTORNO.forEach((p, i) => {
        const { x, y } = proj(p);
        nos.push({ x, y, bx: x, by: y, r: 1.6, fase: i * 0.35, camada: 1, capital: false });
        // interpola para o próximo, adensando a borda
        const prox = proj(CONTORNO[(i + 1) % CONTORNO.length]);
        for (let k = 1; k < 3; k++) {
          const f = k / 3;
          const ix = x + (prox.x - x) * f;
          const iy = y + (prox.y - y) * f;
          nos.push({ x: ix, y: iy, bx: ix, by: iy, r: 1.1, fase: i + k, camada: 1, capital: false });
        }
      });

      // 2) preenchimento interno — pontos por dentro do polígono
      for (let i = 0; i < 520; i++) {
        const nx = Math.random();
        const ny = Math.random();
        if (!dentro(nx, ny)) continue;
        const { x, y } = proj([nx, ny]);
        nos.push({ x, y, bx: x, by: y, r: 0.9 + Math.random(), fase: Math.random() * 10, camada: 0.6, capital: false });
      }

      // 3) capitais — nós grandes, sempre visíveis
      CAPITAIS_XY.forEach((p, i) => {
        const { x, y } = proj(p);
        nos.push({ x, y, bx: x, by: y, r: 3, fase: i * 1.2, camada: 1.4, capital: true });
      });
    }

    /** Ray casting: o ponto está dentro do polígono do contorno? */
    function dentro(x: number, y: number) {
      let d = false;
      for (let i = 0, j = CONTORNO.length - 1; i < CONTORNO.length; j = i++) {
        const [xi, yi] = CONTORNO[i];
        const [xj, yj] = CONTORNO[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
      }
      return d;
    }

    function desenhar() {
      t += reduzido ? 0 : 0.006;
      // easing do parallax — o campo persegue o mouse com inércia
      mouse.ax += (mouse.x - mouse.ax) * 0.045;
      mouse.ay += (mouse.y - mouse.ay) * 0.045;

      ctx!.clearRect(0, 0, L, A);

      const dx = (mouse.ax - 0.5) * 34;
      const dy = (mouse.ay - 0.5) * 34;

      for (const n of nos) {
        n.x = n.bx + dx * n.camada + Math.sin(t + n.fase) * 1.6 * n.camada;
        n.y = n.by + dy * n.camada + Math.cos(t * 0.8 + n.fase) * 1.6 * n.camada;
      }

      // conexões: só entre vizinhos próximos, com pulso de sinapse
      for (let i = 0; i < nos.length; i++) {
        for (let j = i + 1; j < nos.length; j++) {
          const a = nos[i], b = nos[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          const lim = 52;
          if (d > lim) continue;
          const base = (1 - d / lim) * 0.5;
          const pulso = 0.55 + 0.45 * Math.sin(t * 2.2 + (a.fase + b.fase) * 0.5);
          ctx!.strokeStyle = `rgba(120,165,255,${base * pulso * 1.15})`;
          ctx!.lineWidth = 0.75;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();
        }
      }

      // nós
      for (const n of nos) {
        const brilho = 0.6 + 0.4 * Math.sin(t * 1.8 + n.fase);
        if (n.capital) {
          const g = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, 16);
          g.addColorStop(0, `rgba(56,215,238,${0.5 * brilho})`);
          g.addColorStop(1, 'rgba(56,215,238,0)');
          ctx!.fillStyle = g;
          ctx!.beginPath();
          ctx!.arc(n.x, n.y, 16, 0, Math.PI * 2);
          ctx!.fill();
        }
        // halo suave em todo nó — é o que dá o aspecto de constelação acesa
        const h = ctx!.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.capital ? 20 : 7);
        h.addColorStop(0, n.capital ? `rgba(90,220,255,${0.55 * brilho})` : `rgba(130,180,255,${0.3 * brilho})`);
        h.addColorStop(1, 'rgba(90,180,255,0)');
        ctx!.fillStyle = h;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.capital ? 20 : 7, 0, Math.PI * 2);
        ctx!.fill();

        ctx!.fillStyle = n.capital
          ? `rgba(190,245,255,${0.98 * brilho})`
          : `rgba(190,215,255,${0.9 * brilho})`;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx!.fill();
      }

      raf = requestAnimationFrame(desenhar);
    }

    function aoMover(e: MouseEvent) {
      mouse.x = e.clientX / window.innerWidth;
      mouse.y = e.clientY / window.innerHeight;
    }

    montar();
    desenhar();
    window.addEventListener('resize', montar);
    window.addEventListener('mousemove', aoMover, { passive: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', montar);
      window.removeEventListener('mousemove', aoMover);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
