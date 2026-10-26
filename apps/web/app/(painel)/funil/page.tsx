'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, PhoneOff, Target, TrendingDown } from 'lucide-react';
import {
  crm,
  type Funil,
  type PerdaEscrita,
  type Safra,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLote } from '@/lib/lote';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';
import { CartaoKpi, Esqueleto } from '@/components/metricas';
import { Quadro } from '@/components/carteira/quadro';
import { ESTAGIO, ORDEM_ESTAGIOS, rotuloDeMovimento } from '@/components/carteira/estagios';

/**
 * A TELA DO SÓCIO — o funil para quem decide, não para quem opera.
 *
 * A fila responde "o que eu trabalho agora". Esta responde outra pergunta, que
 * hoje não tem resposta em lugar nenhum do sistema: DOS 250 QUE ENTRARAM EM
 * MARÇO, QUANTOS VIRARAM DINHEIRO.
 *
 * ── O NÚMERO QUE ESTA TELA SE RECUSA A MOSTRAR ──
 *
 * "Taxa de conversão da carteira" (fechados ÷ carteira toda). Entram 250 por
 * mês e os fechados se acumulam para sempre: esse número CAI todo mês por
 * construção, sem ninguém ter trabalhado pior. Mostrá-lo a um cliente seria
 * entregar o melhor argumento de cancelamento que ele poderia ter. Conversão só
 * existe por SAFRA, e sempre escrita como "18 de 168" — nunca como percentual
 * solto, que esconde o tamanho da amostra.
 *
 * ── E O QUE ELA NÃO MOSTRA EM REAIS ──
 *
 * Nada. `Processo.valor` é o valor de face do precatório — o que o ente público
 * deve ao titular, não o que o escritório ganha. Somar isso por estágio daria
 * "R$ 42 milhões em negociação" numa reunião, e viraria decisão de contratar
 * gente. O dinheiro do negócio entra quando a aba de Negociação existir.
 */
/**
 * O invólucro existe pelo `useSearchParams` no miolo — mesma fronteira de
 * Suspense da carteira, pelo mesmo motivo de compilação. O parâmetro dá às
 * duas vistas um endereço: /funil abre no quadro (o padrão pedido pelo dono) e
 * /funil?vista=metricas abre direto na tela do sócio — que é também como a
 * suíte de testes dela chega lá sem depender de clique.
 */
export default function FunilPage() {
  return (
    <Suspense fallback={null}>
      <FunilMiolo />
    </Suspense>
  );
}

function FunilMiolo() {
  const { lote, carregando } = useLote();
  /**
   * O QUADRO É A VISTA PADRÃO desde 21/08/2026, a pedido do dono: "o funil
   * precisa ser um Kanban, podendo arrastar os casos". O quadro é o MESMO da
   * carteira (componente único — regras de movimento, confirmação de terminal
   * e motivo de perda já testados lá). As métricas por safra NÃO morreram:
   * continuam inteiras atrás do seletor, porque respondem a outra pergunta —
   * "dos 250 de março, quantos viraram dinheiro" — que nenhuma coluna mostra.
   */
  const parametros = useSearchParams();
  const [vista, setVista] = useState<'quadro' | 'metricas'>(
    parametros.get('vista') === 'metricas' ? 'metricas' : 'quadro',
  );
  const [funil, setFunil] = useState<Estado<Funil>>(CARREGANDO);
  const [safras, setSafras] = useState<Safra[]>([]);
  const [perdas, setPerdas] = useState<PerdaEscrita[]>([]);

  const carregar = useCallback(async () => {
    /* ⚠ `carregando`, e não `!lote`.
       Todo CLIENTE fica permanentemente sem lote — é o desenho, e está escrito
       em `lib/lote.tsx`. Com a guarda antiga, `carregar` retornava na primeira
       linha para sempre e a tela inteira ficava num esqueleto que nunca
       terminava. As três rotas já aceitavam lote OPCIONAL: a API estava pronta,
       o front é que nunca perguntava. */
    if (carregando) return;
    try {
      /* `allSettled` não: aqui o funil é o conteúdo da tela, e falhar em
         silêncio mostraria uma página vazia sem dizer por quê. Safras e perdas
         são complementos e degradam sozinhas. */
      setFunil({ st: 'ok', dados: await crm.funil(lote ?? undefined) });
    } catch (e) {
      setFunil({ st: 'erro', msg: (e as Error).message });
      return;
    }
    const [s, p] = await Promise.allSettled([
      crm.safras(lote ?? undefined),
      crm.perdas(lote ?? undefined),
    ]);
    setSafras(s.status === 'fulfilled' ? s.value : []);
    setPerdas(p.status === 'fulfilled' ? p.value : []);
  }, [lote, carregando]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const f = funil.st === 'ok' ? funil.dados : null;

  return (
    <div className="p-6 lg:p-9">
      <header className="mb-6">
        <p className="rotulo">Comercial</p>
        <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
          Funil
        </h1>
        <p className="mt-1.5 text-sm text-muted">
          {vista === 'quadro'
            ? 'Arraste os casos entre os estágios. Cada coluna é um estágio do funil.'
            : 'Onde está a carteira, o que andou e o que se converteu, por safra de entrada.'}
        </p>
        <div
          role="group"
          aria-label="Vista do funil"
          className="mt-4 inline-flex rounded-full border border-linha p-1"
        >
          {(
            [
              ['quadro', 'Quadro'],
              ['metricas', 'Métricas'],
            ] as const
          ).map(([valor, rotulo]) => (
            <button
              key={valor}
              type="button"
              aria-pressed={vista === valor}
              onClick={() => setVista(valor)}
              className={cn(
                'cursor-pointer rounded-full px-4 py-1.5 text-[13px] transition-colors',
                vista === valor ? 'bg-marca text-white' : 'text-muted hover:text-ink',
              )}
            >
              {rotulo}
            </button>
          ))}
        </div>
      </header>

      {vista === 'quadro' && (
        /* O quadro busca as próprias colunas; o funil carregado aqui alimenta
           os totais do cabeçalho de cada coluna, e `carregar` os atualiza
           depois de cada arraste — mesmos números nas duas vistas. */
        <Quadro
          filtros={{}}
          lote={lote}
          carregando={carregando}
          funil={f}
          aoMudarFunil={() => void carregar()}
        />
      )}

      {vista === 'metricas' && (
        <>

      {funil.st === 'erro' && <BlocoErro msg={`Não foi possível carregar o funil: ${funil.msg}`} />}

      {funil.st === 'carregando' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Esqueleto key={i} className="h-28" />
          ))}
        </div>
      )}

      {f && (
        <>
          <section aria-label="O funil hoje" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <CartaoKpi Icone={Target} rotulo="Na carteira" indice={0}>
              <p className="num text-[28px] font-semibold text-ink">
                {f.total.toLocaleString('pt-BR')}
              </p>
            </CartaoKpi>
            <CartaoKpi
              Icone={Activity}
              rotulo="Em negociação"
              destaque
              indice={1}
              sub="em contato ou com proposta enviada"
            >
              <p className="num text-[28px] font-semibold text-ink">
                {(f.EM_CONTATO + f.PROPOSTA).toLocaleString('pt-BR')}
              </p>
            </CartaoKpi>
            <CartaoKpi
              Icone={PhoneOff}
              rotulo="Nunca tocados"
              indice={2}
              sub={
                /* O número que diz se a carteira está sendo TRABALHADA e não só
                   triada. Vem com o caminho de ação: a fila já filtrada. */
                <Link href="/carteira" className="text-marca-ciano hover:underline">
                  abrir na fila →
                </Link>
              }
            >
              <p className="num text-[28px] font-semibold text-ink">
                {f.semContato.toLocaleString('pt-BR')}
              </p>
            </CartaoKpi>
            <CartaoKpi
              Icone={TrendingDown}
              rotulo={`Movimento em ${f.movimento.dias} dias`}
              indice={3}
              sub={`registro desde ${new Date(f.movimento.desde).toLocaleDateString('pt-BR')}`}
            >
              <p className="num text-[28px] font-semibold text-ink">
                {(
                  f.movimento.EM_CONTATO +
                  f.movimento.PROPOSTA +
                  f.movimento.FECHADO +
                  f.movimento.PERDIDO
                ).toLocaleString('pt-BR')}
              </p>
            </CartaoKpi>
          </section>

          <Estagios funil={f} />
          <Safras safras={safras} />
          <Perdas perdas={perdas} />
        </>
      )}
        </>
      )}
    </div>
  );
}

/** A barra do funil: estoque por estágio, com o que se moveu na janela. */
function Estagios({ funil }: { funil: Funil }) {
  const maior = Math.max(...ORDEM_ESTAGIOS.map((v) => funil[v]), 1);

  return (
    <section aria-label="Estágios" className="cartao mt-5 p-5">
      <h2 className="text-[15px] font-medium text-ink">Onde a carteira está</h2>
      <div className="mt-4 space-y-3">
        {ORDEM_ESTAGIOS.map((v) => {
          const quantos = funil[v];
          const moveu = funil.movimento[v];
          return (
            /* Cada estágio LEVA à fila filtrada: um painel que só informa obriga
               o sócio a pedir a alguém que abra a lista. */
            <Link
              key={v}
              href={`/carteira?estagio=${v}`}
              className="flex items-center gap-3 rounded-[11px] px-2 py-1.5 transition-colors hover:bg-superficie-2"
            >
              <span className="w-24 shrink-0 text-[13px] text-ink-2">{ESTAGIO[v].plural}</span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-superficie-2">
                <span
                  className={cn('block h-full rounded-full', BARRA[v])}
                  style={{ width: `${Math.round((quantos / maior) * 100)}%` }}
                />
              </span>
              <span className="num w-16 shrink-0 text-right text-[13px] text-ink">
                {quantos.toLocaleString('pt-BR')}
              </span>
              <span className="w-28 shrink-0 text-right text-[11px] text-muted-2">
                {moveu > 0 ? `${moveu} ${rotuloDeMovimento(v, moveu)}` : '—'}
              </span>
            </Link>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted-2">
        A coluna da direita é o que MUDOU nos últimos {funil.movimento.dias} dias; a do meio é
        quanto está parado ali hoje.
      </p>
    </section>
  );
}

const BARRA: Record<string, string> = {
  NOVO: 'bg-muted-2',
  EM_CONTATO: 'bg-marca-ciano',
  PROPOSTA: 'bg-alerta',
  FECHADO: 'bg-ok',
  PERDIDO: 'bg-erro',
};

/**
 * A CONVERSÃO POR SAFRA.
 *
 * "18 de 168", nunca "10,7%": o percentual sozinho esconde o tamanho da amostra,
 * e numa safra de 12 processos ele oscila 8 pontos com um único fechamento.
 */
function Safras({ safras }: { safras: Safra[] }) {
  if (safras.length === 0) {
    return (
      <section aria-label="Safras" className="cartao mt-5">
        <Vazio
          Icone={Target}
          titulo="Sem safras para mostrar"
          descricao={
            /* A org interna cai aqui SEMPRE, e não é erro: ela é quem libera os
               processos, não quem os recebe. */
            'A conversão por safra existe para quem recebe processos num ciclo mensal. ' +
            'A operação interna, que libera os lotes, não tem safra própria.'
          }
        />
      </section>
    );
  }

  return (
    <section aria-label="Safras" className="cartao mt-5 p-5">
      <h2 className="text-[15px] font-medium text-ink">Conversão por safra</h2>
      <p className="mt-1 text-[12px] text-muted">
        Dos que entraram em cada ciclo, onde eles estão HOJE. O denominador não cresce — é isso
        que torna a comparação entre meses honesta.
      </p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-linha text-left">
              <th scope="col" className="rotulo py-2 pr-4 font-medium">Ciclo</th>
              <th scope="col" className="rotulo py-2 pr-4 text-right font-medium">Entraram</th>
              <th scope="col" className="rotulo py-2 pr-4 font-medium">Onde estão</th>
              <th scope="col" className="rotulo py-2 text-right font-medium">Fecharam</th>
            </tr>
          </thead>
          <tbody>
            {safras.map((s) => (
              <tr key={s.competencia} className="border-b border-linha/60 last:border-0">
                <td className="py-3 pr-4">
                  <span className="text-[13px] text-ink-2">
                    {new Date(s.competencia).toLocaleDateString('pt-BR', {
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </span>
                  {/* O mês corrente ainda está acontecendo: sem esta marca, o
                      último ponto da série sempre pareceria uma queda. */}
                  {s.parcial && (
                    <span className="ml-2 rounded-full border border-linha px-1.5 py-0.5 text-[10px] text-muted-2">
                      em curso
                    </span>
                  )}
                </td>
                <td className="num py-3 pr-4 text-right text-[13px] text-ink-2">
                  {s.liberados.toLocaleString('pt-BR')}
                  {/* Os dois números convivem porque o sorteio do ciclo NÃO
                      filtra por tribunal: sem isto, "250 liberados" ao lado de
                      uma fila de 168 pareceria 82 processos sumidos. */}
                  {s.noRecorte !== s.liberados && (
                    <span className="ml-1 text-[11px] text-muted-2">
                      ({s.noRecorte} neste lote)
                    </span>
                  )}
                </td>
                <td className="py-3 pr-4">
                  <Faixa safra={s} />
                </td>
                <td className="num py-3 text-right text-[13px] text-ok">
                  {s.FECHADO > 0 ? `${s.FECHADO} de ${s.liberados}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** A safra como uma faixa proporcional — cinco estágios, uma linha. */
function Faixa({ safra }: { safra: Safra }) {
  const total = Math.max(safra.liberados, 1);
  return (
    <span className="flex h-2.5 w-full min-w-[10rem] overflow-hidden rounded-full bg-superficie-2">
      {ORDEM_ESTAGIOS.map((v) =>
        safra[v] > 0 ? (
          <span
            key={v}
            className={cn('block h-full', BARRA[v])}
            style={{ width: `${(safra[v] / total) * 100}%` }}
            title={`${safra[v]} ${ESTAGIO[v].plural.toLowerCase()}`}
          />
        ) : null,
      )}
    </span>
  );
}

/**
 * OS MOTIVOS DE PERDA, ESCRITOS.
 *
 * Texto livre e não gráfico: com "perdido" ainda perto de zero, sete categorias
 * inventadas produziriam um gráfico em que "Outro" domina — pior que não ter.
 * As categorias saem DAQUI quando houver o que ler.
 */
function Perdas({ perdas }: { perdas: PerdaEscrita[] }) {
  if (perdas.length === 0) return null;

  return (
    <section aria-label="Motivos de perda" className="cartao mt-5 p-5">
      <h2 className="text-[15px] font-medium text-ink">Por que se perdeu</h2>
      <p className="mt-1 text-[12px] text-muted">
        O que a equipe escreveu, do mais recente para o mais antigo.
      </p>
      <ul className="mt-4 space-y-2.5">
        {perdas.slice(0, 15).map((p) => (
          <li key={p.processoId} className="flex items-start gap-3 text-[13px]">
            <Link
              href={`/processo/${p.processoId}`}
              className="num shrink-0 text-[12px] text-marca-ciano hover:underline"
            >
              {p.numeroPrecatorio}
            </Link>
            <span className="flex-1 text-ink-2">{p.motivo}</span>
            {p.quando && (
              <span className="num shrink-0 text-[11px] text-muted-2">
                {new Date(p.quando).toLocaleDateString('pt-BR')}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
