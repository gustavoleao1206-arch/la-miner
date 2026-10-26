/**
 * PROVA SOCIAL — a câmara preparada, deliberadamente vazia.
 *
 * Os componentes existem para o dia em que houver métricas, depoimentos e
 * cases REAIS; até lá a seção NEM RENDERIZA. A alternativa — publicar com
 * "+X clientes satisfeitos" inventado — é o tipo de número que o comprador
 * deste produto (advogado) é profissionalmente treinado para cobrar em juízo.
 *
 * Para ligar: preencher os dados abaixo com fatos verificáveis e virar a
 * flag. Nada além disso — o layout já está pronto e no tema.
 */
const EXIBIR = false;

const METRICAS: { valor: string; rotulo: string }[] = [
  /* ex.: { valor: '12.400+', rotulo: 'precatórios na base' } — só com número real e datado */
];

const DEPOIMENTOS: { frase: string; autor: string; cargo: string }[] = [
  /* ex.: { frase: '…', autor: 'Nome', cargo: 'Sócio, Escritório X' } — só com autorização escrita */
];

export function ProvaSocial() {
  if (!EXIBIR || (METRICAS.length === 0 && DEPOIMENTOS.length === 0)) return null;

  return (
    <section id="prova" className="mx-auto max-w-6xl scroll-mt-8 px-6 py-20">
      <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--sonda)' }}>
        RESULTADOS
      </p>
      {METRICAS.length > 0 && (
        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {METRICAS.map((m) => (
            <div
              key={m.rotulo}
              className="rounded-lg border p-6"
              style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}
            >
              <p className="font-mono text-3xl font-semibold tabular-nums" style={{ color: 'var(--veio)' }}>
                {m.valor}
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--bruma)' }}>
                {m.rotulo}
              </p>
            </div>
          ))}
        </div>
      )}
      {DEPOIMENTOS.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {DEPOIMENTOS.map((d) => (
            <figure
              key={d.autor}
              className="rounded-lg border p-6"
              style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}
            >
              <blockquote className="text-[15px] leading-relaxed" style={{ color: 'var(--texto-j)' }}>
                “{d.frase}”
              </blockquote>
              <figcaption className="mt-3 text-sm" style={{ color: 'var(--bruma)' }}>
                <strong style={{ color: 'var(--texto-j)' }}>{d.autor}</strong> · {d.cargo}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
