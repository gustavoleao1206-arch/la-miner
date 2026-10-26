'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CreditCard, ExternalLink, RefreshCw, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { brl, cn } from '@/lib/utils';
import { CARREGANDO, type Estado, BlocoErro, Vazio } from '@/components/estado';

type StatusAssinatura = 'PENDENTE' | 'ATIVA' | 'INADIMPLENTE' | 'SUSPENSA' | 'CANCELADA';
type StatusFatura = 'ABERTA' | 'PAGA' | 'VENCIDA' | 'CANCELADA' | 'ESTORNADA';

interface Fatura {
  id: string;
  competencia: string;
  valor: string;
  status: StatusFatura;
  vencimentoEm: string;
  pagoEm: string | null;
  urlPagamento: string | null;
  /**
   * A cobrança desta fatura pode ser gerada de novo?
   *
   * Booleano de PRODUTO, calculado no servidor. A tela não sabe — nem deve —
   * que por trás disso existe um `idExterno` de gateway; e no provedor manual
   * ele é nulo por definição, o que faria a tela oferecer "gerar cobrança"
   * onde não há gateway nenhum. Quem resolve essa distinção é a API.
   */
  retomavel: boolean;
}

interface MinhaAssinatura {
  status: StatusAssinatura;
  inicioEm: string;
  proximaRenovacaoEm: string | null;
  plano: { nome: string; descricao: string | null; processosPorCiclo: number; preco: string };
  faturas: Fatura[];
}

/**
 * Data vinda de coluna DATE, formatada SEM passar por fuso.
 *
 * `new Date('2026-07-01').toLocaleDateString('pt-BR')` imprime 30/06 no Brasil,
 * porque a string é lida como meia-noite UTC e exibida em UTC-3. Num vencimento,
 * um dia a menos é a diferença entre "vence hoje" e "está vencida".
 */
const dia = (iso: string | null) =>
  iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';

const mes = (iso: string) => {
  const [ano, m] = String(iso).slice(0, 7).split('-');
  return `${m}/${ano}`;
};

const TOM_ASSINATURA: Record<StatusAssinatura, { texto: string; classe: string }> = {
  ATIVA: { texto: 'Ativa', classe: 'border-ok/30 bg-ok/10 text-ok' },
  PENDENTE: { texto: 'Aguardando pagamento', classe: 'border-linha bg-superficie text-muted' },
  INADIMPLENTE: { texto: 'Pagamento em atraso', classe: 'border-alerta/30 bg-alerta/10 text-alerta' },
  SUSPENSA: { texto: 'Suspensa', classe: 'border-erro/30 bg-erro/10 text-erro' },
  CANCELADA: { texto: 'Cancelada', classe: 'border-linha bg-superficie text-muted' },
};

const TOM_FATURA: Record<StatusFatura, string> = {
  PAGA: 'text-ok',
  ABERTA: 'text-ink-2',
  VENCIDA: 'text-erro',
  CANCELADA: 'text-muted',
  ESTORNADA: 'text-muted',
};

export default function AssinaturaPage() {
  const [estado, setEstado] = useState<Estado<MinhaAssinatura>>(CARREGANDO);
  const [retomando, setRetomando] = useState(false);
  const [erroRetomada, setErroRetomada] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setEstado({ st: 'ok', dados: await api<MinhaAssinatura>('/cobranca/minha-assinatura') });
    } catch (e) {
      setEstado({ st: 'erro', msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const a = estado.st === 'ok' ? estado.dados : null;
  const tom = a ? TOM_ASSINATURA[a.status] : null;
  const emAberto = a?.faturas.filter((f) => f.status === 'ABERTA' || f.status === 'VENCIDA') ?? [];

  /* Os dois sinais que separam os três estados do bloco PENDENTE. Nomeados
     porque a condição aparece em quatro lugares do JSX, e repetir
     `emAberto.some(...)` fazia a tela decidir a mesma coisa quatro vezes. */
  const comLink = emAberto.find((f) => f.urlPagamento) ?? null;
  const retomavel = emAberto.some((f) => f.retomavel);

  /**
   * Manda o servidor tentar abrir a cobrança de novo.
   *
   * Recarrega SEMPRE ao fim, inclusive no erro: a emissão é idempotente e pode
   * ter avançado parcialmente, e uma tela que não se atualiza depois da ação é
   * como este bug nasceu.
   */
  const retomar = useCallback(async () => {
    setRetomando(true);
    setErroRetomada(null);
    try {
      const r = await api<{ urlPagamento?: string | null }>('/cobranca/minha-assinatura/retomar', {
        method: 'POST',
      });
      /* Leva direto ao pagamento quando o link nasce — o cliente clicou para
         pagar, não para ver um aviso de sucesso. */
      if (r?.urlPagamento) window.location.href = r.urlPagamento;
    } catch (e) {
      setErroRetomada(
        `Não conseguimos abrir a cobrança agora: ${(e as Error).message}. ` +
          'Tente de novo em alguns minutos ou fale com o contato@leaoamorimtecnologia.com.br.',
      );
    } finally {
      setRetomando(false);
      void carregar();
    }
  }, [carregar]);

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="relative p-6 lg:p-9">
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <p className="rotulo">Financeiro</p>
            <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
              Minha assinatura
            </h1>
          </div>
          <button
            type="button"
            onClick={() => void carregar()}
            className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Atualizar
          </button>
        </motion.header>

        {estado.st === 'erro' && <BlocoErro msg={estado.msg} />}
        {estado.st === 'carregando' && (
          <div className="cartao p-6 text-[13px] text-muted">Carregando…</div>
        )}

        {a && tom && (
          <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
            {/* ── Plano e situação ── */}
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="cartao p-6"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="rotulo">Plano</p>
                  <h2 className="mt-1.5 font-display text-[22px] font-semibold text-ink">
                    {a.plano.nome}
                  </h2>
                  {a.plano.descricao && (
                    <p className="mt-1 text-[12px] text-muted">{a.plano.descricao}</p>
                  )}
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-3 py-1 text-[11px] font-medium',
                    tom.classe,
                  )}
                >
                  {tom.texto}
                </span>
              </div>

              <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <p className="rotulo">Mensalidade</p>
                  <p className="num mt-1 text-[19px] font-semibold text-ink">{brl(Number(a.plano.preco))}</p>
                </div>
                <div>
                  <p className="rotulo">Por ciclo</p>
                  <p className="num mt-1 text-[19px] font-semibold text-ink">
                    {a.plano.processosPorCiclo.toLocaleString('pt-BR')}
                  </p>
                  <p className="text-[11px] text-muted-2">processos novos</p>
                </div>
                <div>
                  <p className="rotulo">Próxima entrega</p>
                  <p className="num mt-1 text-[19px] font-semibold text-ink">
                    {dia(a.proximaRenovacaoEm)}
                  </p>
                </div>
              </div>

              {/* O aviso que a tela existe para dar. */}
              {(a.status === 'SUSPENSA' || a.status === 'INADIMPLENTE') && (
                <div
                  className={cn(
                    'mt-6 flex items-start gap-2.5 rounded-[12px] border p-4 text-[12px] leading-relaxed',
                    a.status === 'SUSPENSA'
                      ? 'border-erro/30 bg-erro/10 text-erro'
                      : 'border-alerta/30 bg-alerta/10 text-alerta',
                  )}
                  role="status"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {a.status === 'SUSPENSA'
                      ? 'Seu acesso à carteira está suspenso por falta de pagamento. Os seus dados continuam guardados: regularize a fatura em aberto e o acesso volta exatamente como estava.'
                      : 'Há fatura em atraso. Regularize para não ter o acesso à carteira suspenso.'}
                  </span>
                </div>
              )}

              {/**
                * PENDENTE — a assinatura recém-criada pelo site, ainda não paga.
                *
                * Estado NOVO no front: enquanto toda organização nascia por
                * script, PENDENTE durava minutos e ninguém o via. Com o
                * cadastro público ele virou a primeira tela que o cliente
                * encontra depois de comprar — e o guard passou a mandá-lo
                * para cá com 402.
                *
                * Tom NEUTRO, não de erro: ninguém está devendo nem foi
                * suspenso. Pintar de vermelho o cliente que acabou de assinar
                * e só não terminou o boleto seria receber com um alarme.
                *
                * O botão sai da fatura em aberto, e não de um estado guardado
                * na tela: se o cliente fechar a aba do Asaas e voltar dias
                * depois, o link continua onde sempre esteve — na fatura.
                */}
              {/* ── TRÊS ESTADOS, NÃO DOIS ──
                  Havia um ternário só, decidido por "existe link?". O `else`
                  atendia DUAS situações muito diferentes com a mesma frase:
                  a fatura órfã (existe, mas o gateway recusou a cobrança) e a
                  ausência de fatura. Nos dois casos ele afirmava que o acesso
                  abriria sozinho e que não era preciso fazer nada — e na órfã
                  isso é falso: não há cobrança do outro lado, nada vai
                  confirmar, e o cliente esperaria para sempre.

                  Aconteceu com o primeiro cliente real. */}
              {a.status === 'PENDENTE' && (
                <div
                  className={`mt-6 flex items-start gap-2.5 rounded-[12px] border p-4 text-[12px] leading-relaxed text-ink-2 ${
                    comLink ? 'border-marca-ciano/30 bg-marca-ciano/[0.07]' : 'border-alerta/30 bg-alerta/[0.07]'
                  }`}
                  role="status"
                >
                  {comLink ? (
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-marca-ciano" aria-hidden />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alerta" aria-hidden />
                  )}
                  <div>
                    <p>
                      {comLink
                        ? 'Falta concluir o pagamento para liberar o acesso à sua carteira. O link abaixo continua válido.'
                        : retomavel
                          ? 'A sua fatura foi criada, mas a cobrança não chegou a ser aberta. Nada será confirmado sozinho — gere a cobrança abaixo para pagar.'
                          : 'A sua primeira fatura ainda não foi emitida. Se isso persistir, fale com a gente pelo contato@leaoamorimtecnologia.com.br.'}
                    </p>

                    {comLink && (
                      <a
                        href={comLink.urlPagamento!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-sm bg-marca px-4 py-2 text-[12px] font-semibold text-white shadow-brilho transition-transform hover:scale-[1.02]"
                      >
                        Concluir pagamento
                      </a>
                    )}

                    {!comLink && retomavel && (
                      <button
                        type="button"
                        onClick={() => void retomar()}
                        disabled={retomando}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-sm bg-marca px-4 py-2 text-[12px] font-semibold text-white shadow-brilho transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {retomando ? 'Gerando…' : 'Gerar cobrança'}
                      </button>
                    )}

                    {erroRetomada && (
                      <p className="mt-2 text-[12px] text-erro" role="alert">
                        {erroRetomada}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {a.status === 'ATIVA' && emAberto.length === 0 && (
                <p className="mt-6 flex items-center gap-2 text-[12px] text-ok">
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Tudo em dia. Nada a pagar no momento.
                </p>
              )}
            </motion.section>

            {/* ── Faturas ── */}
            <motion.section
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="cartao p-6"
              aria-labelledby="titulo-faturas"
            >
              <h2 id="titulo-faturas" className="font-display text-[15px] font-medium text-ink">
                Faturas
              </h2>

              {a.faturas.length === 0 ? (
                <Vazio
                  Icone={CreditCard}
                  titulo="Nenhuma fatura ainda"
                  descricao="A primeira será emitida no fechamento do seu ciclo."
                />
              ) : (
                <ul className="mt-4 divide-y divide-linha">
                  {a.faturas.map((f) => (
                    <li key={f.id} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] text-ink-2">{mes(f.competencia)}</p>
                        <p className="text-[11px] text-muted-2">
                          {f.status === 'PAGA'
                            ? `Paga em ${dia(f.pagoEm)}`
                            : `Vence em ${dia(f.vencimentoEm)}`}
                        </p>
                      </div>
                      <span className="num shrink-0 text-[13px] text-ink">{brl(Number(f.valor))}</span>
                      <span
                        className={cn(
                          'w-[74px] shrink-0 text-right text-[11px] font-medium',
                          TOM_FATURA[f.status],
                        )}
                      >
                        {f.status.charAt(0) + f.status.slice(1).toLowerCase()}
                      </span>
                      {/* Só aparece quando há link de pagamento — no modo manual
                          não há, e um botão morto seria pior que botão nenhum. */}
                      {f.urlPagamento && f.status !== 'PAGA' ? (
                        <a
                          href={f.urlPagamento}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-linha px-3 text-[11px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
                        >
                          Pagar
                          <ExternalLink className="h-3 w-3" aria-hidden />
                        </a>
                      ) : (
                        <span className="w-[62px] shrink-0" />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </motion.section>
          </div>
        )}
      </div>
    </div>
  );
}
