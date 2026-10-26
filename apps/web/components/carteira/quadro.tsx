'use client';

import { SeloFase, ValorIndicativo } from '@/components/fase-processo';
import { useCallback, useEffect, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import Link from 'next/link';
import { AlertTriangle, Loader2, PhoneOff } from 'lucide-react';
import {
  crm,
  filaDeTrabalho,
  type Estagio,
  type FiltrosFila,
  type Funil,
  type ItemFila,
} from '@/lib/api';
import { brl, cn } from '@/lib/utils';
import type { Lote } from '@/lib/lote';
import { BlocoErro } from '@/components/estado';
import { Esqueleto } from '@/components/metricas';
import {
  decidirMovimento,
  moverNoQuadro,
  removerDoQuadro,
  type Coluna,
} from '@/lib/quadro';
import { COR_PRIORIDADE, ESTAGIO, ORDEM_ESTAGIOS, rotuloPrioridade } from './estagios';

/**
 * O QUADRO — a mesma carteira, vista por coluna.
 *
 * ── O ARRASTE NÃO DECIDE NADA ──
 *
 * O gesto é só o gesto: ao soltar, ele chama `aoMover`, exatamente o que o menu
 * "Mover para…" já chamava. Toda a regra — mesma coluna não grava, terminais
 * pedem confirmação, PERDIDO pede motivo, 404 remove — vive em `lib/quadro.ts`
 * e está coberta por teste ANTES de o arraste existir.
 *
 * Isso é deliberado, e a razão é dura: o ambiente de teste do front não calcula
 * posição de tela, então nenhum caso automático consegue afirmar "arrastei da
 * coluna A para a B". Se a regra morasse no manipulador do gesto, ela nasceria
 * sem prova nenhuma. Aqui o que fica descoberto é apenas a FÍSICA do ponteiro —
 * e é exatamente isso que a conferência no navegador consegue ver.
 *
 * ── QUANTOS CARTÕES ──
 *
 * 50 por coluna. A coluna "Novos" de um cliente grande tem 3.000 processos, e
 * cada linha da fila traz partes, etiquetas e tarefas por subconsulta: cinco
 * colunas cheias seriam dez vezes a carga da lista. O cabeçalho mostra o total
 * VERDADEIRO e a coluna diz que está mostrando uma parte — um número que mente
 * é pior que um número parcial declarado.
 */
const POR_COLUNA = 50;

/**
 * O ponteiro precisa ANDAR 6px para virar arraste.
 *
 * Sem essa distância, todo clique no cartão vira um arraste de zero pixel: o
 * link do número do processo pararia de abrir e o menu não abriria mais. Seis
 * pixels é curto o bastante para o gesto continuar imediato e longo o bastante
 * para um clique com a mão trêmula ainda ser um clique.
 */
const ATIVACAO = { distance: 6 };

export function Quadro({
  filtros,
  lote,
  carregando,
  funil,
  aoMudarFunil,
}: {
  /** Os mesmos filtros da lista, menos o estágio — aqui cada coluna É um estágio. */
  filtros: FiltrosFila;
  lote: Lote | null;
  /**
   * ⚠ `lote === null` NÃO significa "ainda não resolveu".
   *
   * Para o CLIENTE ele é o estado FINAL e permanente: `lib/lote.tsx` só define
   * padrão no ramo `!ehCliente`, e o comentário de lá chama isso de conserto —
   * escolher "o maior lote" para o assinante escondia o resto do que ele
   * comprou.
   *
   * Quem sabe se a resolução terminou é `carregando`. Sem esta prop, a guarda
   * abaixo prendia todo cliente num esqueleto eterno.
   */
  carregando: boolean;
  funil: Funil | null;
  aoMudarFunil: () => void;
}) {
  const [colunas, setColunas] = useState<Coluna[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [arrastando, setArrastando] = useState<string | null>(null);

  /* Toque junto do ponteiro: o quadro e feito para ficar aberto o dia todo, e
     num tablet o dedo E o ponteiro. O atraso no toque evita que rolar a
     coluna com o dedo vire arraste de cartao. */
  const sensores = useSensors(
    useSensor(PointerSensor, { activationConstraint: ATIVACAO }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  const [confirmando, setConfirmando] = useState<{
    item: ItemFila;
    de: Estagio;
    para: Estagio;
    pedeMotivo: boolean;
  } | null>(null);

  const carregar = useCallback(async () => {
    /* Enquanto a resolução NÃO TERMINOU nada é pedido: as cinco colunas
       cairiam no lote padrão enquanto o cabeçalho contaria a carteira inteira.
       Terminada, `lote` nulo é um pedido legítimo — "a carteira toda" —, e é
       assim que o cliente vê o que comprou. */
    if (carregando) return;
    setErro(null);
    try {
      const paginas = await Promise.all(
        ORDEM_ESTAGIOS.map((estagio) =>
          filaDeTrabalho({ ...filtros, estagio, pagina: 1, porPagina: POR_COLUNA }, lote ?? undefined),
        ),
      );
      setColunas(
        ORDEM_ESTAGIOS.map((estagio, i) => ({
          estagio,
          itens: paginas[i].itens,
          total: paginas[i].total,
        })),
      );
    } catch (e) {
      setErro((e as Error).message);
    }
  }, [filtros, lote, carregando]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * Move de verdade: pinta na tela primeiro, grava depois.
   *
   * O desfazer devolve o INSTANTÂNEO anterior, e não uma reconstrução: só assim
   * o cartão volta para a posição exata de onde saiu.
   */
  async function mover(item: ItemFila, para: Estagio, motivo?: string) {
    const de = item.estagio;
    const antes = colunas;
    if (!antes) return;

    setColunas(moverNoQuadro(antes, item.id, de, para));
    setAviso(null);

    try {
      /* `definirEstagio`, e NÃO a ação em massa com um id só. As duas gravam a
         mesma coisa no overlay, mas escrevem histórias diferentes na timeline:
         a de lote registra "Em lote: funil novo → proposta", e quem lesse isso
         meses depois concluiria que este processo foi apanhado numa varrida de
         duzentos — quando alguém o moveu à mão, um a um. A distinção existe
         justamente para isso. */
      await crm.definirEstagio(item.id, para, motivo);
      /* A contagem dos chips e do cabeçalho acompanha — sem isto, o quadro
         mostraria o cartão na coluna nova e o número antigo em cima dela. */
      aoMudarFunil();
      setAviso(`${item.numeroPrecatorio} → ${ESTAGIO[para].singular}`);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) {
        /* O processo saiu da carteira desta organização. Devolvê-lo à coluna de
           origem reafirmaria na tela o que o servidor acabou de negar. */
        setColunas(removerDoQuadro(antes, item.id));
        setAviso(`${item.numeroPrecatorio} não está mais na sua carteira.`);
        return;
      }
      setColunas(antes);
      setErro((e as Error).message);
    }
  }

  if (carregando || (!colunas && !erro)) {
    return (
      <div className="mt-5 grid gap-4 lg:grid-cols-5">
        {ORDEM_ESTAGIOS.map((e) => (
          <Esqueleto key={e} className="h-64" />
        ))}
      </div>
    );
  }

  /* UM caminho, dois gestos. O menu chama isto; o arraste, ao soltar, chama
     exatamente a mesma função — é o que faz o teste do menu valer pelos dois. */
  const pedirMovimento = (item: ItemFila, para: Estagio) => {
    const d = decidirMovimento(item.estagio, para);
    if (d.tipo === 'nada') return;
    if (d.tipo === 'confirma') {
      setConfirmando({ item, de: d.de, para: d.para, pedeMotivo: d.pedeMotivo });
      return;
    }
    void mover(item, para);
  };

  return (
    <>
      {erro && <BlocoErro msg={`Não foi possível mover: ${erro}`} className="mt-4" />}
      {aviso && (
        <p role="status" className="mt-4 text-[13px] text-muted">
          {aviso}
        </p>
      )}

      <DndContext
        sensors={sensores}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setArrastando(String(e.active.id))}
        onDragEnd={(e) => {
          setArrastando(null);
          const destino = e.over?.id as Estagio | undefined;
          const item = colunas?.flatMap((c) => c.itens).find((i) => i.id === e.active.id);
          /* Soltar fora de qualquer coluna é desistência, e desistência não
             grava nada — nem sequer chega ao `decidirMovimento`. */
          if (!destino || !item) return;
          pedirMovimento(item, destino);
        }}
        onDragCancel={() => setArrastando(null)}
      >
        <div className="mt-5 grid gap-4 lg:grid-cols-5">
          {colunas?.map((c) => (
            <ColunaDoQuadro
              key={c.estagio}
              coluna={c}
              /* O cabeçalho prefere o total do FUNIL quando ele existe: é o mesmo
                 número dos chips da lista, e vê-los diferentes na mesma tela seria
                 o defeito que a Etapa 2 existiu para fechar. */
              total={funil ? funil[c.estagio] : c.total}
              aoMover={pedirMovimento}
            />
          ))}
        </div>

        {/* O cartão que voa sob o cursor. Sem ele, o arraste move um espaço
            vazio e ninguém entende o que está segurando. */}
        <DragOverlay dropAnimation={null}>
          {arrastando && (
            <div className="rotate-2 rounded-[12px] border border-marca-ciano/50 bg-superficie p-2.5 shadow-xl">
              <p className="num text-[12px] text-marca-ciano">
                {colunas?.flatMap((c) => c.itens).find((i) => i.id === arrastando)?.numeroPrecatorio}
              </p>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {confirmando && (
        <Confirmacao
          dados={confirmando}
          aoCancelar={() => setConfirmando(null)}
          aoConfirmar={(motivo) => {
            const { item, para } = confirmando;
            setConfirmando(null);
            void mover(item, para, motivo);
          }}
        />
      )}
    </>
  );
}

function ColunaDoQuadro({
  coluna,
  total,
  aoMover,
}: {
  coluna: Coluna;
  total: number;
  aoMover: (item: ItemFila, para: Estagio) => void;
}) {
  const e = ESTAGIO[coluna.estagio];
  const escondidos = total - coluna.itens.length;

  /* A coluna INTEIRA é a área de soltar, e não só a lista de cartões: mirar uma
     lista vazia de 4px de altura seria impossível, e é justamente na coluna
     vazia que se quer soltar o primeiro cartão. */
  const { setNodeRef, isOver } = useDroppable({ id: coluna.estagio });

  return (
    <section
      ref={setNodeRef}
      aria-label={e.plural}
      className={cn(
        'flex flex-col rounded-[16px] border bg-vidro transition-colors',
        isOver ? 'border-marca-ciano/60 bg-marca-ciano/[0.06]' : 'border-linha',
      )}
    >
      <header className="flex items-center justify-between border-b border-linha px-3.5 py-3">
        <span className={cn('text-[12px] font-medium', e.texto)}>{e.plural}</span>
        <span className="num text-[12px] text-muted">{total.toLocaleString('pt-BR')}</span>
      </header>

      <div className="flex-1 space-y-2 overflow-y-auto p-2.5" style={{ maxHeight: '60vh' }}>
        {coluna.itens.map((i) => (
          <Cartao key={i.id} item={i} aoMover={aoMover} />
        ))}

        {coluna.itens.length === 0 && (
          <p className="px-1.5 py-6 text-center text-[12px] text-muted-2">nada aqui</p>
        )}

        {/* O cabeçalho NUNCA mente sobre o que a coluna não está exibindo. */}
        {escondidos > 0 && (
          <p className="px-1.5 pb-1 pt-2 text-center text-[11px] text-muted-2">
            mostrando {coluna.itens.length} de {total.toLocaleString('pt-BR')} · use os filtros ou a
            lista para chegar ao resto
          </p>
        )}
      </div>
    </section>
  );
}

function Cartao({
  item: i,
  aoMover,
}: {
  item: ItemFila;
  aoMover: (item: ItemFila, para: Estagio) => void;
}) {
  const dias = i.ultimoContatoEm
    ? Math.floor((Date.now() - new Date(i.ultimoContatoEm).getTime()) / 86_400_000)
    : null;

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: i.id });

  return (
    <article
      ref={setNodeRef}
      className={cn(
        'rounded-[12px] border border-linha bg-superficie p-2.5 transition-colors hover:border-linha-2',
        /* O original fica esmaecido enquanto o cartão voa: sem isso, ele parece
           duplicado — um sob o cursor e outro parado na coluna. */
        isDragging && 'opacity-40',
      )}
    >
      {/* ── A ÁREA DE PEGAR ──
          Os ouvintes do arraste ficam AQUI, e não no cartão inteiro. O cartão
          contém um link e um menu, e ambos precisam continuar clicáveis: com o
          gesto capturando o cartão todo, abrir o processo viraria arraste de
          dois pixels e o menu não abriria mais. */}
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
        <Link
          href={`/processo/${i.id}`}
          /* O link precisa ganhar do gesto no CLIQUE: `distance: 6` já garante
             isso, e este `onPointerDown` impede que o arraste comece a partir do
             próprio link — arrastar pelo texto do número abriria o processo ao
             soltar. */
          onPointerDown={(e) => e.stopPropagation()}
          className="num text-[12px] text-marca-ciano hover:underline"
        >
          {i.numeroPrecatorio}
        </Link>

        {i.titular && (
          <>
            <p className="mt-1 truncate text-[12px] text-ink-2" title={i.titular.nome}>
              {i.titular.nome}
            </p>
          </>
        )}

        {/* O valor APURADO, quando existe. Quando não existe, o indicativo — e
            ele se identifica como estimado, porque foi extraído de texto. */}
        {i.valor !== null ? (
          <p className="num mt-1 text-[12px] text-ink">{brl(i.valor)}</p>
        ) : (
          <p className="num mt-1 text-[12px]">
            <ValorIndicativo valor={i.valorIndicativo} />
          </p>
        )}

        <div className="mt-1.5">
          <SeloFase fase={i.fase} />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={COR_PRIORIDADE[i.prioridade]}>{rotuloPrioridade(i.prioridade)}</span>
          {dias === null ? (
            <span className="flex items-center gap-1 text-alerta">
              <PhoneOff aria-hidden className="h-3 w-3" />
              nunca
            </span>
          ) : (
            <span className="num text-muted-2">há {dias}d</span>
          )}
          {i.tarefasAtrasadas > 0 && (
            <span className="flex items-center gap-1 text-erro">
              <AlertTriangle aria-hidden className="h-3 w-3" />
              {i.tarefasAtrasadas}
            </span>
          )}
        </div>
      </div>

      {/* ── O CAMINHO DE TECLADO ──
          Não é alternativa de segunda classe ao arraste que vem depois: é a
          única forma de o teste automático provar a regra, e a única de quem
          não usa ponteiro mover um cartão. */}
      <select
        aria-label={`Mover ${i.numeroPrecatorio}`}
        value=""
        onChange={(e) => {
          const destino = e.target.value as Estagio;
          e.target.value = '';
          if (destino) aoMover(i, destino);
        }}
        className="mt-2.5 h-8 w-full rounded-[9px] border border-linha bg-bg/60 px-2 text-[12px] text-muted outline-none focus:border-marca-ciano/40"
      >
        <option value="">Mover para…</option>
        {ORDEM_ESTAGIOS.filter((v) => v !== i.estagio).map((v) => (
          <option key={v} value={v}>
            {ESTAGIO[v].singular}
          </option>
        ))}
      </select>
    </article>
  );
}

/**
 * A confirmação dos terminais.
 *
 * O servidor aceita qualquer pulo sem validar — de "Novo" direto para "Fechado"
 * passa, e escreve uma linha permanente na timeline. Aqui há uma pausa antes
 * disso, e o motivo da perda é pedido no mesmo lugar: perguntar depois seria
 * pedir a alguém que reconstitua de memória por que desistiu.
 */
function Confirmacao({
  dados,
  aoConfirmar,
  aoCancelar,
}: {
  dados: { item: ItemFila; de: Estagio; para: Estagio; pedeMotivo: boolean };
  aoConfirmar: (motivo?: string) => void;
  aoCancelar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [salvando, setSalvando] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Mover para ${ESTAGIO[dados.para].singular}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onKeyDown={(e) => e.key === 'Escape' && aoCancelar()}
    >
      <div className="w-full max-w-md rounded-[16px] border border-linha bg-superficie p-5">
        <h2 className="text-[15px] font-medium text-ink">
          Mover para {ESTAGIO[dados.para].singular}?
        </h2>
        <p className="mt-1.5 text-[13px] text-muted">
          {dados.item.numeroPrecatorio} sai de {ESTAGIO[dados.de].singular}. É um estágio
          terminal: encerra a negociação e fica registrado no histórico do processo.
        </p>

        {dados.pedeMotivo && (
          <input
            autoFocus
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            maxLength={300}
            placeholder="Por que se perdeu? (opcional)"
            aria-label="Motivo da perda"
            className="mt-4 h-9 w-full rounded-[11px] border border-linha bg-bg/60 px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
          />
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={aoCancelar}
            className="h-9 rounded-[11px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={salvando}
            onClick={() => {
              setSalvando(true);
              aoConfirmar(motivo.trim() || undefined);
            }}
            className="flex h-9 items-center gap-2 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {salvando && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
