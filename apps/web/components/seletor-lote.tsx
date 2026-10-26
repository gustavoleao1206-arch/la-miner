'use client';

import { useMemo } from 'react';
import { ChevronDown, Landmark } from 'lucide-react';
import { useLote } from '@/lib/lote';
import { useUsuario } from '@/lib/usuario';
import { cn } from '@/lib/utils';

/**
 * Troca o tribunal e o exercício em foco no painel inteiro.
 *
 * Um `<select>` nativo, e não um menu desenhado: é um controle de escopo usado
 * de vez em quando, funciona com teclado e leitor de tela sem nada extra, e no
 * celular abre a roda nativa do sistema. Uma listbox própria custaria três vezes
 * mais código para ficar pior nos três casos.
 *
 * Só oferece lotes que EXISTEM na carteira da organização. Um seletor com os
 * seis TRFs sempre visíveis prometeria carteiras que o escritório não tem, e o
 * operador aprenderia que quase toda opção leva a uma tela vazia.
 */
export function SeletorLote({ className }: { className?: string }) {
  const { lote, definir, catalogo, carregando } = useLote();
  const { ehCliente } = useUsuario();

  const opcoes = useMemo(
    () =>
      catalogo
        .flatMap((t) =>
          t.exercicios.map((e) => ({
            valor: `${t.sigla}|${e.exercicio}`,
            sigla: t.sigla,
            exercicio: e.exercicio,
            processos: e.processos,
          })),
        )
        .sort((a, b) => a.sigla.localeCompare(b.sigla) || b.exercicio - a.exercicio),
    [catalogo],
  );

  /* Um lote só não é escolha: mostrar um seletor travado sugere que existe algo
     a escolher. Vira rótulo — a informação continua visível, sem a promessa.
     Para o CLIENTE isso não vale: com um tribunal só, "todos" e "aquele
     tribunal" dão o mesmo resultado, então o rótulo continua honesto. */
  if (carregando || opcoes.length === 0) return null;

  if (opcoes.length === 1) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-[11px] border border-linha bg-superficie px-3 py-2',
          className,
        )}
      >
        <Landmark aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="num text-[12px] text-ink-2">
          {opcoes[0].sigla} · {opcoes[0].exercicio}
        </span>
      </div>
    );
  }

  return (
    <div className={cn('relative', className)}>
      <label htmlFor="seletor-lote" className="sr-only">
        Tribunal e exercício em foco
      </label>
      <Landmark
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
      />
      <select
        id="seletor-lote"
        value={lote ? `${lote.tribunal}|${lote.exercicio}` : ''}
        onChange={(e) => {
          /* Valor vazio = "todos". Sem este ramo, escolher um tribunal era uma
             porta de mão única: o cliente perdia o resto da carteira que
             comprou e não tinha como voltar. */
          if (!e.target.value) return definir(null);
          const [tribunal, exercicio] = e.target.value.split('|');
          definir({ tribunal, exercicio: Number(exercicio) });
        }}
        className="num h-9 w-full appearance-none rounded-[11px] border border-linha bg-superficie pl-8 pr-8 text-[12px] text-ink-2 transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:outline-none"
      >
        {/* Só para o cliente: para ele a carteira INTEIRA é o estado natural, e
            o tribunal é filtro voluntário. Para a operação interna o lote é
            ESCOPO — "todos" misturaria safras de importação, que é justamente
            o problema que o conceito de lote existe para resolver. */}
        {ehCliente && <option value="">todos os tribunais</option>}
        {opcoes.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.sigla} · {o.exercicio} ({o.processos.toLocaleString('pt-BR')})
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
      />
    </div>
  );
}
