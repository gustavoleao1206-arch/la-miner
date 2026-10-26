'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Handshake, Loader2, Printer, Scale } from 'lucide-react';
import {
  negociacao as api,
  type Modalidade,
  type Negociacao,
  type Proposta,
  type QuemPaga,
} from '@/lib/api';
import {
  calcularSaldoOficial,
  type EsferaCnj,
  type SaldoOficialCnj,
} from '@/lib/calculadora-cnj';
import { brl, cn } from '@/lib/utils';
import { BlocoErro } from '@/components/estado';
import { ParcelasProcesso } from './parcelas-processo';

/**
 * A NEGOCIAÇÃO do processo.
 *
 * ── O QUE ESTE BLOCO GUARDA QUE O RESTO DO SISTEMA NÃO GUARDAVA ──
 *
 * `Processo.valor` é o valor de FACE do precatório: o que o ente público deve ao
 * titular. Não é receita de ninguém. Quanto o escritório ofereceu, e quanto
 * ganha, nunca existiu no banco — e é isso que se registra aqui.
 *
 * ── RODADAS, E NÃO UM CAMPO DE VALOR ──
 *
 * "Ajustar" uma proposta já apresentada não sobrescreve: abre a rodada seguinte.
 * É o que preserva a contraproposta do titular, que é o número de onde se saiu —
 * e é ele que explica onde se chegou.
 */

const ROTULO_STATUS: Record<Proposta['status'], { texto: string; classe: string }> = {
  RASCUNHO: { texto: 'Rascunho', classe: 'text-muted' },
  ENVIADA: { texto: 'Apresentada', classe: 'text-marca-ciano' },
  ACEITA: { texto: 'Aceita', classe: 'text-ok' },
  RECUSADA: { texto: 'Recusada', classe: 'text-erro' },
  SUBSTITUIDA: { texto: 'Substituída', classe: 'text-muted-2' },
  CANCELADA: { texto: 'Cancelada', classe: 'text-muted-2' },
};


/**
 * A CALCULADORA OFICIAL (CNJ) — o saldo de hoje, defensável.
 *
 * A chamada sai DO NAVEGADOR, direto ao gateway do CNJ — e não da nossa API.
 * Não é estilo: o gateway bloqueia IP estrangeiro (medido: Brasil 200, EUA e
 * Europa 403) e a nossa API mora nos EUA. A primeira versão proxiava pelo
 * servidor e falhou em produção na primeira tentativa real. O CORS aberto do
 * gateway é o CNJ dizendo que o navegador é o caminho suportado.
 *
 * Nada é gravado: o saldo muda todo dia com a série. O que o operador faz com
 * o número — usá-lo de base numa rodada — é gesto dele, e aí sim congela.
 */
function CalculadoraOficial({
  base,
  esferaTribunal,
  exercicio,
}: {
  /** A base ATUAL do processo (mesma régua da proposta). Nula = sem valor lançado. */
  base: string | null;
  /** Esfera do tribunal (FEDERAL/ESTADUAL convertem sozinhas). */
  esferaTribunal: string | null;
  exercicio: number | null;
}) {
  const [dataBase, setDataBase] = useState('');
  const [dataProtocolo, setDataProtocolo] = useState('');
  const [valorManual, setValorManual] = useState('');
  const [esferaManual, setEsferaManual] = useState<EsferaCnj | ''>('');
  const [calculando, setCalculando] = useState(false);
  const [erroCalculo, setErroCalculo] = useState<string | null>(null);
  const [saldo, setSaldo] = useState<SaldoOficialCnj | null>(null);

  /* FEDERAL e ESTADUAL convertem 1:1; TRABALHISTA e SUPERIOR não têm resposta
     óbvia (o devedor pode ser de qualquer esfera) — aí quem escolhe é o
     operador, que sabe quem deve. */
  const esferaDerivada =
    esferaTribunal === 'FEDERAL' || esferaTribunal === 'ESTADUAL'
      ? (esferaTribunal as EsferaCnj)
      : null;
  const esfera = esferaDerivada ?? (esferaManual || null);

  const valorBase = base !== null ? Number(base) : Number(valorManual || 0);
  const pronto = Boolean(dataBase && dataProtocolo && esfera && valorBase > 0);

  async function calcular() {
    if (!pronto || calculando) return;
    setCalculando(true);
    setErroCalculo(null);
    try {
      setSaldo(
        await calcularSaldoOficial({
          valorPrincipal: valorBase,
          dataBase,
          dataProtocolo,
          exercicio: exercicio ? String(exercicio) : undefined,
          esfera: esfera as EsferaCnj,
        }),
      );
    } catch (e) {
      setSaldo(null);
      setErroCalculo((e as Error).message);
    } finally {
      setCalculando(false);
    }
  }

  return (
    <div className="mt-4 rounded-[12px] border border-linha bg-superficie p-4">
      <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Scale aria-hidden className="h-3.5 w-3.5 text-marca-ciano" />
        Saldo atualizado — calculadora oficial (CNJ)
      </p>
      <p className="mt-1 text-[11px] text-muted">
        O mesmo motor de cálculo dos tribunais (SISPREQ). As datas estão no
        requisitório. Nada é gravado — o saldo muda com a série de índices.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {base === null && (
          <label className="block">
            <span className="rotulo">Valor base (R$)</span>
            <input
              inputMode="decimal"
              value={valorManual}
              onChange={(e) => setValorManual(e.target.value.replace(',', '.'))}
              placeholder="50000.00"
              className="mt-1 h-9 w-36 rounded-[10px] border border-linha bg-bg px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
            />
          </label>
        )}
        <label className="block">
          <span className="rotulo">Data-base</span>
          <input
            type="date"
            value={dataBase}
            onChange={(e) => setDataBase(e.target.value)}
            className="mt-1 h-9 rounded-[10px] border border-linha bg-bg px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
          />
        </label>
        <label className="block">
          <span className="rotulo">Protocolo no tribunal</span>
          <input
            type="date"
            value={dataProtocolo}
            onChange={(e) => setDataProtocolo(e.target.value)}
            className="mt-1 h-9 rounded-[10px] border border-linha bg-bg px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
          />
        </label>
        {!esferaDerivada && (
          <label className="block">
            <span className="rotulo">Esfera do devedor</span>
            <select
              value={esferaManual}
              onChange={(e) => setEsferaManual(e.target.value as EsferaCnj | '')}
              className="mt-1 h-9 rounded-[10px] border border-linha bg-bg px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
            >
              <option value="">escolha…</option>
              <option value="FEDERAL">Federal</option>
              <option value="ESTADUAL">Estadual</option>
              <option value="MUNICIPAL">Municipal</option>
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => void calcular()}
          disabled={!pronto || calculando}
          className="flex h-9 items-center gap-2 rounded-[11px] border border-linha px-4 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
        >
          {calculando && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
          Calcular
        </button>
      </div>

      {erroCalculo && (
        <p role="alert" className="mt-3 text-[12px] text-erro">
          {erroCalculo}
        </p>
      )}

      {saldo && (
        <div className="mt-4 border-t border-linha pt-3">
          <p className="text-[12px] text-muted">
            Sobre {brl(saldo.valorBase.toFixed(2))} em {saldo.dataBase}:
          </p>
          <p className="num mt-1 text-[22px] font-semibold text-ink">
            {brl(saldo.saldoAtualizado.toFixed(2))}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            correção {brl(saldo.correcao.toFixed(2))} · juros{' '}
            {brl(saldo.juros.toFixed(2))} · SELIC {brl(saldo.selic.toFixed(2))}
          </p>

          {/* O memorial é o que torna o número DEFENSÁVEL: índice, período e
              percentual, na ordem em que o motor aplicou. */}
          <ul className="mt-2 space-y-0.5">
            {saldo.indices.map((i) => (
              <li key={i.nome + i.dataInicio} className="text-[11px] text-muted-2">
                {i.nome}: {i.dataInicio} → {i.dataFinal} ({i.percentual.toFixed(2)}%)
              </li>
            ))}
          </ul>

          <p className="mt-2 text-[10px] text-muted-2">
            Fonte: Calculadora oficial do CNJ (SISPREQ)
            {saldo.serieAtualizadaAte ? ` · série atualizada até ${saldo.serieAtualizadaAte}` : ''}
            {' · '}legislação: {saldo.legislacoes.join(', ')}
          </p>
        </div>
      )}
    </div>
  );
}

export function NegociacaoProcesso({
  processoId,
  podeDarBaixa = false,
  esferaTribunal = null,
  exercicio = null,
}: {
  processoId: string;
  /** Esfera do tribunal do processo — decide se a calculadora do CNJ deriva a
      esfera sozinha ou pergunta ao operador. */
  esferaTribunal?: string | null;
  exercicio?: number | null;
  /** Gestor da organização ou administrador — decisão do dono sobre quem
      registra saída de dinheiro. O servidor recusa de qualquer forma; isto só
      evita oferecer um botão que vai dar 403. */
  podeDarBaixa?: boolean;
}) {
  const [dados, setDados] = useState<Negociacao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [abrindo, setAbrindo] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setDados(await api.resumo(processoId));
    } catch (e) {
      setErro((e as Error).message);
    }
  }, [processoId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function agir(f: () => Promise<unknown>) {
    setSalvando(true);
    setErro(null);
    try {
      await f();
      await carregar();
      setAbrindo(false);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  if (!dados) {
    return (
      <section aria-label="Negociação" className="cartao mt-5 p-5">
        <p className="text-[13px] text-muted">Carregando negociação…</p>
      </section>
    );
  }

  const viva = dados.viva;

  /**
   * ── O CARTÃO QUE PRECISA ESTAR SEMPRE NA TELA ──
   *
   * "Viva" é só RASCUNHO ou ENVIADA. Uma proposta ACEITA não é viva — e, num
   * processo com uma rodada só, ela caía num vão: o bloco da viva não desenhava
   * (não há viva) e o do histórico também não (só aparecia com mais de uma
   * rodada). Resultado: assim que o titular aceitava, o negócio FECHADO sumia da
   * tela, e com ele os botões de imprimir a folha — que moram no cartão.
   *
   * A folha existia e não tinha porta. Era o pior tipo de defeito: entregar o
   * documento e esconder o caminho até ele, justamente no caso que mais importa.
   */
  const emDestaque = viva ?? dados.aceita;
  const demais = dados.rodadas.filter((r) => r.id !== emDestaque?.id);

  return (
    <section aria-label="Negociação" className="cartao mt-5 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Handshake aria-hidden className="h-4 w-4 text-marca-ciano" />
          <h2 className="text-[15px] font-medium text-ink">Negociação</h2>
        </div>

        {!viva && !abrindo && (
          <button
            type="button"
            onClick={() => setAbrindo(true)}
            className="h-9 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] transition-opacity hover:opacity-90"
          >
            {dados.rodadas.length === 0 ? 'Registrar proposta' : 'Nova rodada'}
          </button>
        )}
      </header>

      {erro && <BlocoErro msg={erro} className="mt-4" />}

      <CalculadoraOficial base={dados.baseAtual} esferaTribunal={esferaTribunal} exercicio={exercicio} />

      {/* A base de cálculo, e o aviso de quando ela mudou depois da proposta. */}
      <p className="mt-3 text-[12px] text-muted">
        Base de cálculo do processo:{' '}
        <span className="num text-ink-2">{dados.baseAtual ? brl(dados.baseAtual) : '—'}</span>
        {dados.baseOrigemAtual === 'SOMA_DAS_PARTES' && (
          <span className="ml-1.5 text-muted-2">(soma das partes)</span>
        )}
      </p>

      {emDestaque && (
        <Rodada
          p={emDestaque}
          podeDarBaixa={podeDarBaixa}
          destaque
          processoId={processoId}
          aoAgir={agir}
          salvando={salvando}
        />
      )}

      {abrindo && (
        <Formulario
          aoCancelar={() => setAbrindo(false)}
          salvando={salvando}
          aoEnviar={(d) => agir(() => api.criar(processoId, d))}
        />
      )}

      {!emDestaque && !abrindo && dados.rodadas.length === 0 && (
        <p className="mt-4 text-[13px] text-muted">
          Nenhuma proposta registrada. O valor acima é o que o ente público deve ao titular — não
          o que o escritório paga nem o que ganha.
        </p>
      )}

      {demais.length > 0 && (
        <div className="mt-5 border-t border-linha pt-4">
          <h3 className="rotulo">Rodadas anteriores</h3>
          <div className="mt-3 space-y-3">
            {demais.map((r) => (
              <Rodada
                key={r.id}
                p={r}
                podeDarBaixa={podeDarBaixa}
                processoId={processoId}
                aoAgir={agir}
                salvando={salvando}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Rodada({
  p,
  podeDarBaixa,
  destaque,
  processoId,
  aoAgir,
  salvando,
}: {
  p: Proposta;
  podeDarBaixa: boolean;
  /** O cartão do topo: a proposta viva, ou — fechado o negócio — a aceita. */
  destaque?: boolean;
  processoId: string;
  aoAgir: (f: () => Promise<unknown>) => Promise<void>;
  salvando: boolean;
}) {
  const s = ROTULO_STATUS[p.status];

  return (
    <div
      className={cn(
        'rounded-[13px] border p-4',
        destaque ? 'mt-4 border-marca-ciano/30 bg-marca-ciano/[0.05]' : 'border-linha',
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5 text-[12px]">
        <span className="num text-muted">Rodada {p.rodada}</span>
        <span className={cn('font-medium', s.classe)}>{s.texto}</span>
        {/* De quem foi o número. Sem isto, a contraproposta do titular vira
            indistinguível de uma oferta nossa. */}
        {p.origem === 'TITULAR' && (
          <span className="rounded-full border border-linha px-2 py-0.5 text-[11px] text-ink-2">
            contraproposta do titular
          </span>
        )}
        <span className="text-muted-2">
          {p.modalidade === 'CESSAO' ? 'cessão do crédito' : 'honorários'}
        </span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {p.modalidade === 'CESSAO' ? (
          <>
            <Campo rotulo="Proposto ao titular" valor={p.valorProposto ? brl(p.valorProposto) : '—'} />
            <Campo
              rotulo="Deságio"
              /* NULO vira travessão, e não "0%": a diferença entre "não sei a
                 margem" e "a margem é zero" muda a decisão de quem lê. */
              valor={p.desagioPercentual ? `${p.desagioPercentual}%` : '—'}
            />
            <Campo
              rotulo="Líquido ao titular"
              valor={p.liquidoAoTitular ? brl(p.liquidoAoTitular) : '—'}
            />
          </>
        ) : (
          <>
            <Campo
              rotulo="Honorário"
              valor={p.honorarioPercentual ? `${p.honorarioPercentual}%` : '—'}
            />
            <Campo
              rotulo="Sobre o que o titular receber"
              valor="quando o precatório for pago"
              discreto
            />
          </>
        )}
      </div>

      {p.baseValor && (
        <p className="mt-2.5 text-[11px] text-muted-2">
          base congelada nesta rodada: <span className="num">{brl(p.baseValor)}</span>
        </p>
      )}

      {p.observacao && <p className="mt-2 text-[12px] text-ink-2">{p.observacao}</p>}

      {/* O cronograma vive no cartão do topo: é onde o operador está olhando
          quando pensa em quando o titular recebe. Nas rodadas antigas ele não
          aparece — cronograma de proposta substituída é ruído. */}
      {destaque && (
        <ParcelasProcesso processoId={processoId} proposta={p} podeDarBaixa={podeDarBaixa} />
      )}

      {/* Cada botão já se decide pelo STATUS logo abaixo; a condição do bloco só
          precisa dizer que este é o cartão do topo. Amarrá-la a "viva" era o que
          fazia a proposta ACEITA perder os botões de impressão junto com o
          resto — e a folha, a única porta que tinha. */}
      {destaque && (
        <div className="mt-4 flex flex-wrap gap-2">
          {p.status === 'RASCUNHO' && (
            <button
              type="button"
              disabled={salvando}
              onClick={() => void aoAgir(() => api.enviar(processoId, p.id))}
              className="flex h-9 items-center gap-2 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] disabled:opacity-60"
            >
              {salvando && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
              Apresentar ao titular
            </button>
          )}

          {p.status === 'ENVIADA' && (
            <>
              <button
                type="button"
                disabled={salvando}
                onClick={() => void aoAgir(() => api.decidir(processoId, p.id, 'ACEITA'))}
                className="h-9 rounded-[11px] border border-ok/40 bg-ok/10 px-4 text-[13px] font-medium text-ok disabled:opacity-60"
              >
                Titular aceitou
              </button>
              <button
                type="button"
                disabled={salvando}
                onClick={() => void aoAgir(() => api.decidir(processoId, p.id, 'RECUSADA'))}
                className="h-9 rounded-[11px] border border-linha px-4 text-[13px] text-muted disabled:opacity-60"
              >
                Recusou
              </button>
            </>
          )}

          {p.status === 'RASCUNHO' && (
            <button
              type="button"
              disabled={salvando}
              onClick={() => void aoAgir(() => api.remover(processoId, p.id))}
              className="h-9 rounded-[11px] px-3 text-[13px] text-muted disabled:opacity-60"
            >
              Descartar
            </button>
          )}

          {/* ── O CAMINHO PARA A FOLHA ──
              `<Link>`, e não `window.open`: o token de acesso vive em
              `sessionStorage`, que NÃO atravessa abas. Uma aba nova tomaria 401,
              renovaria em paralelo com esta, e as duas renovações simultâneas
              caem na detecção de reuso do servidor — derrubando a sessão inteira
              e enchendo o log de segurança de alarme falso.

              Os dois destinos ficam separados e nomeados na tela: "entregar ao
              titular" e "conferir internamente" não podem depender de alguém
              lembrar qual botão traz a margem. */}
          <Link
            href={`/processo/${processoId}/proposta?proposta=${p.id}&destino=TITULAR`}
            className="flex h-9 items-center gap-1.5 rounded-[11px] border border-linha px-3 text-[13px] text-ink-2 transition-colors hover:border-linha-2"
          >
            <Printer aria-hidden className="h-3.5 w-3.5" />
            Folha do titular
          </Link>
          <Link
            href={`/processo/${processoId}/proposta?proposta=${p.id}&destino=INTERNO`}
            className="flex h-9 items-center rounded-[11px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
          >
            versão interna (com margem)
          </Link>
        </div>
      )}
    </div>
  );
}

function Campo({ rotulo, valor, discreto }: { rotulo: string; valor: string; discreto?: boolean }) {
  return (
    <div>
      <p className="rotulo">{rotulo}</p>
      <p className={cn('num mt-0.5 text-[15px]', discreto ? 'text-[12px] text-muted' : 'text-ink')}>
        {valor}
      </p>
    </div>
  );
}

/**
 * O formulário de uma rodada.
 *
 * A modalidade decide QUAIS campos existem, e é escolhida uma vez: cessão pede
 * quantia, honorários pedem percentual, e os dois se excluem. Mostrar os dois
 * juntos convidaria a preencher ambos — e o servidor recusaria, com razão, mas
 * só depois de a pessoa ter digitado.
 */
function Formulario({
  aoEnviar,
  aoCancelar,
  salvando,
}: {
  aoEnviar: (dados: {
    modalidade: Modalidade;
    origem?: 'ESCRITORIO' | 'TITULAR';
    valorProposto?: string;
    honorarioPercentual?: string;
    custasEstimadas?: string;
    custasPorContaDe?: QuemPaga;
    validaAte?: string;
    observacao?: string;
  }) => Promise<void>;
  aoCancelar: () => void;
  salvando: boolean;
}) {
  const [modalidade, setModalidade] = useState<Modalidade>('CESSAO');
  const [doTitular, setDoTitular] = useState(false);
  const [valor, setValor] = useState('');
  const [percentual, setPercentual] = useState('');
  const [custas, setCustas] = useState('');
  const [custasDe, setCustasDe] = useState<QuemPaga>('ESCRITORIO');
  const [validade, setValidade] = useState('');
  const [obs, setObs] = useState('');

  const campo =
    'h-9 w-full rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40';

  return (
    <form
      method="post"
      className="mt-4 rounded-[13px] border border-linha p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void aoEnviar({
          modalidade,
          ...(doTitular ? { origem: 'TITULAR' as const } : {}),
          /* Só viaja o campo da modalidade escolhida: mandar os dois faria o
             servidor recusar, e com razão — um exclui o outro. */
          ...(modalidade === 'CESSAO' && valor ? { valorProposto: valor } : {}),
          ...(modalidade === 'HONORARIOS' && percentual
            ? { honorarioPercentual: percentual }
            : {}),
          ...(custas ? { custasEstimadas: custas, custasPorContaDe: custasDe } : {}),
          ...(validade ? { validaAte: validade } : {}),
          ...(obs.trim() ? { observacao: obs.trim() } : {}),
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="rotulo">Como se negocia</span>
          <select
            aria-label="Modalidade"
            value={modalidade}
            onChange={(e) => setModalidade(e.target.value as Modalidade)}
            className={cn(campo, 'mt-1')}
          >
            <option value="CESSAO">Cessão — o escritório compra o crédito</option>
            <option value="HONORARIOS">Honorários — percentual do que o titular receber</option>
          </select>
        </label>

        {modalidade === 'CESSAO' ? (
          <label className="block">
            <span className="rotulo">Quanto se paga ao titular</span>
            <input
              aria-label="Valor proposto"
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="300000.00"
              className={cn(campo, 'num mt-1')}
            />
          </label>
        ) : (
          <label className="block">
            <span className="rotulo">Percentual do escritório</span>
            <input
              aria-label="Honorário percentual"
              inputMode="decimal"
              value={percentual}
              onChange={(e) => setPercentual(e.target.value)}
              placeholder="20.00"
              className={cn(campo, 'num mt-1')}
            />
          </label>
        )}

        <label className="block">
          <span className="rotulo">Custas estimadas</span>
          <input
            aria-label="Custas estimadas"
            inputMode="decimal"
            value={custas}
            onChange={(e) => setCustas(e.target.value)}
            placeholder="opcional"
            className={cn(campo, 'num mt-1')}
          />
        </label>

        <label className="block">
          <span className="rotulo">Custas por conta de</span>
          <select
            aria-label="Custas por conta de"
            value={custasDe}
            onChange={(e) => setCustasDe(e.target.value as QuemPaga)}
            className={cn(campo, 'mt-1')}
          >
            <option value="ESCRITORIO">Escritório</option>
            <option value="TITULAR">Titular (sai do que ele recebe)</option>
          </select>
        </label>

        <label className="block">
          <span className="rotulo">Proposta válida até</span>
          <input
            aria-label="Válida até"
            type="date"
            value={validade}
            onChange={(e) => setValidade(e.target.value)}
            className={cn(campo, 'mt-1')}
          />
        </label>

        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={doTitular}
            onChange={(e) => setDoTitular(e.target.checked)}
            className="h-4 w-4 accent-marca-ciano"
          />
          {/* É o que faz a contraproposta existir como DADO, em vez de virar
              frase perdida numa observação que nenhum relatório soma. */}
          <span className="text-[13px] text-ink-2">Este número veio do titular</span>
        </label>
      </div>

      <label className="mt-3 block">
        <span className="rotulo">Observação</span>
        <input
          aria-label="Observação da proposta"
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          maxLength={1000}
          className={cn(campo, 'mt-1')}
        />
      </label>

      <p className="mt-2.5 flex items-start gap-1.5 text-[11px] text-muted-2">
        <AlertTriangle aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
        Isto grava um rascunho. Ele só vira proposta — e move o funil — quando você apresentar ao
        titular.
      </p>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={salvando}
          className="flex h-9 items-center gap-2 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] disabled:opacity-60"
        >
          {salvando && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
          Salvar rascunho
        </button>
        <button
          type="button"
          onClick={aoCancelar}
          className="h-9 rounded-[11px] px-3 text-[13px] text-muted"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
