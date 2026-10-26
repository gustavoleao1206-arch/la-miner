'use client';

import Link from 'next/link';
import { AlertTriangle, UserRound } from 'lucide-react';

import type { ItemFila, TribunalCatalogo } from '@/lib/api';
import { cn } from '@/lib/utils';
import { SeloFase, ValorIndicativo } from '@/components/fase-processo';
import { ESTAGIO } from '@/components/carteira/estagios';
import { ESFERA, tribunalDoCatalogo } from './vocabulario';

/**
 * A LINHA DO PRÉ-PRECATÓRIO — com hierarquia, e não uma fileira de células.
 *
 * ── O QUE MUDOU EM RELAÇÃO À TABELA ──
 *
 * A tabela dava o mesmo peso a tudo: número, tribunal, nome e valor na mesma
 * fonte, no mesmo cinza. Aqui cada coluna tem UM elemento principal e o resto
 * é apoio: o número (mono, tinta cheia) com o tribunal ao lado e o ente devedor
 * embaixo, mais claro; o titular em peso médio; o selo do estágio; o estado do
 * CRM discreto; e o valor grande à direita — é a chave de ordenação da lista, e
 * o olho desce por ele.
 *
 * (Até 20/09/2026 o veredito do CPF vinha colado ao nome. Saiu de todas as
 * telas e da própria resposta da API — ver a lápide em `fase-processo.tsx`.)
 *
 * A linha inteira é o link: o operador clica onde estiver, e não caça o número.
 *
 * ── A GRADE ──
 *
 * Uma constante só, partilhada com o cabeçalho, para os rótulos ficarem em cima
 * das colunas certas em qualquer largura. Abaixo de `lg` a linha empilha em
 * cartão — melhor do que uma tabela que rola de lado.
 */
export const GRADE =
  'lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1.3fr)_10.5rem_minmax(0,1fr)_9rem]';

export function CabecalhoDaLista() {
  return (
    <div className={cn('hidden gap-4 border-b border-linha px-5 py-2.5 lg:grid', GRADE)} aria-hidden>
      <span className="rotulo">Processo</span>
      <span className="rotulo">Titular</span>
      <span className="rotulo">Estágio</span>
      <span className="rotulo">CRM</span>
      <span className="rotulo text-right">Valor estimado</span>
    </div>
  );
}

export function LinhaPrePrecatorio({
  item: i,
  catalogo,
}: {
  item: ItemFila;
  catalogo: TribunalCatalogo[];
}) {
  const t = tribunalDoCatalogo(catalogo, i.tribunal);
  const esfera = t?.esfera ? ESFERA[t.esfera] : undefined;
  const estagio = ESTAGIO[i.estagio];

  return (
    <li className="border-b border-linha/60 last:border-0">
      <Link
        href={`/processo/${i.id}`}
        className={cn(
          'group grid grid-cols-1 gap-1.5 px-5 py-3.5 transition-colors hover:bg-superficie/70 lg:items-center lg:gap-4',
          GRADE,
        )}
      >
        {/* ── Processo: número, tribunal, ente devedor ── */}
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className="num truncate text-[13px] font-medium text-ink transition-colors group-hover:text-marca-ciano">
              {i.numeroPrecatorio}
            </span>
            {/* Com dezenas de tribunais, de qual é o processo muda a abordagem. O ponto
                colorido é a esfera; o nome inteiro está no `title`. */}
            <span
              title={t ? `${t.nome}${esfera ? ` · ${esfera.rotulo}` : ''}` : undefined}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-linha bg-superficie px-1.5 py-0.5 text-[11px] font-medium text-ink-2"
            >
              {esfera && <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', esfera.ponto)} />}
              {i.tribunal}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted">
            {i.entidadeDevedora ?? 'Ente devedor não informado'}
          </p>
        </div>

        {/* ── Titular ── */}
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink-2">
            {i.titular?.nome ?? <span className="font-normal text-muted-2">Sem titular vinculado</span>}
          </p>
        </div>

        {/* ── Estágio do crédito ── */}
        <div>
          <SeloFase fase={i.fase} />
        </div>

        {/* ── CRM: onde o processo está no funil DESTA organização ── */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted">
          <span className={cn('font-medium', estagio?.texto)}>{estagio?.singular ?? i.estagio}</span>
          {i.responsavel && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <UserRound aria-hidden className="h-3 w-3 shrink-0" />
              <span className="truncate">{i.responsavel.nome}</span>
            </span>
          )}
          {i.tarefasAtrasadas > 0 && (
            <span className="inline-flex items-center gap-1 text-erro">
              <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
              {i.tarefasAtrasadas} {i.tarefasAtrasadas === 1 ? 'tarefa atrasada' : 'tarefas atrasadas'}
            </span>
          )}
        </div>

        {/* ── Valor: compacto para escanear, inteiro no hover ── */}
        <div className="lg:text-right">
          {i.valorIndicativo !== null ? (
            <ValorIndicativo
              compacto
              valor={i.valorIndicativo}
              className="num text-[15px] font-semibold text-ink"
            />
          ) : (
            <span className="text-[12px] text-muted-2">sem valor no texto</span>
          )}
        </div>
      </Link>
    </li>
  );
}
