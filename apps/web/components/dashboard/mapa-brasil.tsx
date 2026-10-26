'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin } from 'lucide-react';
import { BRASIL_CONTORNO, CAPITAIS, LIMITES } from '@/lib/brasil-geo';
import { Esqueleto } from '@/components/metricas';

/**
 * Mapa de requerentes por estado.
 *
 * Silhueta REAL do Brasil (BRASIL_CONTORNO, o mesmo contorno do login) com um
 * símbolo proporcional aceso em cada capital: tamanho e brilho crescem com o
 * número de requerentes daquele estado. É um mapa de símbolo proporcional, não
 * um cloroplético — o projeto tem o contorno do país, não o polígono de cada
 * UF —, e isso é honesto: o dado é "onde moram os titulares", plotado no ponto,
 * não pintado por área que não temos.
 *
 * O dado vem de /carteira/mapa: requerentes DO LOTE com endereço ativo, por UF.
 */

const W = 400;
const H = 404;
const PAD = 14;

function projetar(lon: number, lat: number): [number, number] {
  const { lonMin, lonMax, latMin, latMax } = LIMITES;
  const x = PAD + ((lon - lonMin) / (lonMax - lonMin)) * (W - 2 * PAD);
  const y = PAD + ((latMax - lat) / (latMax - latMin)) * (H - 2 * PAD);
  return [x, y];
}

/** Interpola azul (pouco) → ciano (muito): a "temperatura" dentro da marca. */
function corPorIntensidade(t: number): string {
  const de = [79, 124, 255]; // #4F7CFF
  const para = [38, 213, 238]; // #26D5EE
  const c = de.map((d, i) => Math.round(d + (para[i] - d) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const CAMINHO_BRASIL =
  BRASIL_CONTORNO.map(([lon, lat], i) => {
    const [x, y] = projetar(lon, lat);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ') + ' Z';

type Ponto = {
  uf: string;
  nome: string;
  trf: string;
  x: number;
  y: number;
  requerentes: number;
  t: number;
  r: number;
};

export function MapaBrasil({
  dados,
  carregando,
}: {
  dados: { uf: string; requerentes: number }[] | null;
  carregando?: boolean;
}) {
  const [ativo, setAtivo] = useState<string | null>(null);

  const { pontos, total, lider } = useMemo(() => {
    const porUf = new Map((dados ?? []).map((d) => [d.uf.toUpperCase(), d.requerentes]));
    const max = Math.max(1, ...(dados ?? []).map((d) => d.requerentes));
    const total = (dados ?? []).reduce((s, d) => s + d.requerentes, 0);
    const pontos: Ponto[] = CAPITAIS.map((c) => {
      const requerentes = porUf.get(c.uf) ?? 0;
      const t = requerentes / max;
      const [x, y] = projetar(c.lon, c.lat);
      return {
        uf: c.uf,
        nome: c.nome.replace(/^(Rio Branco|Porto Velho|Boa Vista)$/, c.nome), // nome da capital
        trf: c.trf,
        x,
        y,
        requerentes,
        t,
        r: 2.4 + Math.sqrt(t) * 13,
      };
    })
      /* Maiores por baixo: o dot pequeno nunca some atrás do grande, e o hover
         do menor continua alcançável. */
      .sort((a, b) => b.requerentes - a.requerentes);
    const lider = [...pontos].sort((a, b) => b.requerentes - a.requerentes)[0];
    return { pontos, total, lider };
  }, [dados]);

  const pontoAtivo = pontos.find((p) => p.uf === ativo) ?? null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-mapa"
      className="cartao flex flex-col p-6"
    >
      <div className="mb-1 flex items-center gap-2.5">
        <MapPin aria-hidden className="h-4 w-4 text-marca-ciano" />
        <h2 id="titulo-mapa" className="font-display text-sm font-semibold text-ink">
          Distribuição geográfica
        </h2>
        {!carregando && total > 0 && (
          <span className="ml-auto text-[11px] text-muted-2">
            {total.toLocaleString('pt-BR')} localizados
          </span>
        )}
      </div>
      <p className="mb-2 text-[12px] text-muted">Requerentes por estado, pelo endereço ativo.</p>

      {carregando ? (
        <Esqueleto className="mx-auto aspect-square w-full max-w-[380px]" />
      ) : (
        <div className="relative mx-auto w-full max-w-[380px]" style={{ aspectRatio: `${W} / ${H}` }}>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full overflow-visible">
            <path
              d={CAMINHO_BRASIL}
              className="fill-superficie stroke-linha-2"
              strokeWidth={1}
              strokeLinejoin="round"
            />
            {pontos.map((p) => {
              const cor = corPorIntensidade(p.t);
              const destacado = ativo === p.uf;
              if (p.requerentes === 0) return null;
              return (
                <g
                  key={p.uf}
                  className="cursor-pointer"
                  onMouseEnter={() => setAtivo(p.uf)}
                  onMouseLeave={() => setAtivo((u) => (u === p.uf ? null : u))}
                >
                  {/* halo */}
                  <circle cx={p.x} cy={p.y} r={p.r * 2.2} fill={cor} opacity={0.1 + 0.2 * p.t} />
                  {/* núcleo */}
                  <motion.circle
                    cx={p.x}
                    cy={p.y}
                    fill={cor}
                    initial={{ r: 0, opacity: 0 }}
                    animate={{ r: p.r, opacity: 0.55 + 0.4 * p.t }}
                    transition={{ delay: 0.3 + p.t * 0.2, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    stroke="#eaf0fb"
                    strokeOpacity={destacado ? 0.9 : 0.25}
                    strokeWidth={destacado ? 1.5 : 0.75}
                  />
                </g>
              );
            })}
          </svg>

          {/* Tooltip premium */}
          {pontoAtivo && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+10px)] whitespace-nowrap rounded-[12px] border border-linha bg-bg-2/95 px-3 py-2 shadow-elevado backdrop-blur-xl"
              style={{ left: `${(pontoAtivo.x / W) * 100}%`, top: `${(pontoAtivo.y / H) * 100}%` }}
            >
              <p className="text-[12px] font-medium text-ink">
                {pontoAtivo.nome} <span className="text-muted">· {pontoAtivo.uf}</span>
              </p>
              <p className="num mt-0.5 text-[13px] font-semibold text-marca-ciano">
                {pontoAtivo.requerentes.toLocaleString('pt-BR')} requerentes
              </p>
              <p className="num text-[10px] text-muted">
                {total > 0 ? ((pontoAtivo.requerentes / total) * 100).toFixed(1).replace('.', ',') : '0'}% do
                mapeado · {pontoAtivo.trf}
              </p>
            </div>
          )}
        </div>
      )}

      {!carregando && lider && lider.requerentes > 0 && (
        <div className="mt-3 flex items-center justify-between border-t border-linha pt-3 text-[11px] text-muted">
          <span>
            Maior concentração:{' '}
            <span className="font-medium text-ink-2">
              {lider.nome} ({lider.uf})
            </span>
          </span>
          <span className="num">{lider.requerentes.toLocaleString('pt-BR')}</span>
        </div>
      )}
    </motion.section>
  );
}
