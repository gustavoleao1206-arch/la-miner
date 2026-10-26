'use client';

import { SeloFase, ValorIndicativo } from '@/components/fase-processo';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, PhoneOff, Search, X } from 'lucide-react';
import {
  crm,
  filaDeTrabalho,
  type Etiqueta,
  type Estagio,
  type FiltrosFila,
  type Funil,
  type ItemFila,
  type MembroEquipe,
  type PaginaFila,
} from '@/lib/api';
import { brl, cn } from '@/lib/utils';
import { useLote } from '@/lib/lote';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';
import { Esqueleto } from '@/components/metricas';
import { Paginacao } from '@/components/paginacao';
import { Filtros } from '@/components/carteira/filtros';
import { BarraDeLote } from '@/components/carteira/barra-lote';
import { Quadro } from '@/components/carteira/quadro';
import {
  COR_PRIORIDADE,
  ESTAGIO,
  ORDEM_ESTAGIOS,
  rotuloPrioridade,
} from '@/components/carteira/estagios';

/**
 * A FILA DE TRABALHO — a carteira como lista acionável.
 *
 * ── POR QUE UMA TELA NOVA, E NÃO UM FILTRO DA CONSULTA ──
 *
 * "Consulta" responde onde está uma PESSOA: entra-se por CPF ou nome. Esta
 * responde outra pergunta — o que eu trabalho agora —, e a unidade é o PROCESSO,
 * porque é nele que moram estágio, prioridade, responsável, etiqueta e contato.
 *
 * Sem ela, o cliente que recebe 250 processos no dia 1º precisava abrir um a um
 * para descobrir quais já tinham sido tocados. A tela de um processo era rica; a
 * carteira era cega.
 */

const dias = (iso: string) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));

const cpfCurto = (cpf: string) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;

/**
 * A tela em si vive em `Fila`; isto aqui só existe por causa do Suspense.
 *
 * `useSearchParams` obriga a uma fronteira de Suspense na compilação de
 * produção — e a falta dela NÃO aparece no modo de desenvolvimento: quebra
 * apenas no `next build`, com uma mensagem que não cita a página. É a armadilha
 * documentada do Next, e a fronteira aqui é o que a fecha.
 */
export default function CarteiraPage() {
  return (
    <Suspense fallback={null}>
      <Fila />
    </Suspense>
  );
}

function Fila() {
  const { lote, carregando } = useLote();
  const parametros = useSearchParams();

  /* ── O ESTÁGIO PODE VIR DA URL ──
     É o que faz o clique na tela do sócio ("Proposta: 16") cair na lista já
     filtrada. Sem isto, o link levaria à fila inteira e a pessoa teria de
     refazer à mão o filtro que acabou de clicar.
     Lido UMA vez, na montagem: daí em diante o filtro é estado da tela. Manter
     os dois em sincronia permanente exigiria reescrever a URL a cada clique de
     chip, e o botão "voltar" do navegador passaria a desfazer filtros um a um. */
  const [filtros, setFiltros] = useState<FiltrosFila>(() => {
    const daUrl = parametros.get('estagio');
    const valido = daUrl && (ORDEM_ESTAGIOS as string[]).includes(daUrl);
    return { pagina: 1, porPagina: 25, ...(valido ? { estagio: daUrl as Estagio } : {}) };
  });

  /* ── LISTA OU QUADRO ──
     São a MESMA carteira e os MESMOS filtros: o que muda é a forma de olhar.
     Duas telas separadas obrigariam a manter dois conjuntos de filtros em
     sincronia, e o primeiro a divergir mandaria o operador de volta à lista sem
     entender por que os números mudaram. */
  const [quadro, setQuadro] = useState(() => parametros.get('vista') === 'quadro');
  const [pagina, setPagina] = useState<Estado<PaginaFila>>(CARREGANDO);
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [equipe, setEquipe] = useState<MembroEquipe[]>([]);
  const [etiquetas, setEtiquetas] = useState<Etiqueta[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    crm.equipe().then(setEquipe).catch(() => setEquipe([]));
    crm.listarEtiquetas().then(setEtiquetas).catch(() => setEtiquetas([]));
  }, []);

  const carregar = useCallback(async () => {
    try {
      setPagina({ st: 'ok', dados: await filaDeTrabalho(filtros, lote ?? undefined) });
    } catch (e) {
      setPagina({ st: 'erro', msg: (e as Error).message });
    }
  }, [filtros, lote]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /**
   * ── A CONTAGEM DOS CHIPS ──
   *
   * Só é pedida quando há LOTE RESOLVIDO. Sem ele, o funil contaria a carteira
   * inteira enquanto a fila cai no lote padrão — o chip diria 500 sobre uma
   * lista de 183, que é o defeito que este projeto já viu uma vez. Enquanto o
   * lote não resolve, os chips ficam sem número: ausência é honesta, zero seria
   * uma afirmação falsa sobre a carteira.
   *
   * `estagio` fica de fora dos filtros enviados (ver `crm.funil`): o chip é o
   * recorte da lista, não da contagem.
   */
  const [funil, setFunil] = useState<Funil | null>(null);
  const recarregarFunil = useCallback(async () => {
    /* ⚠ `carregando`, e não `!lote`: para o CLIENTE o lote nunca resolve para um
       valor, e a guarda antiga o deixava com chips sem número para sempre. O
       comentário acima descrevia isso como transitório — e é, só que apenas
       para a operação interna. Sem lote, a fila também pede a carteira inteira
       (`lote ?? undefined`, logo acima), então os dois contam o MESMO universo:
       o "chip diria 500 sobre uma lista de 183" não acontece aqui. */
    if (carregando) {
      setFunil(null);
      return;
    }
    try {
      const { estagio: _oChipEhDaLista, pagina: _p, porPagina: _pp, ...paraContar } = filtros;
      setFunil(await crm.funil(lote ?? undefined, paraContar));
    } catch {
      /* A contagem é acessório; a FILA é o trabalho. Se ela falhar, os chips
         voltam a ficar sem número e a lista continua de pé — derrubar a tela
         inteira por causa de um agregado seria trocar o essencial pelo enfeite. */
      setFunil(null);
    }
  }, [lote, filtros]);

  useEffect(() => {
    void recarregarFunil();
  }, [recarregarFunil]);

  /* A seleção morre a cada nova consulta. Mantê-la seria pior do que parece: os
     ids continuariam marcados fora da tela, e uma ação em massa atingiria
     processos que o operador não está mais vendo. */
  useEffect(() => {
    setSelecao(new Set());
  }, [filtros, lote]);

  const itens = pagina.st === 'ok' ? pagina.dados.itens : [];
  const todosMarcados = itens.length > 0 && itens.every((i) => selecao.has(i.id));

  const mexer = (mudanca: Partial<FiltrosFila>) =>
    setFiltros((f) => ({ ...f, ...mudanca, pagina: 1 }));

  const filtrando =
    Boolean(filtros.termo) ||
    Boolean(filtros.estagio) ||
    Boolean(filtros.prioridade) ||
    Boolean(filtros.responsavelId) ||
    Boolean(filtros.etiquetaId) ||
    Boolean(filtros.semContato) ||
    Boolean(filtros.frioDias) ||
    Boolean(filtros.tarefaAtrasada);

  return (
    <div className="p-6 lg:p-9">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="rotulo">Carteira</p>
          <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            Fila de trabalho
          </h1>
          <p className="mt-1.5 text-sm text-muted">
            O que trabalhar agora. Filtre, selecione e aja sobre vários de uma vez.
          </p>
        </div>

        <div className="flex rounded-[11px] border border-linha p-0.5">
          {(
            [
              [false, 'Lista'],
              [true, 'Quadro'],
            ] as const
          ).map(([ehQuadro, rotulo]) => (
            <button
              key={rotulo}
              type="button"
              aria-pressed={quadro === ehQuadro}
              onClick={() => setQuadro(ehQuadro)}
              className={cn(
                'h-8 rounded-[9px] px-3 text-[12px] font-medium transition-colors',
                quadro === ehQuadro ? 'bg-superficie-2 text-ink' : 'text-muted hover:text-ink-2',
              )}
            >
              {rotulo}
            </button>
          ))}
        </div>
      </header>

      <Filtros
        filtros={filtros}
        equipe={equipe}
        etiquetas={etiquetas}
        funil={funil}
        aoMudar={mexer}
        aoLimpar={() => setFiltros({ pagina: 1, porPagina: 25 })}
        filtrando={filtrando}
      />

      {quadro ? (
        /* O quadro recebe os MESMOS filtros e o MESMO funil: é a carteira
           vista por coluna, não outra tela com outros números. */
        <Quadro
          filtros={filtros}
          lote={lote}
          carregando={carregando}
          funil={funil}
          aoMudarFunil={recarregarFunil}
        />
      ) : (
        <>
        {selecao.size > 0 && (
          <BarraDeLote
            quantidade={selecao.size}
            equipe={equipe}
            etiquetas={etiquetas}
            aoAplicar={async (dados) => {
              const r = await crm.acaoEmLote({ processoIds: [...selecao], ...dados });
              setAviso(
                `${r.alterados} de ${r.aplicados} processo(s) alterado(s)` +
                  (r.ignorados > 0 ? ` · ${r.ignorados} fora da sua carteira, ignorado(s)` : '') +
                  (r.alterados < r.aplicados ? ' — o resto já estava assim.' : '.'),
              );
              setSelecao(new Set());
              /* A contagem acompanha a mudança: mover 40 para PERDIDO e ver o chip
                 "Perdidos" parado no número antigo faria a tela parecer travada. */
              await Promise.all([carregar(), recarregarFunil()]);
            }}
            aoLimpar={() => setSelecao(new Set())}
          />
        )}

        {aviso && (
          <div
            role="status"
            className="mt-4 flex items-start gap-2.5 rounded-[14px] border border-ok/25 bg-ok/[0.08] px-4 py-3 text-[13px] text-ok"
          >
            <span className="flex-1">{aviso}</span>
            <button onClick={() => setAviso(null)} aria-label="Dispensar">
              <X aria-hidden className="h-4 w-4" />
            </button>
          </div>
        )}

        <section className="cartao mt-5 overflow-hidden">
          {pagina.st === 'carregando' && (
            <div className="space-y-3 p-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Esqueleto key={i} className="h-11" />
              ))}
            </div>
          )}

          {pagina.st === 'erro' && (
            <div className="p-6">
              <BlocoErro msg={`Não foi possível carregar a fila: ${pagina.msg}`} />
            </div>
          )}

          {pagina.st === 'ok' && itens.length === 0 && (
            <Vazio
              Icone={Search}
              titulo={filtrando ? 'Nada com esses filtros' : 'Carteira vazia'}
              descricao={
                filtrando
                  ? 'Nenhum processo da sua carteira atende a esta combinação. Afrouxe um filtro.'
                  : 'Quando o próximo ciclo liberar processos, eles aparecem aqui.'
              }
            />
          )}

          {pagina.st === 'ok' && itens.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[64rem] text-sm">
                  <caption className="sr-only">
                    Processos da carteira com estágio no funil, prioridade, responsável e último contato.
                  </caption>
                  <thead>
                    <tr className="border-b border-linha text-left">
                      <th scope="col" className="w-10 px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label="Selecionar todos desta página"
                          checked={todosMarcados}
                          onChange={(e) =>
                            setSelecao(
                              e.target.checked
                                ? new Set([...selecao, ...itens.map((i) => i.id)])
                                : new Set([...selecao].filter((id) => !itens.some((i) => i.id === id))),
                            )
                          }
                          className="h-4 w-4 accent-marca-ciano"
                        />
                      </th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Processo</th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Titular</th>
                      <th scope="col" className="rotulo px-4 py-3 text-right font-medium">Valor</th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Funil</th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Prioridade</th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Responsável</th>
                      <th scope="col" className="rotulo px-4 py-3 font-medium">Contato</th>
                    </tr>
                  </thead>
                  <tbody>
                    {itens.map((i) => (
                      <Linha
                        key={i.id}
                        item={i}
                        marcado={selecao.has(i.id)}
                        aoMarcar={(v) =>
                          setSelecao((s) => {
                            const novo = new Set(s);
                            if (v) novo.add(i.id);
                            else novo.delete(i.id);
                            return novo;
                          })
                        }
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <Paginacao
                pagina={pagina.dados}
                aoIr={(p) => setFiltros((f) => ({ ...f, pagina: p }))}
              />
            </>
          )}
          </section>
        </>
      )}
    </div>
  );
}

// ── Linha ──────────────────────────────────────────────────

function Linha({
  item: i,
  marcado,
  aoMarcar,
}: {
  item: ItemFila;
  marcado: boolean;
  aoMarcar: (v: boolean) => void;
}) {
  return (
    <tr className={cn('border-b border-linha/60 last:border-0 transition-colors hover:bg-superficie-2', marcado && 'bg-superficie')}>
      <td className="px-4 py-3">
        <input
          type="checkbox"
          checked={marcado}
          onChange={(e) => aoMarcar(e.target.checked)}
          aria-label={`Selecionar ${i.numeroPrecatorio}`}
          className="h-4 w-4 accent-marca-ciano"
        />
      </td>
      <td className="px-4 py-3">
        <Link href={`/processo/${i.id}`} className="num text-[13px] text-marca-ciano hover:underline">
          {i.numeroPrecatorio}
        </Link>
        <p className="mt-0.5 text-[11px] text-muted">{i.entidadeDevedora ?? '—'}</p>
        {/* O estágio ao lado do número, e não numa coluna própria: a fila é
            varredura, e a pergunta "isto já é exigível?" tem de ser respondida
            no mesmo lance de olho que lê o precatório. */}
        <div className="mt-1">
          <SeloFase fase={i.fase} />
        </div>
        {i.etiquetas.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {i.etiquetas.slice(0, 3).map((e) => (
              <span key={e.id} className="rounded-full border border-linha bg-superficie px-2 py-0.5 text-[10px] text-ink-2">
                {e.nome}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        {i.titular ? (
          <>
            <p className="max-w-[14rem] truncate text-[13px] text-ink-2">{i.titular.nome}</p>
            {/* CPF PARCIAL na lista: o número completo é dado pessoal, e a fila é
                uma tela de varredura — quem precisa dele abre o processo, e esse
                acesso fica na trilha de auditoria. */}
            <p className="num mt-0.5 text-[11px] text-muted">{cpfCurto(i.titular.cpf)}</p>
          </>
        ) : (
          <span className="text-[13px] text-muted">—</span>
        )}
      </td>
      {/* Espelha o cartão do quadro (components/carteira/quadro.tsx): num
          pré-precatório `valor` é NULO e `brl(null)` devolve "—", que se lê como
          dado faltando. O número existe, em `valorIndicativo`, e chega no JSON. */}
      <td className="num px-4 py-3 text-right text-[13px] text-ink-2">
        {i.valor !== null ? brl(i.valor) : <ValorIndicativo valor={i.valorIndicativo} />}
      </td>
      <td className="px-4 py-3">
        <span className={cn('text-[12px] font-medium', ESTAGIO[i.estagio].texto)}>
          {ESTAGIO[i.estagio].singular}
        </span>
        {i.estagioEm && i.estagio !== 'NOVO' && (
          <p className="num mt-0.5 text-[11px] text-muted">há {dias(i.estagioEm)}d</p>
        )}
      </td>
      <td className="px-4 py-3">
        <span className={cn('text-[12px]', COR_PRIORIDADE[i.prioridade])}>
          {rotuloPrioridade(i.prioridade)}
        </span>
        {i.tarefasAtrasadas > 0 && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-erro">
            <AlertTriangle aria-hidden className="h-3 w-3" />
            {i.tarefasAtrasadas} atrasada(s)
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-[13px] text-ink-2">
        {i.responsavel?.nome ?? <span className="text-muted">—</span>}
      </td>
      <td className="px-4 py-3">
        {i.ultimoContatoEm ? (
          <span className="num text-[12px] text-muted">há {dias(i.ultimoContatoEm)}d</span>
        ) : (
          /* O estado que a fila existe para tornar visível. */
          <span className="flex items-center gap-1 text-[12px] text-alerta">
            <PhoneOff aria-hidden className="h-3 w-3" />
            nunca
          </span>
        )}
      </td>
    </tr>
  );
}

