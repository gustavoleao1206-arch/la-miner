'use client';

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

import type { FiltrosFila, ResumoPrePrecatorios } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CONFERENCIA, ORDEM_CONFERENCIAS } from './vocabulario';

/**
 * A barra de busca do módulo de pré-precatórios — e, para a operação interna, o
 * filtro por veredito do CPF.
 *
 * Estágio e justiça NÃO estão aqui: viraram os dois cartões de quebra no topo
 * (`resumo.tsx`), onde a legenda é o filtro. Esta barra ficou com o que não é
 * quebra: procurar um processo, e limpar tudo.
 *
 * ── O FILTRO DE CPF É SÓ DA OPERAÇÃO ──
 *
 * O dono decidiu em 18/09/2026 que o assinante não vê o agregado de conferência
 * de CPF: "392 a conferir" na tela de quem paga lê-se como defeito do produto.
 * Para o time interno ele continua sendo a forma de achar o que revisar — os
 * divergentes ficam fora do sorteio e só aparecem aqui. `mostrarCpf` decide; o
 * servidor também não manda a contagem ao cliente, então não há o que vazar.
 */
export function FiltrosPrePrecatorios({
  filtros,
  resumo,
  mostrarCpf,
  aoMudar,
  aoLimpar,
  filtrando,
}: {
  filtros: FiltrosFila;
  /** `null` enquanto o resumo não chegou (ou falhou) — os chips ficam sem número. */
  resumo: ResumoPrePrecatorios | null;
  mostrarCpf: boolean;
  aoMudar: (m: Partial<FiltrosFila>) => void;
  aoLimpar: () => void;
  filtrando: boolean;
}) {
  const [termo, setTermo] = useState(filtros.termo ?? '');

  /* Debounce, e só quando o valor mudou de verdade — ver o comentário longo em
     `carteira/filtros.tsx`: o efeito roda na montagem, e sem a comparação ele
     disparava uma consulta a mais e apagava seleções feitas nos 400ms. */
  useEffect(() => {
    const alvo = termo || undefined;
    if (alvo === filtros.termo) return;
    const id = window.setTimeout(() => aoMudar({ termo: alvo }), 400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termo]);

  return (
    <section aria-label="Busca e filtros dos pré-precatórios" className="cartao p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          />
          <input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Número do processo, nome ou CPF do credor"
            aria-label="Buscar pré-precatório"
            className="h-10 w-full rounded-[11px] border border-linha bg-superficie pl-9 pr-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
          />
        </div>

        {mostrarCpf && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            title="Visível só para a operação interna — o assinante não vê este filtro."
          >
            {ORDEM_CONFERENCIAS.map((c) => {
              const ativo = filtros.conferencia === c;
              const quantos = resumo?.porConferencia?.find((x) => x.conferencia === c)?.quantidade;
              return (
                <button
                  key={c}
                  type="button"
                  aria-pressed={ativo}
                  onClick={() => aoMudar({ conferencia: ativo ? undefined : c })}
                  className={cn(
                    'flex h-10 items-center gap-1.5 rounded-[11px] border px-3 text-[12px] font-medium transition-colors',
                    ativo
                      ? CONFERENCIA[c].ativo
                      : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
                  )}
                >
                  {CONFERENCIA[c].chip}
                  {quantos !== undefined && (
                    <span className={cn('num', !ativo && 'text-muted-2')}>
                      {quantos.toLocaleString('pt-BR')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {filtrando && (
          <button
            type="button"
            onClick={() => {
              setTermo('');
              aoLimpar();
            }}
            className="flex h-10 items-center gap-1.5 rounded-[11px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
            Limpar
          </button>
        )}
      </div>

      {/* ── O RÓTULO DE HONESTIDADE ──
          Os números do topo contam o módulo (com a busca, se houver); a lista
          conta também o filtro clicado. Sem dizer isso, alguém vê "Estadual
          1.828" sobre uma lista de 40 e conclui que o sistema está errado. */}
      {resumo && (
        <p className="mt-2.5 text-[11px] text-muted-2">
          os números acima contam o módulo inteiro (ou a busca); cada filtro recorta só a lista
        </p>
      )}
    </section>
  );
}
