'use client';

import { motion } from 'framer-motion';
import { Mail, MapPin, Phone, Sparkles } from 'lucide-react';
import type { EstadoFila, PainelCarteira, ResumoCarteira } from '@/lib/api';
import { brl } from '@/lib/utils';
import { AnelProgresso, Contador, Esqueleto } from '@/components/metricas';

/**
 * Herói da carteira — o resumo executivo que abre o dashboard.
 *
 * Lidera com a ALCANÇABILIDADE porque é a resposta à pergunta que o dono da
 * carteira faz primeiro: quanto disto dá para acionar hoje. O número saltou de
 * 2,6% para ~98% quando o enriquecimento rodou; a tela existe para deixar esse
 * salto óbvio nos primeiros segundos, não enterrado num card lá embaixo.
 *
 * O recorte (valor alcançável / valor total) é o MESMO da carteira: dinheiro,
 * não contagem de gente. A contagem de canais vem ao lado, como o "como".
 */

const compactoBRL = (n: number) => {
  if (n >= 1e9) return `R$ ${(n / 1e9).toFixed(2).replace('.', ',')} Bi`;
  if (n >= 1e6) return `R$ ${(n / 1e6).toFixed(1).replace('.', ',')} Mi`;
  if (n >= 1e3) return `R$ ${(n / 1e3).toFixed(0)} mil`;
  return brl(n);
};

const pctTexto = (n: number) =>
  `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

const CANAIS = [
  { chave: 'comTelefone', rotulo: 'Telefone', Icone: Phone },
  { chave: 'comEmail', rotulo: 'E-mail', Icone: Mail },
  { chave: 'comEndereco', rotulo: 'Endereço', Icone: MapPin },
] as const;

export function HeroCarteira({
  resumo,
  cobertura,
  fila,
  atualizando,
}: {
  resumo: ResumoCarteira | null;
  cobertura: PainelCarteira['cobertura'] | null;
  fila: EstadoFila | null;
  /** true durante um refetch do React Query — acende o "ao vivo". */
  atualizando?: boolean;
}) {
  const valorTotal = cobertura ? Number(cobertura.valorTotal) : resumo ? Number(resumo.valorTotal) : 0;
  const valorAlcancavel = cobertura ? Number(cobertura.valorAlcancavel) : 0;
  const pctValor = valorTotal > 0 ? (valorAlcancavel / valorTotal) * 100 : 0;
  const pronto = Boolean(cobertura);

  return (
    <motion.section
      initial={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="hero-titulo"
      className="relative overflow-hidden rounded-[24px] border border-linha bg-vidro p-6 shadow-elevado backdrop-blur-xl lg:p-8"
    >
      {/* Brilho interno diagonal — dá o "vidro" sem pesar; discreto nos dois modos. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-32 h-96 w-96 rounded-full opacity-60 blur-[100px]"
        style={{ background: 'radial-gradient(circle, rgb(var(--marca-violeta) / 0.16), transparent 70%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 left-1/3 h-80 w-80 rounded-full opacity-50 blur-[100px]"
        style={{ background: 'radial-gradient(circle, rgb(var(--marca-ciano) / 0.12), transparent 70%)' }}
      />

      <div className="relative grid items-center gap-8 lg:grid-cols-[1.5fr_auto]">
        {/* ── Coluna do texto ── */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-marca-ciano/25 bg-marca-ciano/10 px-2.5 py-1 text-[11px] font-medium text-marca-ciano">
              <Sparkles className="h-3 w-3" />
              Carteira consolidada
            </span>
            {/* Sem lote, a carteira não tem recorte — é tudo que foi liberado,
                de qualquer tribunal. Dizer isso vale mais do que esconder o
                chip: o rótulo "TRF5 · 2027" chegou a aparecer para um cliente
                cuja carteira era nacional, e ele mostrava dois terços a menos
                do que a pessoa tinha comprado. */}
            <span className="num rounded-full border border-linha bg-superficie px-2.5 py-1 text-[11px] text-ink-2">
              {resumo?.lote ? `${resumo.lote.tribunal} · ${resumo.lote.exercicio}` : 'todos os tribunais'}
            </span>
            {/* Ao vivo — o dashboard se atualiza sozinho; o ponto pulsa no refetch. */}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-linha bg-superficie px-2.5 py-1 text-[11px] text-muted">
              <span className="relative flex h-1.5 w-1.5">
                {atualizando && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-70" />
                )}
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
              </span>
              {atualizando ? 'atualizando' : 'ao vivo'}
            </span>
          </div>

          <h1
            id="hero-titulo"
            className="mt-4 font-display text-[26px] font-semibold leading-tight tracking-tight text-ink lg:text-[32px]"
          >
            {pronto ? (
              <>
                <span className="texto-marca">{pctTexto(pctValor)}</span> da carteira é acionável
              </>
            ) : (
              'Visão geral da carteira'
            )}
          </h1>

          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-ink-2 lg:text-sm">
            {pronto ? (
              <>
                <span className="num font-medium text-ink">{compactoBRL(valorAlcancavel)}</span> dos{' '}
                <span className="num text-ink-2">{compactoBRL(valorTotal)}</span> estão com titulares que
                têm ao menos um canal de contato ativo. O restante existe no papel e ainda não dá para
                acionar.
              </>
            ) : (
              'Consolidando os indicadores da carteira…'
            )}
          </p>

          {/* Barra de alcançabilidade */}
          <div className="mt-6 max-w-xl">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-superficie-2">
              <motion.div
                className="h-full rounded-full bg-marca-3"
                initial={{ width: 0 }}
                animate={{ width: `${Math.max(pctValor, pronto ? 1.5 : 0)}%` }}
                transition={{ duration: 1.3, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
              />
            </div>

            {/* Canais — o "como" da alcançabilidade */}
            <div className="mt-4 flex flex-wrap gap-2">
              {CANAIS.map(({ chave, rotulo, Icone }) => (
                <span
                  key={chave}
                  className="inline-flex items-center gap-1.5 rounded-full border border-linha bg-superficie px-3 py-1.5 text-[12px] text-ink-2"
                >
                  <Icone className="h-3.5 w-3.5 text-muted" />
                  {rotulo}
                  <span className="num font-semibold text-ink">
                    {cobertura ? cobertura[chave].toLocaleString('pt-BR') : '—'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ── Anel de alcançabilidade + estado da fila ── */}
        <div className="flex flex-col items-center gap-4 lg:items-end">
          {fila && (
            <div className="flex items-center gap-2.5 rounded-full border border-linha bg-superficie px-3.5 py-1.5">
              <span className="relative flex h-2 w-2">
                {fila.ativos > 0 && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-marca-ciano opacity-60" />
                )}
                <span
                  className={`relative inline-flex h-2 w-2 rounded-full ${fila.ativos > 0 ? 'bg-marca-ciano' : 'bg-muted'}`}
                />
              </span>
              <span className="text-[12px] text-ink-2">
                {fila.ativos > 0 ? `${fila.ativos} em processamento` : 'Fila ociosa'}
              </span>
            </div>
          )}

          {pronto ? (
            <AnelProgresso percentual={pctValor} tamanho={172} espessura={12}>
              <span className="num font-display text-[30px] font-semibold leading-none text-ink">
                {pctTexto(pctValor)}
              </span>
              <span className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-muted">acionável</span>
              <Contador
                valor={valorAlcancavel}
                formatar={compactoBRL}
                className="num mt-1 text-[12px] font-medium text-marca-ciano"
              />
            </AnelProgresso>
          ) : (
            <Esqueleto className="h-[172px] w-[172px] rounded-full" />
          )}
        </div>
      </div>
    </motion.section>
  );
}
