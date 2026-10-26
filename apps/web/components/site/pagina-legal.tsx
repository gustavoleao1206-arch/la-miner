import Link from 'next/link';

import { EMPRESA, VIGENTE_DESDE } from '@/lib/dados-empresa';

/**
 * A moldura compartilhada dos documentos legais.
 *
 * Existe para que Termos e Política tenham a MESMA cara e o mesmo rodapé de
 * vigência: dois documentos que se contradizem na forma passam a impressão de
 * que também se contradizem no conteúdo — e quem lê estas páginas é advogado.
 */
export function PaginaLegal({
  titulo,
  resumo,
  children,
}: {
  titulo: string;
  resumo: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <Link
        href="/"
        className="font-display text-sm font-bold tracking-tight text-ink transition-colors hover:text-marca-ciano"
      >
        LEÃO AMORIM
        <span className="ml-2 font-mono text-[10px] font-medium tracking-[0.3em] text-marca-ciano">
          MINER
        </span>
      </Link>

      <h1 className="mt-10 font-display text-3xl font-bold tracking-tight text-ink">{titulo}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">{resumo}</p>
      <p className="mt-2 text-[13px] text-muted-2">Vigente desde {VIGENTE_DESDE}.</p>

      <div className="legal mt-10">{children}</div>

      <footer className="mt-14 border-t border-linha/60 pt-8 text-[13px] leading-relaxed text-muted-2 text-justify">
        <p>
          {EMPRESA.razaoSocial} · CNPJ {EMPRESA.cnpj}
          <br />
          {EMPRESA.endereco}
          <br />
          <a href={`mailto:${EMPRESA.email}`} className="hover:text-marca-ciano">
            {EMPRESA.email}
          </a>
        </p>
        <p className="mt-4 flex gap-4">
          <Link href="/termos" className="hover:text-marca-ciano">
            Termos de Uso
          </Link>
          <Link href="/privacidade" className="hover:text-marca-ciano">
            Política de Privacidade
          </Link>
          <Link href="/" className="hover:text-marca-ciano">
            Início
          </Link>
        </p>
      </footer>
    </main>
  );
}

/** Uma seção numerada. O número é do conteúdo, não do CSS: ele é CITÁVEL. */
export function Secao({
  n,
  titulo,
  children,
}: {
  n: number;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <h2 className="font-display text-[17px] font-semibold text-ink">
        {n}. {titulo}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-ink-2 text-justify">{children}</div>
    </section>
  );
}
