'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

/**
 * A paginação de uma lista: "1–50 de 3.204", com anterior e próxima.
 *
 * Saiu da fila de trabalho (`carteira/page.tsx`) quando o módulo de
 * pré-precatórios precisou da mesma coisa. Uma cópia por tela é como "1–25 de
 * 100" numa e "página 1 de 4" na outra passam a conviver no mesmo painel.
 *
 * Não depende do tipo da página inteira: qualquer resposta paginada da API tem
 * estes quatro números.
 */
export function Paginacao({
  pagina,
  aoIr,
}: {
  pagina: { total: number; pagina: number; porPagina: number; totalPaginas: number };
  aoIr: (p: number) => void;
}) {
  const inicio = pagina.total === 0 ? 0 : (pagina.pagina - 1) * pagina.porPagina + 1;
  const fim = Math.min(pagina.total, pagina.pagina * pagina.porPagina);

  const botao =
    'flex h-9 w-9 items-center justify-center rounded-[11px] border border-linha text-muted transition-colors hover:border-linha-2 hover:text-ink-2 disabled:opacity-40 disabled:hover:border-linha';

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-linha px-5 py-3.5">
      <p className="num text-[12px] text-muted">
        {inicio.toLocaleString('pt-BR')}–{fim.toLocaleString('pt-BR')} de{' '}
        {pagina.total.toLocaleString('pt-BR')}
      </p>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className={botao}
          disabled={pagina.pagina <= 1}
          onClick={() => aoIr(pagina.pagina - 1)}
          aria-label="Página anterior"
        >
          <ChevronLeft aria-hidden className="h-4 w-4" />
        </button>
        <span className="num text-[12px] text-muted">
          {pagina.pagina} / {pagina.totalPaginas}
        </span>
        <button
          type="button"
          className={botao}
          disabled={pagina.pagina >= pagina.totalPaginas}
          onClick={() => aoIr(pagina.pagina + 1)}
          aria-label="Próxima página"
        >
          <ChevronRight aria-hidden className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
