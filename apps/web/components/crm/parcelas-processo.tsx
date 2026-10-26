'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, Loader2, Undo2 } from 'lucide-react';
import { negociacao as api, type Cronograma, type Proposta } from '@/lib/api';
import { brl, cn } from '@/lib/utils';
import { BlocoErro } from '@/components/estado';

/**
 * O CRONOGRAMA DE PAGAMENTO ao titular.
 *
 * ── VENCIDA NÃO É COBRANÇA ──
 *
 * A parcela cujo dia passou aparece com um selo discreto, em cinza — não em
 * vermelho de alarme. Aqui "vencida" não dispara nada: não bloqueia o cliente,
 * não suspende assinatura, não manda e-mail ao titular. É informação para quem
 * paga, e o escritório atrasar o pagamento ao titular DELE não é assunto do
 * sistema. Pintar de vermelho seria o primeiro passo para uma régua de cobrança
 * que ninguém pediu.
 *
 * ── O TOTAL FICA À VISTA ──
 *
 * A soma das parcelas aparece ao lado do valor acordado. Não existe `PATCH` de
 * parcela — é essa ausência que faz a soma fechar por construção —, mas se um
 * dia alguém criar um, a divergência será VISTA na primeira vez que abrirem o
 * processo, em vez de aparecer meses depois na conferência do contrato.
 */
export function ParcelasProcesso({
  processoId,
  proposta,
  podeDarBaixa,
}: {
  processoId: string;
  proposta: Proposta;
  /** Só gestor ou administrador registra saída de dinheiro — decisão do dono. */
  podeDarBaixa: boolean;
}) {
  const [c, setC] = useState<Cronograma | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState<number | null>(null);
  const [abrindo, setAbrindo] = useState(false);

  /* Só faz sentido em cessão: em honorários o combinado é o percentual, e a
     quantia só existe quando o precatório for pago.

     A pergunta é feita AQUI, dentro do efeito, e não só no `return null` lá
     embaixo: hooks rodam antes de qualquer saída antecipada, então a versão
     ingênua buscava um cronograma para toda proposta de honorários — uma ida ao
     servidor por proposta, cuja resposta nada renderizaria. */
  const ehCessao = proposta.modalidade === 'CESSAO';

  const carregar = useCallback(async () => {
    if (!ehCessao) return;
    try {
      setC(await api.cronograma(processoId, proposta.id));
    } catch (e) {
      setErro((e as Error).message);
    }
  }, [ehCessao, processoId, proposta.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function agir(numero: number, f: () => Promise<Cronograma>) {
    setSalvando(numero);
    setErro(null);
    try {
      setC(await f());
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(null);
    }
  }

  const temCronograma = (c?.parcelas.length ?? 0) > 0;
  const editavel = proposta.status === 'RASCUNHO' || proposta.status === 'ENVIADA';
  const fechado = proposta.status === 'ACEITA';
  const algumaPaga = c?.parcelas.some((p) => p.pagoEm !== null) ?? false;

  if (!ehCessao) return null;

  return (
    <div className="mt-4 border-t border-linha/60 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarClock aria-hidden className="h-3.5 w-3.5 text-muted" />
          <h4 className="rotulo">Pagamento ao titular</h4>
        </div>

        {(editavel || (fechado && !algumaPaga)) && !abrindo && (
          <button
            type="button"
            onClick={() => setAbrindo(true)}
            className="h-8 rounded-[9px] border border-linha px-3 text-[12px] text-ink-2 transition-colors hover:border-linha-2"
          >
            {temCronograma ? 'Refazer cronograma' : 'Parcelar'}
          </button>
        )}
      </div>

      {erro && <BlocoErro msg={erro} className="mt-3" />}

      {abrindo && (
        <FormularioCronograma
          valorAcordado={proposta.valorProposto}
          salvando={salvando !== null}
          aoCancelar={() => setAbrindo(false)}
          aoEnviar={async (d) => {
            await agir(-1, () => api.gerarCronograma(processoId, proposta.id, d));
            setAbrindo(false);
          }}
        />
      )}

      {!temCronograma && !abrindo && (
        <p className="mt-2 text-[12px] text-muted">
          À vista. {editavel && 'Use "Parcelar" para combinar entrada e vezes — as parcelas saem na folha que o titular assina.'}
        </p>
      )}

      {temCronograma && c && (
        <>
          <table className="mt-3 w-full text-[12px]">
            <caption className="sr-only">Parcelas do pagamento ao titular</caption>
            <tbody>
              {c.parcelas.map((p) => (
                <tr key={p.id} className="border-b border-linha/40 last:border-0">
                  <td className="py-1.5 pr-3 text-muted">
                    {p.entrada ? 'Entrada' : `Parcela ${p.numero}`}
                  </td>
                  <td className="num py-1.5 pr-3 text-ink-2">{brl(p.valor)}</td>
                  <td className="num py-1.5 pr-3 text-muted">
                    {new Date(p.vencimento).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                  </td>
                  <td className="py-1.5 pr-3">
                    {p.pagoEm ? (
                      <span className="flex items-center gap-1 text-ok">
                        <Check aria-hidden className="h-3 w-3" />
                        pago em {new Date(p.pagoEm).toLocaleDateString('pt-BR')}
                      </span>
                    ) : (
                      /* Cinza, e não vermelho: aqui vencida é informação, não
                         alarme — não bloqueia, não cobra, não suspende. */
                      p.vencida && <span className="text-muted-2">vencida</span>
                    )}
                  </td>
                  <td className="py-1.5 text-right">
                    {fechado && podeDarBaixa && (
                      <button
                        type="button"
                        disabled={salvando !== null}
                        onClick={() =>
                          void agir(p.numero, () =>
                            p.pagoEm
                              ? api.desfazerBaixa(processoId, proposta.id, p.numero)
                              : api.baixar(processoId, proposta.id, p.numero),
                          )
                        }
                        className="flex h-7 items-center gap-1 rounded-[8px] border border-linha px-2 text-[11px] text-muted transition-colors hover:text-ink-2 disabled:opacity-50"
                      >
                        {salvando === p.numero ? (
                          <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                        ) : p.pagoEm ? (
                          <Undo2 aria-hidden className="h-3 w-3" />
                        ) : null}
                        {p.pagoEm ? 'Desfazer' : 'Registrar pagamento'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="mt-2 text-[11px] text-muted-2">
            Soma das parcelas: <span className="num">{brl(c.total)}</span>
            {/* Se um dia a soma divergir do acordado, é AQUI que se vê — na
                primeira vez que alguém abrir o processo, e não meses depois. */}
            {proposta.valorProposto && c.total !== proposta.valorProposto && (
              <span className="ml-1.5 text-erro">
                ⚠ diferente do valor acordado ({brl(proposta.valorProposto)})
              </span>
            )}
          </p>

          {fechado && !podeDarBaixa && (
            <p className="mt-1.5 text-[11px] text-muted-2">
              Só o gestor da organização ou um administrador registra pagamento.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function FormularioCronograma({
  valorAcordado,
  aoEnviar,
  aoCancelar,
  salvando,
}: {
  valorAcordado: string | null;
  aoEnviar: (d: {
    entrada?: string;
    parcelas: number;
    primeiroVencimento: string;
    intervaloMeses?: number;
  }) => Promise<void>;
  aoCancelar: () => void;
  salvando: boolean;
}) {
  const [entrada, setEntrada] = useState('');
  const [parcelas, setParcelas] = useState('6');
  const [primeiro, setPrimeiro] = useState('');
  const [intervalo, setIntervalo] = useState('1');

  const campo =
    'h-9 w-full rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40';

  return (
    <form
      method="post"
      className="mt-3 rounded-[11px] border border-linha p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void aoEnviar({
          ...(entrada ? { entrada } : {}),
          parcelas: Number(parcelas),
          primeiroVencimento: primeiro,
          ...(intervalo !== '1' ? { intervaloMeses: Number(intervalo) } : {}),
        });
      }}
    >
      <p className="text-[12px] text-muted">
        Dividindo <span className="num text-ink-2">{valorAcordado ? brl(valorAcordado) : '—'}</span>
        {/* O total NÃO é digitado aqui: sai do valor já acordado na proposta.
            Aceitá-lo no formulário criaria duas verdades sobre quanto se paga. */}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="rotulo">Entrada (sai no ato)</span>
          <input
            aria-label="Entrada"
            inputMode="decimal"
            value={entrada}
            onChange={(e) => setEntrada(e.target.value)}
            placeholder="opcional"
            className={cn(campo, 'num mt-1')}
          />
        </label>

        <label className="block">
          <span className="rotulo">Em quantas vezes</span>
          <input
            aria-label="Número de parcelas"
            inputMode="numeric"
            value={parcelas}
            onChange={(e) => setParcelas(e.target.value)}
            className={cn(campo, 'num mt-1')}
          />
        </label>

        <label className="block">
          <span className="rotulo">Primeiro vencimento</span>
          <input
            aria-label="Primeiro vencimento"
            type="date"
            required
            value={primeiro}
            onChange={(e) => setPrimeiro(e.target.value)}
            className={cn(campo, 'mt-1')}
          />
        </label>

        <label className="block">
          <span className="rotulo">De quantos em quantos meses</span>
          <input
            aria-label="Intervalo em meses"
            inputMode="numeric"
            value={intervalo}
            onChange={(e) => setIntervalo(e.target.value)}
            className={cn(campo, 'num mt-1')}
          />
        </label>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={salvando}
          className="flex h-8 items-center gap-2 rounded-[9px] bg-marca px-3 text-[12px] font-medium text-[#05070f] disabled:opacity-60"
        >
          {salvando && <Loader2 aria-hidden className="h-3 w-3 animate-spin" />}
          Gerar parcelas
        </button>
        <button type="button" onClick={aoCancelar} className="h-8 rounded-[9px] px-3 text-[12px] text-muted">
          Cancelar
        </button>
      </div>
    </form>
  );
}
