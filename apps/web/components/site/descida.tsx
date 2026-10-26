'use client';

import { useEffect, useRef, useState } from 'react';
import { Database, Cog, UserSearch, Filter, Sparkles, FolderCheck } from 'lucide-react';

/**
 * A DESCIDA — o fluxo do produto encenado como estratos de um poço.
 *
 * DADOS → PROCESSAMENTO → ANÁLISE → FILTROS → DESCOBERTA → RESULTADO, cada
 * etapa um estrato mais fundo. Um trilho vertical à esquerda carrega um
 * marcador que desce acompanhando o estrato ativo (IntersectionObserver — o
 * scroll continua do navegador, nunca sequestrado). No estrato DESCOBERTA o
 * marcador acende no azul da marca: é o momento em que o feixe encontra.
 *
 * Os textos são o funcionamento REAL do sistema — cada frase tem um módulo
 * correspondente no repositório. Prometer aqui o que o código não faz seria
 * dar ao cliente o documento da própria frustração.
 */
const ESTRATOS = [
  {
    id: 'dados',
    rotulo: 'DADOS',
    prof: '−300 m',
    icone: Database,
    titulo: 'A fonte é o tribunal',
    texto:
      'Listas de dívida consolidada e autos no PJe, extraídos direto da origem, nunca base revendida de terceiro. Cada valor continua rastreável até o processo que o gerou.',
  },
  {
    id: 'processamento',
    rotulo: 'PROCESSAMENTO',
    prof: '−380 m',
    icone: Cog,
    titulo: 'A extração vira estrutura',
    texto:
      'O que era PDF e diário vira base consultável: número do processo, tribunal, entidade devedora, estágio e valor, tudo versionado e auditável.',
  },
  {
    id: 'analise',
    rotulo: 'ANÁLISE',
    prof: '−460 m',
    icone: UserSearch,
    titulo: 'O titular é identificado',
    texto:
      'O nome no requisitório vira uma pessoa: CPF casado com a parte correta do processo originário. A etapa que consome semanas de estagiário, e onde a maioria das listas para.',
  },
  {
    id: 'filtros',
    rotulo: 'FILTROS',
    prof: '−520 m',
    icone: Filter,
    titulo: 'O contato é conferido',
    texto: 'Telefone, e-mail e endereço apurados e datados junto a provedores cadastrais.',
  },
  {
    id: 'descoberta',
    rotulo: 'DESCOBERTA',
    prof: '−560 m',
    icone: Sparkles,
    destaque: true,
    titulo: 'O veio acende',
    texto:
      'Dos milhares processados, os que valem a sua prospecção: titular certo, contato vivo, valor rastreado. É o ponto que acende na jazida.',
  },
  {
    id: 'resultado',
    rotulo: 'RESULTADO',
    prof: '−600 m',
    icone: FolderCheck,
    titulo: '250 na sua carteira, todo mês',
    texto:
      'Acumulativos e sem repetição: o que você não trabalhar continua seu. No segundo mês são 500; no terceiro, 750, com o CRM na mesma tela.',
  },
] as const;

export function Descida() {
  const [ativo, setAtivo] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const observador = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (e.isIntersecting) {
            const i = refs.current.indexOf(e.target as HTMLDivElement);
            if (i >= 0) setAtivo(i);
          }
        }
      },
      /* A faixa central da tela decide o estrato ativo — nem topo, nem rodapé. */
      { rootMargin: '-40% 0px -40% 0px' },
    );
    for (const el of refs.current) if (el) observador.observe(el);
    return () => observador.disconnect();
  }, []);

  return (
    <div className="relative mt-14">
      {/* O trilho do poço */}
      <div
        aria-hidden
        className="absolute bottom-6 left-[7px] top-2 hidden w-px sm:block"
        style={{ background: 'var(--linha-j)' }}
      />
      <div className="grid gap-2">
        {ESTRATOS.map((e, i) => {
          const Icone = e.icone;
          const corrente = i === ativo;
          const destaque = 'destaque' in e && e.destaque;
          return (
            <div
              key={e.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              className="relative py-6 pl-0 transition-opacity duration-500 sm:pl-12"
              style={{ opacity: corrente ? 1 : 0.45 }}
            >
              {/* O marcador no trilho: ciano em trânsito, azul da marca no achado. */}
              <span
                aria-hidden
                className="absolute left-0 top-8 hidden h-[15px] w-[15px] rounded-full border-2 transition-all duration-500 sm:block"
                style={{
                  borderColor: destaque ? 'var(--veio)' : corrente ? 'var(--sonda)' : 'var(--bruma-2)',
                  background: destaque && corrente ? 'var(--veio)' : 'var(--abismo)',
                  boxShadow:
                    corrente && destaque
                      ? '0 0 18px rgba(79,124,255,.55)'
                      : corrente
                        ? '0 0 12px rgba(42,212,232,.35)'
                        : 'none',
                }}
              />
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span
                  className="font-mono text-[11px] tracking-[0.22em]"
                  style={{ color: destaque ? 'var(--veio)' : 'var(--sonda)' }}
                >
                  {e.rotulo}
                </span>
                <span className="font-mono text-[11px] tracking-[0.14em]" style={{ color: 'var(--bruma-2)' }}>
                  {e.prof}
                </span>
              </div>
              <div className="mt-2 flex items-start gap-3.5">
                <Icone
                  aria-hidden
                  className="mt-1 h-5 w-5 shrink-0"
                  style={{ color: destaque ? 'var(--veio)' : 'var(--bruma)' }}
                />
                <div>
                  <h3 className="font-display text-lg font-semibold" style={{ color: 'var(--texto-j)' }}>
                    {e.titulo}
                  </h3>
                  <p className="mt-1.5 max-w-xl text-[15px] leading-relaxed" style={{ color: 'var(--bruma)' }}>
                    {e.texto}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
