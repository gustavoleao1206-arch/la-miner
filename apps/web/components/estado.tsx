'use client';

import { AlertTriangle, Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Carregando, erro e vazio são estados DISTINTOS.
 *
 * O modo de falha que isto elimina: quando "sem dados ainda" e "a requisição
 * falhou" compartilham a mesma representação, a tela anuncia problema de
 * infraestrutura em todo carregamento e, pior, esconde falhas reais de endpoint
 * atrás de uma mensagem de lista vazia — indistinguíveis, para sempre.
 */
export type Estado<T> =
  | { st: 'carregando' }
  | { st: 'erro'; msg: string }
  | { st: 'ok'; dados: T };

export const CARREGANDO = { st: 'carregando' } as const;

/** Converte um resultado de Promise.allSettled preservando a mensagem de erro. */
export function comoEstado<T>(r: PromiseSettledResult<T>): Estado<T> {
  return r.status === 'fulfilled'
    ? { st: 'ok', dados: r.value }
    : { st: 'erro', msg: r.reason?.message ?? 'Falha ao carregar' };
}

/** Bloco que falhou — visualmente distinto de bloco vazio. */
export function BlocoErro({ msg, className }: { msg: string; className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 text-[12px] text-alerta', className)} role="status">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{msg}</span>
    </p>
  );
}

/** Vazio legítimo: a requisição funcionou e não há o que mostrar. */
export function Vazio({
  titulo,
  descricao,
  Icone = Inbox,
  acao,
  className,
}: {
  titulo: string;
  descricao?: string;
  Icone?: React.ComponentType<{ className?: string }>;
  acao?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-[13px] border border-linha bg-superficie">
        <Icone className="h-5 w-5 text-muted" />
      </span>
      <p className="font-display text-sm font-medium text-ink-2">{titulo}</p>
      {descricao && <p className="mt-1.5 max-w-xs text-[12px] leading-relaxed text-muted">{descricao}</p>}
      {acao && <div className="mt-5">{acao}</div>}
    </div>
  );
}
