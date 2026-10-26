import Link from 'next/link';

import { CONTATO, buscarPlanosComerciais, descontoSobreMensal, reais } from '@/lib/plano-comercial';
import { SimboloLLA } from '@/components/logo';
import { Jazida } from '@/components/site/jazida';
import { MedidorProfundidade } from '@/components/site/medidor-profundidade';
import { Revelar } from '@/components/site/revelar';
import { Descida } from '@/components/site/descida';
import { TelasDoMiner } from '@/components/site/telas-do-miner';
import { ProvaSocial } from '@/components/site/prova-social';

/**
 * A JAZIDA DIGITAL — a landing comercial como uma descida.
 *
 * Direção de arte aprovada em 20/08/2026: fundo-abismo, varredura ciano,
 * achado no azul da marca (ajuste do dono sobre a proposta original em ouro);
 * a página desce como um poço de prospecção e o fluxo do
 * produto são os estratos. Os tokens vivem em `.tema-jazida` (globals.css) e
 * NÃO tocam o painel.
 *
 * ── O QUE NÃO MUDOU, DE PROPÓSITO ──
 *
 * Componente de SERVIDOR: o preço e a manchete chegam no HTML, como antes —
 * página de vendas que só mostra preço depois do JavaScript pisca um esqueleto
 * para o buscador e para quem chega de 4G. As peças vivas (jazida, descida,
 * telas) hidratam por cima e nenhuma delas é o LCP.
 *
 * ── NENHUM NÚMERO INVENTADO ──
 *
 * Continua valendo: a página afirma o que o produto ENTREGA e nada além. A
 * prova social existe como componente desligado (prova-social.tsx) até haver
 * dado real. Alegação de quantidade é o terreno do art. 37, §1º do CDC — e o
 * comprador é advogado.
 */

const BENEFICIOS = [
  {
    titulo: 'Velocidade',
    ancora: 'o que chega, chega pronto',
    texto:
      'Sem semanas de diário oficial e conferência manual: o titular já vem identificado e o contato conferido. Você começa a conversa, não a procura.',
  },
  {
    titulo: 'Organização',
    ancora: 'CRM incluído',
    texto:
      'Funil, propostas, parcelamento e tarefas na mesma tela do lead. A prospecção inteira sem exportar uma planilha.',
  },
  {
    titulo: 'Inteligência',
    ancora: 'calculadora oficial do CNJ',
    texto:
      'O saldo do precatório atualizado pela calculadora oficial, dentro do módulo de negociação, e cada valor rastreável até o processo de origem.',
  },
  {
    titulo: 'Conformidade',
    ancora: 'trilha auditável',
    texto:
      'Toda consulta registrada com data e autor. Quando a LGPD bater à porta, a resposta é um relatório, não uma reunião de emergência.',
  },
];

const COMPARACAO: [string, string, string][] = [
  ['A fonte', 'Diários e listas soltas, conferidos à mão', 'Extração direta do tribunal, rastreável ao processo'],
  ['O titular', 'Descoberto caso a caso, no braço', 'Identificado antes de chegar a você'],
  ['O contato', 'Caçado em redes e cadastros avulsos', 'Conferido e datado junto a provedores cadastrais'],
  ['O mês de trabalho', 'Semanas de estagiário por lote', '250 prontos todo mês, acumulando 250 → 500 → 750'],
  ['A gestão', 'Planilha paralela que envelhece no dia seguinte', 'CRM incluído, na mesma tela do lead'],
];

const DUVIDAS = [
  [
    'De onde vêm os precatórios?',
    'Dos próprios tribunais: listas de dívida consolidada e dos autos no PJe. Nada de base ' +
      'comprada de terceiro, e é por isso que conseguimos manter o vínculo entre o valor e o processo.',
  ],
  [
    'Os mesmos processos são vendidos para vários escritórios?',
    'Um precatório entregue a você não é entregue de novo a você. Não trabalhamos com ' +
      'exclusividade de mercado, e preferimos dizer isso na página a deixar você descobrir depois.',
  ],
  [
    'O que acontece se eu não der conta de 250 num mês?',
    'Nada se perde. O saldo acumula: no segundo mês você tem 500 disponíveis, no terceiro 750.',
  ],
  [
    'Quais tribunais estão cobertos hoje?',
    'Os precatórios já expedidos vêm do TRF1 e do TRF5, exercício 2027. Os pré-precatórios ' +
      'alcançam 42 tribunais — federais, estaduais e trabalhistas —, e novos entram a cada ' +
      'importação.',
  ],
  [
    'O que é um pré-precatório?',
    'É o mesmo crédito, um estágio antes: já ganhou e não cabe mais recurso, mas o precatório ' +
      'ainda não foi expedido. Chega junto dos demais, sempre com o estágio dito na tela — e ' +
      'muitas vezes vale mais, porque o credor ainda não foi procurado por ninguém. O valor ' +
      'desses é indicativo, extraído do texto da publicação, e a tela avisa isso.',
  ],
  [
    'Como é feito o pagamento?',
    'Mensal ou anual: o anual com 20% de desconto. A cobrança sai por gateway, com PIX, ' +
      'boleto ou cartão, e o acesso é liberado assim que o pagamento confirma.',
  ],
];

export default async function Landing() {
  const planos = await buscarPlanosComerciais();

  return (
    <main className="tema-jazida relative overflow-hidden font-body">
      <MedidorProfundidade />

      {/* ── Cabeçalho ── */}
      <header className="relative z-20 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        {/* O SÍMBOLO, e não só o nome composto.
            A landing exibia apenas texto: quem chegava pela busca não via marca
            nenhuma — nem aqui, nem na aba do navegador. É o mesmo arquivo que o
            painel usa (com alpha, sem fundo), então assenta sobre o fundo-abismo
            sem moldura. A aura vem do CSS na cor da sonda, para o símbolo
            pertencer à direção de arte da jazida em vez de parecer colado. */}
        <span className="flex items-center gap-3">
          <SimboloLLA className="h-9 shrink-0 drop-shadow-[0_0_14px_rgba(38,213,238,0.45)]" />
          <span className="font-display text-sm font-bold tracking-tight">
            LEÃO AMORIM
            <span className="ml-2 font-mono text-[10px] font-medium tracking-[0.3em]" style={{ color: 'var(--sonda)' }}>
              MINER
            </span>
          </span>
        </span>
        <nav className="flex items-center gap-6 text-sm">
          <a href="#descida" className="hidden transition-colors sm:inline" style={{ color: 'var(--bruma)' }}>
            Como funciona
          </a>
          <a href="#demonstracao" className="hidden transition-colors sm:inline" style={{ color: 'var(--bruma)' }}>
            Demonstração
          </a>
          <a href="#plano" className="transition-colors" style={{ color: 'var(--bruma)' }}>
            Plano
          </a>
          <Link
            href="/login"
            className="rounded-sm border px-4 py-2 font-medium transition-colors"
            style={{ borderColor: 'var(--linha-j)', color: 'var(--texto-j)' }}
          >
            Entrar
          </Link>
        </nav>
      </header>

      {/* ── 0 m: o herói. A jazida ao fundo; a manchete é HTML de servidor. ── */}
      <section className="relative">
        <Jazida
          pontos={900}
          centroX={0.72}
          className="pointer-events-none absolute inset-0 -z-0 h-full w-full"
        />
        <div className="relative z-10 mx-auto max-w-6xl px-6 pb-24 pt-14 sm:pb-32 sm:pt-24">
          <p className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.25em]" style={{ color: 'var(--bruma)' }}>
            <span aria-hidden className="inline-block h-px w-7" style={{ background: 'var(--veio)' }} />
            Mineração de precatórios e pré-precatórios
          </p>
          <h1 className="mt-6 max-w-4xl font-display text-4xl font-bold leading-[1.08] tracking-tight sm:text-6xl">
            Há <span style={{ color: 'var(--veio)' }}>valor</span> enterrado
            <br />
            em milhões de linhas
            <br />
            de dados públicos.
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed" style={{ color: 'var(--bruma)' }}>
            Todo mês, 250 créditos com o titular identificado e o contato conferido —
            precatórios expedidos e pré-precatórios —, extraídos direto da fonte de tribunais
            federais, estaduais e trabalhistas, prontos para a sua prospecção.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <a
              href="#plano"
              className="inline-flex items-center justify-center rounded-sm px-7 py-3.5 font-semibold text-white transition-transform hover:scale-[1.02]"
              style={{ background: 'var(--veio)' }}
            >
              Começar a minerar
            </a>
            <a
              href="#demonstracao"
              className="inline-flex items-center justify-center rounded-sm border px-7 py-3.5 font-medium transition-colors"
              style={{ borderColor: 'var(--linha-j)', color: 'var(--texto-j)' }}
            >
              Ver o Miner em ação
            </a>
          </div>
          <p className="mt-8 font-mono text-[11px] tracking-[0.16em]" style={{ color: 'var(--bruma-2)' }}>
            TRF1 · TRF5 · EXERCÍCIO 2027 · VARREDURA ATIVA
          </p>
        </div>
      </section>

      {/* ── −120 m: o problema. Respiro editorial, sem cartão. ── */}
      <section id="problema" className="border-t" style={{ borderColor: 'var(--linha-j)' }}>
        <div className="mx-auto max-w-3xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--sonda)' }}>
              −120 m · O PROBLEMA
            </p>
            <p className="mt-6 font-display text-2xl font-medium leading-snug sm:text-3xl">
              O garimpo manual custa o mês inteiro: diário oficial, planilha, conferência um a um.
              <em className="font-normal italic" style={{ color: 'var(--bruma)' }}>
                {' '}
                E quando o contato finalmente aparece, outro escritório chegou primeiro.
              </em>
            </p>
            <p className="mt-6 max-w-2xl text-[15px] leading-relaxed" style={{ color: 'var(--bruma)' }}>
              O que trava a prospecção de precatório nunca foi achar o processo. Foi descobrir de
              quem ele é, quanto vale para essa pessoa e como falar com ela. Essa é a parte que o
              Miner entrega pronta.
            </p>
          </Revelar>
        </div>
      </section>

      {/* ── −300 m a −600 m: a descida — o fluxo do produto em estratos. ── */}
      <section id="descida" className="scroll-mt-8 border-t" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}>
        <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--sonda)' }}>
              A DESCIDA
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Do dado bruto ao veio
            </h2>
            <p className="mt-4 max-w-2xl text-[15px]" style={{ color: 'var(--bruma)' }}>
              Seis estratos entre a superfície e a sua carteira. Role e desça.
            </p>
          </Revelar>
          <Descida />
        </div>
      </section>

      {/* ── −560 m: o veio — as telas do produto. ── */}
      <section id="demonstracao" className="scroll-mt-8 border-t" style={{ borderColor: 'var(--linha-j)' }}>
        <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--veio)' }}>
              −560 m · O VEIO
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Veja o Miner em ação
            </h2>
            <p className="mt-4 max-w-2xl text-[15px]" style={{ color: 'var(--bruma)' }}>
              A apresentação em vídeo foi gravada do sistema real, com os dados pessoais
              ocultados; as demais abas desenham as telas em código, com dados fictícios.
              Você entende o que compra antes de falar com qualquer pessoa.
            </p>
          </Revelar>
          <Revelar atraso={0.1} className="mt-10">
            <TelasDoMiner />
          </Revelar>
        </div>
      </section>

      {/* ── −700 m: benefícios ancorados em função que existe. ── */}
      <section id="beneficios" className="border-t" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}>
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--sonda)' }}>
              −700 m · O QUE VOCÊ GANHA
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Cada benefício tem um mecanismo por trás
            </h2>
          </Revelar>
          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {BENEFICIOS.map((b, i) => (
              <Revelar key={b.titulo} atraso={i * 0.06}>
                <div
                  className="h-full rounded-lg border p-7"
                  style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}
                >
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--veio)' }}>
                    {b.ancora}
                  </p>
                  <h3 className="mt-2 font-display text-xl font-semibold">{b.titulo}</h3>
                  <p className="mt-3 text-[15px] leading-relaxed" style={{ color: 'var(--bruma)' }}>
                    {b.texto}
                  </p>
                </div>
              </Revelar>
            ))}
          </div>
        </div>
      </section>

      {/* ── −820 m: garimpo manual × Miner. Só afirmações verificáveis. ── */}
      <section id="comparacao" className="border-t" style={{ borderColor: 'var(--linha-j)' }}>
        <div className="mx-auto max-w-4xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--sonda)' }}>
              −820 m · A COMPARAÇÃO
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Garimpo manual × Miner
            </h2>
          </Revelar>
          <Revelar atraso={0.08}>
            <div className="mt-10 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-[14.5px]">
                <thead>
                  <tr>
                    <th className="w-[26%] py-3 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--bruma-2)' }} />
                    <th className="py-3 pr-4 text-left font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--bruma-2)' }}>
                      Garimpo manual
                    </th>
                    <th className="py-3 text-left font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: 'var(--veio)' }}>
                      Com o Miner
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARACAO.map(([tema, manual, miner]) => (
                    <tr key={tema} className="border-t" style={{ borderColor: 'var(--linha-j)' }}>
                      <td className="py-4 pr-4 font-medium">{tema}</td>
                      <td className="py-4 pr-4" style={{ color: 'var(--bruma-2)' }}>
                        {manual}
                      </td>
                      <td className="py-4" style={{ color: 'var(--bruma)' }}>
                        {miner}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Revelar>
        </div>
      </section>

      {/* ── −900 m: prova social — desligada até haver dado real. ── */}
      <ProvaSocial />

      {/* ── −1.000 m: o fundo — planos. ── */}
      <section id="plano" className="scroll-mt-8 border-t" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}>
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-24">
          <Revelar>
            <p className="font-mono text-[11px] tracking-[0.25em]" style={{ color: 'var(--veio)' }}>
              −1.000 m · O FUNDO DO POÇO
            </p>
            <h2 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              {planos.length > 1 ? 'Escolha como descer' : 'O plano'}
            </h2>
            <p className="mt-4 max-w-xl text-[15px]" style={{ color: 'var(--bruma)' }}>
              Sem degrau e sem taxa de implantação.
              {planos.length > 1
                ? ' Mensal sem fidelidade, ou um ano garantido com desconto, pago de uma vez.'
                : ' Sem fidelidade.'}
            </p>
          </Revelar>

          {planos.length === 0 ? (
            <Revelar>
              <div className="mt-10 max-w-md rounded-lg border p-8" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}>
                <h3 className="font-display text-lg font-semibold">Plano sob consulta</h3>
                <p className="mt-3 text-[15px] leading-relaxed" style={{ color: 'var(--bruma)' }}>
                  Fale com a equipe e receba as condições por e-mail.
                </p>
                <a
                  href={`mailto:${CONTATO}?subject=${encodeURIComponent('Interesse no Leão Amorim Miner')}`}
                  className="mt-8 flex w-full items-center justify-center rounded-sm border px-6 py-3.5 font-semibold"
                  style={{ borderColor: 'var(--linha-j)' }}
                >
                  Falar com a equipe
                </a>
              </div>
            </Revelar>
          ) : (
            <div className={planos.length > 1 ? 'mt-10 grid max-w-4xl gap-6 sm:grid-cols-2' : 'mt-10 grid max-w-md gap-6'}>
              {planos.map((p, i) => {
                const desconto = descontoSobreMensal(planos, p);
                const anual = p.intervaloMeses > 1;
                return (
                  <Revelar key={p.id} atraso={i * 0.08}>
                    <div
                      className="relative h-full rounded-lg border p-8"
                      style={{
                        borderColor: anual ? 'rgba(79,124,255,.45)' : 'var(--linha-j)',
                        background: 'var(--estrato-2)',
                        boxShadow: anual ? '0 0 40px rgba(79,124,255,.07)' : 'none',
                      }}
                    >
                      {desconto !== null && (
                        <span
                          className="absolute -top-3 right-6 rounded-full px-3 py-1 text-[12px] font-semibold"
                          style={{ background: 'var(--veio)', color: '#fff' }}
                        >
                          {desconto}% de desconto
                        </span>
                      )}
                      <h3 className="font-display text-lg font-semibold">{p.nome}</h3>
                      {p.descricao && (
                        <p className="mt-1.5 text-[15px]" style={{ color: 'var(--bruma)' }}>
                          {p.descricao}
                        </p>
                      )}
                      <p className="mt-7 flex items-baseline gap-2">
                        <span className="font-display text-5xl font-bold tracking-tight">
                          {reais(p.precoCentavos)}
                        </span>
                        <span style={{ color: 'var(--bruma)' }}>
                          /{p.intervaloMeses === 1 ? 'mês' : `${p.intervaloMeses} meses`}
                        </span>
                      </p>
                      {anual && (
                        <p className="mt-1 text-[13px]" style={{ color: 'var(--bruma)' }}>
                          equivale a {reais(Math.round(p.precoCentavos / p.intervaloMeses))}/mês, pago de uma vez
                        </p>
                      )}
                      <p className="mt-4 text-[15px]" style={{ color: 'var(--bruma)' }}>
                        <strong className="font-semibold" style={{ color: 'var(--texto-j)' }}>
                          {p.processosPorCiclo.toLocaleString('pt-BR')} créditos
                        </strong>{' '}
                        novos <strong className="font-semibold" style={{ color: 'var(--texto-j)' }}>todo mês</strong>,
                        acumulativos e sem repetição{anual ? ', com o ano inteiro garantido' : ''}.
                      </p>
                      <Link
                        href={`/cadastro?plano=${p.id}`}
                        className="mt-8 flex w-full items-center justify-center rounded-sm px-6 py-3.5 font-semibold transition-transform hover:scale-[1.01]"
                        style={
                          anual
                            ? { background: 'var(--veio)', color: '#fff' }
                            : { border: '1px solid var(--linha-j)', color: 'var(--texto-j)' }
                        }
                      >
                        Assinar o {p.nome}
                      </Link>
                    </div>
                  </Revelar>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ── Dúvidas: <details> nativo, sem uma linha de JavaScript ── */}
      <section id="duvidas" className="mx-auto max-w-3xl scroll-mt-8 border-t px-6 py-20" style={{ borderColor: 'var(--linha-j)' }}>
        <Revelar>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Dúvidas</h2>
        </Revelar>
        <div className="mt-8 divide-y border-y" style={{ borderColor: 'var(--linha-j)' }}>
          {DUVIDAS.map(([pergunta, resposta]) => (
            <details key={pergunta} className="group py-5" style={{ borderColor: 'var(--linha-j)' }}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-display text-[15px] font-medium marker:content-none">
                {pergunta}
                <span aria-hidden className="shrink-0 transition-transform group-open:rotate-45" style={{ color: 'var(--bruma)' }}>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed" style={{ color: 'var(--bruma)' }}>
                {resposta}
              </p>
            </details>
          ))}
        </div>
      </section>

      {/* ── CTA final ── */}
      <section className="border-t" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)' }}>
        <div className="mx-auto max-w-6xl px-6 py-20 text-center sm:py-24">
          <Revelar>
            <h2 className="mx-auto max-w-2xl font-display text-3xl font-bold tracking-tight sm:text-5xl">
              O valor está aí.
              <br />
              <span style={{ color: 'var(--veio)' }}>Comece a minerar.</span>
            </h2>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a
                href="#plano"
                className="inline-flex items-center justify-center rounded-sm px-7 py-3.5 font-semibold text-white transition-transform hover:scale-[1.02]"
                style={{ background: 'var(--veio)' }}
              >
                Ver o plano
              </a>
              <a
                href={`mailto:${CONTATO}?subject=${encodeURIComponent('Interesse no Leão Amorim Miner')}`}
                className="inline-flex items-center justify-center rounded-sm border px-7 py-3.5 font-medium"
                style={{ borderColor: 'var(--linha-j)', color: 'var(--texto-j)' }}
              >
                Falar com a equipe
              </a>
            </div>
          </Revelar>
        </div>
      </section>

      {/* ── Rodapé ── */}
      <footer className="border-t" style={{ borderColor: 'var(--linha-j)' }}>
        <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 sm:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-3">
              <SimboloLLA className="h-8 shrink-0" />
              <p className="font-display text-sm font-bold tracking-tight">
                LEÃO AMORIM
                <span className="ml-2 font-mono text-[10px] font-medium tracking-[0.3em]" style={{ color: 'var(--sonda)' }}>
                  MINER
                </span>
              </p>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed" style={{ color: 'var(--bruma)' }}>
              Mineração de precatórios e pré-precatórios: o titular identificado, o contato
              conferido e o CRM na mesma tela.
            </p>
            {/* O parentesco declarado onde parentesco se declara: no rodapé. */}
            <a
              href="https://leaoamorimtecnologia.com.br"
              rel="noopener"
              className="mt-4 inline-block text-sm transition-colors"
              style={{ color: 'var(--bruma-2)' }}
            >
              Um produto <span style={{ color: 'var(--bruma)' }}>Leão Amorim Tecnologia</span> ↗
            </a>
          </div>
          <div className="text-sm">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
              Produto
            </p>
            <div className="mt-3 grid gap-2">
              <a href="#demonstracao" style={{ color: 'var(--bruma)' }}>Demonstração</a>
              <a href="#plano" style={{ color: 'var(--bruma)' }}>Plano</a>
              <Link href="/login" style={{ color: 'var(--bruma)' }}>Entrar</Link>
            </div>
          </div>
          <div className="text-sm">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
              Legal e contato
            </p>
            <div className="mt-3 grid gap-2">
              <Link href="/termos" style={{ color: 'var(--bruma)' }}>Termos de Uso</Link>
              <Link href="/privacidade" style={{ color: 'var(--bruma)' }}>Política de Privacidade</Link>
              <a href={`mailto:${CONTATO}`} style={{ color: 'var(--bruma)' }}>{CONTATO}</a>
            </div>
          </div>
        </div>
        <div className="border-t" style={{ borderColor: 'var(--linha-j)' }}>
          <p className="mx-auto max-w-6xl px-6 py-6 font-mono text-[11px]" style={{ color: 'var(--bruma-2)' }}>
            © {new Date().getFullYear()} Leão Amorim Tecnologia LTDA · CNPJ 68.064.461/0001-61 · Maceió/AL
          </p>
        </div>
      </footer>
    </main>
  );
}
