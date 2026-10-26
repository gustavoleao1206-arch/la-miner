'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, PhoneOff, Search, X } from 'lucide-react';
import type { Etiqueta, FiltrosFila, Funil, MembroEquipe, Prioridade } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  ESTAGIO,
  ORDEM_ESTAGIOS,
  PRIORIDADES,
  rotuloDeMovimento,
  rotuloPrioridade,
} from './estagios';

/**
 * O cartão de filtros da fila de trabalho.
 *
 * Extraído de `carteira/page.tsx` sem uma mudança de comportamento: as próximas
 * etapas acrescentam a contagem nos chips e o filtro de "frios", e o quadro
 * arrastável reaproveita este mesmo cartão. Editar tudo isso dentro de um
 * arquivo de 700 linhas, em duas frentes ao mesmo tempo, é o caminho conhecido
 * para a regressão que só aparece no navegador.
 */
export function Filtros({
  filtros,
  equipe,
  etiquetas,
  funil,
  aoMudar,
  aoLimpar,
  filtrando,
}: {
  filtros: FiltrosFila;
  equipe: MembroEquipe[];
  etiquetas: Etiqueta[];
  /** `null` enquanto não há lote resolvido — a contagem não aparece. */
  funil: Funil | null;
  aoMudar: (m: Partial<FiltrosFila>) => void;
  aoLimpar: () => void;
  filtrando: boolean;
}) {
  const [termo, setTermo] = useState(filtros.termo ?? '');

  /* Debounce: sem ele, cada tecla dispararia uma consulta paginada sobre a
     carteira inteira.

     ── E POR QUE SÓ QUANDO O VALOR MUDOU DE VERDADE ──
     O efeito também roda na MONTAGEM, e antes desta comparação ele avisava
     "termo: undefined" 400ms depois de a tela abrir — com o termo já sendo
     undefined. Duas consequências, as duas invisíveis até alguém procurar: a
     fila era consultada DUAS vezes a cada abertura, e o objeto de filtros
     nascia de novo, o que limpava qualquer seleção feita nesses 400ms. Quem
     marcasse três processos assim que a tela abrisse via a barra de ação sumir
     sozinha. Descoberto por um teste que demorava mais que o debounce. */
  useEffect(() => {
    const alvo = termo || undefined;
    if (alvo === filtros.termo) return;
    const id = window.setTimeout(() => aoMudar({ termo: alvo }), 400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termo]);

  const selectClasse =
    'h-9 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40';

  return (
    <section aria-label="Filtros da fila" className="cartao p-5">
      {/* Os estágios como chips: é o corte que o operador faz primeiro, e um
          <select> escondê-lo-ia atrás de um clique a mais. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {ORDEM_ESTAGIOS.map((valor) => {
          const e = ESTAGIO[valor];
          const ativo = filtros.estagio === valor;
          const quantos = funil?.[valor];
          return (
            <button
              key={valor}
              type="button"
              aria-pressed={ativo}
              onClick={() => aoMudar({ estagio: ativo ? undefined : valor })}
              className={cn(
                'flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors',
                ativo ? e.ativo : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
              )}
            >
              {e.plural}
              {/* O número DENTRO do chip. Sem ele, o escritório filtrava às
                  cegas: clicava em "Proposta" só para descobrir se havia alguma.
                  `undefined` some em vez de virar zero — zero é uma AFIRMAÇÃO
                  sobre a carteira, e antes de o lote resolver não se sabe nada. */}
              {quantos !== undefined && (
                <span className={cn('num tabular-nums', !ativo && 'text-muted-2')}>
                  {quantos.toLocaleString('pt-BR')}
                </span>
              )}
            </button>
          );
        })}

        {/* ── O RÓTULO DE HONESTIDADE ──
            Os dois números medem recortes diferentes de PROPÓSITO: o chip conta
            o lote com os demais filtros, a lista conta também o estágio clicado.
            Sem dizer isso aqui, alguém vê "Proposta 7" e uma lista de 3 e conclui
            que o sistema está errado. */}
        {funil && (
          <span className="ml-1 text-[11px] text-muted-2">
            contagens do lote em foco; a lista abaixo segue os filtros
          </span>
        )}
      </div>

      {funil && <LinhaDeMovimento funil={funil} />}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Número do processo, nome ou CPF do titular"
            aria-label="Buscar na fila"
            className="h-9 w-full rounded-[11px] border border-linha bg-superficie pl-9 pr-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
          />
        </div>

        <select
          aria-label="Prioridade"
          value={filtros.prioridade ?? ''}
          onChange={(e) => aoMudar({ prioridade: (e.target.value || undefined) as Prioridade })}
          className={selectClasse}
        >
          <option value="">Qualquer prioridade</option>
          {PRIORIDADES.map((p) => (
            <option key={p} value={p}>
              {rotuloPrioridade(p)}
            </option>
          ))}
        </select>

        <select
          aria-label="Responsável"
          value={filtros.responsavelId ?? ''}
          onChange={(e) => aoMudar({ responsavelId: e.target.value || undefined })}
          className={selectClasse}
        >
          <option value="">Qualquer responsável</option>
          <option value="nenhum">Sem responsável</option>
          {equipe.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nome}
            </option>
          ))}
        </select>

        {etiquetas.length > 0 && (
          <select
            aria-label="Etiqueta"
            value={filtros.etiquetaId ?? ''}
            onChange={(e) => aoMudar({ etiquetaId: e.target.value || undefined })}
            className={selectClasse}
          >
            <option value="">Qualquer etiqueta</option>
            {etiquetas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
        )}

        {/* Os dois filtros que respondem "o que está PARADO" — o motivo de a
            fila existir. */}
        <Alternar
          ativo={Boolean(filtros.semContato)}
          Icone={PhoneOff}
          rotulo="Sem contato"
          aoAlternar={() => aoMudar({ semContato: !filtros.semContato || undefined })}
        />

        {/* "Nunca foi tocado" e "esfriou" são perguntas diferentes: a primeira
            é do começo do mês, a segunda é a que decide a manhã de quem liga. */}
        <select
          aria-label="Sem contato há"
          value={filtros.frioDias ?? ''}
          onChange={(e) => aoMudar({ frioDias: Number(e.target.value) || undefined })}
          className={selectClasse}
        >
          <option value="">Frios…</option>
          <option value="7">+7 dias sem contato</option>
          <option value="15">+15 dias sem contato</option>
          <option value="30">+30 dias sem contato</option>
        </select>
        <Alternar
          ativo={Boolean(filtros.tarefaAtrasada)}
          Icone={AlertTriangle}
          rotulo="Tarefa atrasada"
          aoAlternar={() => aoMudar({ tarefaAtrasada: !filtros.tarefaAtrasada || undefined })}
        />

        {filtrando && (
          <button
            onClick={aoLimpar}
            className="flex h-9 items-center gap-1.5 rounded-[11px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
          >
            <X aria-hidden className="h-3.5 w-3.5" />
            Limpar
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * A LINHA DE MOVIMENTO — o que ANDOU, e não o que está parado nas colunas.
 *
 * Os chips mostram estoque: "16 em proposta" pode ser a mesma proposta parada
 * desde março. Esta linha responde a outra pergunta, a que diz se a carteira
 * está viva.
 *
 * Some inteira quando tudo é zero: uma fileira de "0 · 0 · 0" parece defeito, e
 * não informação. E vem sempre acompanhada da data em que o registro começou —
 * o carimbo de movimento nasceu com a migration do funil, então um zero solto
 * afirmaria "nada se moveu" onde a verdade é "não sabemos".
 */
function LinhaDeMovimento({ funil }: { funil: Funil }) {
  const m = funil.movimento;
  const partes = ORDEM_ESTAGIOS.filter((v) => v !== 'NOVO' && m[v] > 0).map(
    (v) => `${m[v].toLocaleString('pt-BR')} ${rotuloDeMovimento(v, m[v])}`,
  );

  if (partes.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="text-[12px] text-muted">
        Movimentaram nos últimos {m.dias} dias:{' '}
        <span className="text-ink-2">{partes.join(' · ')}</span>
      </p>
      {/* Em linha própria: colada na frase acima, a ressalva virava parte do
          número ("...4 perdidoscada processo conta uma vez"). */}
      <p className="mt-0.5 text-[11px] text-muted-2">
        cada processo conta uma vez, no estágio em que está hoje · registro desde{' '}
        {new Date(m.desde).toLocaleDateString('pt-BR')}
      </p>
    </div>
  );
}

export function Alternar({
  ativo,
  rotulo,
  Icone,
  aoAlternar,
}: {
  ativo: boolean;
  rotulo: string;
  Icone: typeof PhoneOff;
  aoAlternar: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      onClick={aoAlternar}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-[11px] border px-3 text-[13px] transition-colors',
        ativo
          ? 'border-alerta/40 bg-alerta/10 text-alerta'
          : 'border-linha text-muted hover:border-linha-2',
      )}
    >
      <Icone aria-hidden className="h-3.5 w-3.5" />
      {rotulo}
    </button>
  );
}
