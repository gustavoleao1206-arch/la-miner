'use client';

import { useEffect, useState } from 'react';

/**
 * O medidor de profundidade — o scroll convertido em metros.
 *
 * É o dispositivo que faz a página SER uma descida em vez de apenas dizê-lo:
 * um instrumento de mono no canto, de 0 m a −1.000 m, marcando onde o
 * visitante está no poço. Desaparece no mobile (a tela é estreita demais para
 * instrumento de canto) e para quem pediu menos movimento (um contador que
 * acompanha o scroll É movimento).
 *
 * `aria-hidden` porque é decoração de navegação, não conteúdo: leitor de tela
 * atravessa a página pelas seções, não pelos metros.
 */
export function MedidorProfundidade() {
  const [metros, setMetros] = useState(0);
  const [visivel, setVisivel] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let agendado = 0;
    const medir = () => {
      agendado = 0;
      const total = document.documentElement.scrollHeight - window.innerHeight;
      const fracao = total > 0 ? window.scrollY / total : 0;
      setMetros(Math.round(fracao * 1000));
      setVisivel(window.scrollY > 80);
    };
    const aoRolar = () => {
      /* rAF-throttle: o scroll dispara mais rápido que a tela pinta. */
      if (!agendado) agendado = requestAnimationFrame(medir);
    };
    window.addEventListener('scroll', aoRolar, { passive: true });
    medir();
    return () => {
      window.removeEventListener('scroll', aoRolar);
      cancelAnimationFrame(agendado);
    };
  }, []);

  return (
    <div
      aria-hidden
      className={`fixed right-6 top-1/2 z-40 hidden -translate-y-1/2 select-none flex-col items-end gap-1 font-mono text-[11px] tracking-[0.18em] transition-opacity duration-500 lg:flex ${
        visivel ? 'opacity-100' : 'opacity-0'
      }`}
      style={{ color: 'var(--bruma-2)' }}
    >
      <span>PROFUNDIDADE</span>
      <span className="text-[15px] tabular-nums" style={{ color: 'var(--sonda)' }}>
        −{metros} m
      </span>
      {/* A régua: 1px de poço com o marcador na fração descida. */}
      <span
        className="mt-2 block h-24 w-px"
        style={{ background: 'var(--linha-j)', position: 'relative' }}
      >
        <span
          className="absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full"
          style={{ top: `${metros / 10}%`, background: 'var(--veio)' }}
        />
      </span>
    </div>
  );
}
