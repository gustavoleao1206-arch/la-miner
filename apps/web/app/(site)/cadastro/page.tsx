import type { Metadata } from 'next';
import Link from 'next/link';

import { CONTATO, buscarPlanosComerciais, planoEscolhido, reais } from '@/lib/plano-comercial';
import { FormularioCadastro } from '@/components/site/formulario-cadastro';

/**
 * A página de assinatura.
 *
 * O plano é buscado NO SERVIDOR e passado pronto ao formulário: assim o preço
 * que a pessoa lê ao preencher é o mesmo que o servidor vai cobrar, lido da
 * mesma fonte no mesmo instante. Deixar o formulário buscar sozinho abriria
 * uma janela — pequena, mas real — em que a tela mostra um valor e a fatura
 * sai com outro.
 *
 * `noindex` aqui, ao contrário da landing: página de formulário não tem
 * conteúdo para buscador, e indexá-la só produziria um resultado concorrendo
 * com a página que deveria receber a visita.
 */
export const metadata: Metadata = {
  title: 'Assinar',
  robots: { index: false, follow: true },
};

export default async function Cadastro({
  searchParams,
}: {
  searchParams: Promise<{ plano?: string }>;
}) {
  /* Mesma fonte da landing: o plano que o visitante viu anunciado é exatamente
     o que o formulário vai enviar. O `?plano=` vem do cartão clicado; id
     desconhecido cai no primeiro do catálogo — nunca num formulário sem preço. */
  const { plano: planoId } = await searchParams;
  const planos = await buscarPlanosComerciais();
  const plano = planoEscolhido(planos, planoId);

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <Link
        href="/"
        className="font-display text-sm font-bold tracking-tight text-ink transition-colors hover:text-marca-ciano"
      >
        LEÃO AMORIM
        <span className="ml-2 font-mono text-[10px] font-medium tracking-[0.3em] text-marca-ciano">
          MINER
        </span>
      </Link>

      {plano ? (
        <>
          <h1 className="mt-10 font-display text-3xl font-bold tracking-tight text-ink">
            Assinar o {plano.nome}
          </h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
            <strong className="font-semibold text-ink">
              {reais(plano.precoCentavos)}
            </strong>{' '}
            por {plano.intervaloMeses === 1 ? 'mês' : `${plano.intervaloMeses} meses`} ·{' '}
            {plano.processosPorCiclo.toLocaleString('pt-BR')} processos por ciclo, acumulativos
            e sem repetição.
          </p>

          {planos.length > 1 && (
            <p className="mt-2 text-[13px] text-muted">
              Prefere {plano.intervaloMeses === 1 ? 'o anual com desconto' : 'pagar mês a mês'}?{' '}
              <Link href="/#plano" className="underline underline-offset-4 hover:text-ink">
                Ver os planos
              </Link>
            </p>
          )}

          <div className="mt-8">
            <FormularioCadastro plano={plano} />
          </div>

          <p className="mt-6 text-center text-[13px] text-muted">
            Já tem conta?{' '}
            <Link href="/login" className="text-marca-ciano hover:underline">
              Entrar
            </Link>
          </p>
        </>
      ) : (
        /* Sem plano publicado não existe o que assinar — e um formulário que
           não sabe o preço não pode cobrar. Melhor um caminho humano que um
           campo quebrado. */
        <>
          <h1 className="mt-10 font-display text-3xl font-bold tracking-tight text-ink">
            Assinatura sob consulta
          </h1>
          <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted text-justify">
            No momento não há plano aberto para contratação online. Fale com a equipe e
            retornamos com as condições vigentes.
          </p>
          <a
            href={`mailto:${CONTATO}?subject=${encodeURIComponent('Quero assinar o Leão Amorim Miner')}`}
            className="mt-8 inline-flex rounded-sm bg-marca px-6 py-3.5 font-semibold text-white shadow-brilho"
          >
            Falar com a equipe
          </a>
        </>
      )}
    </main>
  );
}
