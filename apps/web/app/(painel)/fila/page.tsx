'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  Hourglass,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import { api, type Consumo, type EstadoFila, type Previsao } from '@/lib/api';
import { brl, cn, LIMIAR_CONSUMO_CRITICO } from '@/lib/utils';
import { CartaoKpi, Contador, Esqueleto, useAnimavel } from '@/components/metricas';
import { BlocoErro, CARREGANDO, comoEstado, type Estado } from '@/components/estado';

/** A fila é estado vivo: sem repique, o painel mente sobre o que está rodando. */
const INTERVALO_POLL = 5000;

/** Contrato da API `/fila/prever` e `/fila/sincronizar-agora`. */
const LIMITE_MIN = 1;
const LIMITE_MAX = 5000;

/**
 * Número animado só quando dá para animar.
 *
 * `animar` vem de cima de propósito: instanciado aqui dentro, o hook resolveria
 * depois da primeira pintura e o valor apareceria pronto, voltaria a zero e
 * subiria de novo. No topo da página ele já está estável quando os dados chegam.
 */
function Numero({
  valor,
  formatar,
  className,
  animar,
}: {
  valor: number;
  formatar: (n: number) => string;
  className?: string;
  animar: boolean;
}) {
  if (!animar) return <span className={className}>{formatar(valor)}</span>;
  return <Contador valor={valor} formatar={formatar} className={className} />;
}

const inteiro = (n: number) => Math.round(n).toLocaleString('pt-BR');

/** Passo numerado do fluxo de disparo. */
function Passo({
  n,
  titulo,
  descricao,
  ativo,
  concluido,
  perigo,
  ultimo,
  children,
}: {
  n: number;
  titulo: string;
  descricao: string;
  ativo: boolean;
  concluido?: boolean;
  perigo?: boolean;
  ultimo?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="relative pl-11 sm:pl-12">
      {/* Trilho vertical ligando os passos — dá ao fluxo cara de sequência
          obrigatória, não de três botões independentes. */}
      {!ultimo && (
        <span
          aria-hidden
          className="absolute left-[15px] top-9 h-[calc(100%-1.75rem)] w-px bg-linha"
        />
      )}
      <span
        aria-hidden
        className={cn(
          'absolute left-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border font-display text-[13px] font-semibold',
          concluido
            ? 'border-ok/40 bg-ok/15 text-ok'
            : ativo
              ? perigo
                ? 'border-alerta/50 bg-alerta/15 text-alerta'
                : 'border-marca-ciano/40 bg-marca-ciano/10 text-marca-ciano'
              : 'border-linha bg-superficie text-muted',
        )}
      >
        {concluido ? <CheckCircle2 className="h-4 w-4" /> : n}
      </span>

      <h3 className="font-display text-[14px] font-semibold text-ink">{titulo}</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">{descricao}</p>
      <div className="mt-4">{children}</div>
    </li>
  );
}

export default function FilaPage() {
  const [fila, setFila] = useState<Estado<EstadoFila>>(CARREGANDO);
  const [consumo, setConsumo] = useState<Estado<Consumo>>(CARREGANDO);

  /* Guardado como texto para que o campo possa ficar vazio enquanto se digita.
     Clampar a cada tecla impedia apagar o valor para redigitá-lo. */
  const [limiteTexto, setLimiteTexto] = useState('50');
  const [previsao, setPrevisao] = useState<Previsao | null>(null);
  const [confirmado, setConfirmado] = useState(false);
  const [ocupado, setOcupado] = useState<'prever' | 'disparar' | 'reprocessar' | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  const animar = useAnimavel();
  const vivo = useRef(true);

  const limite = Number(limiteTexto);
  const limiteValido =
    limiteTexto.trim() !== '' &&
    Number.isInteger(limite) &&
    limite >= LIMITE_MIN &&
    limite <= LIMITE_MAX;

  const carregar = useCallback(async () => {
    /* allSettled: Redis fora derruba a fila, mas o teto de consumo — o número
       que protege a conta — continua na tela. */
    const [f, c] = await Promise.allSettled([
      api<EstadoFila>('/fila/estado'),
      api<Consumo>('/fila/consumo'),
    ]);
    if (!vivo.current) return;
    setFila(comoEstado(f));
    setConsumo(comoEstado(c));
  }, []);

  useEffect(() => {
    vivo.current = true;
    void carregar();
    const t = setInterval(() => void carregar(), INTERVALO_POLL);
    return () => {
      vivo.current = false;
      clearInterval(t);
    };
  }, [carregar]);

  /**
   * Toda mudança de limite invalida a previsão.
   *
   * É a trava que faltava no incidente das 107 consultas: prever com 50,
   * trocar para 5000 e confirmar disparava 5000 sob um número que dizia 50.
   */
  function alterarLimite(v: string) {
    setLimiteTexto(v);
    setPrevisao(null);
    setConfirmado(false);
  }

  async function prever() {
    if (!limiteValido || ocupado) return;
    setOcupado('prever');
    setAviso(null);
    setConfirmado(false);
    try {
      setPrevisao(
        await api<Previsao>('/fila/prever', {
          method: 'POST',
          body: JSON.stringify({ limite }),
        }),
      );
    } catch (e) {
      setPrevisao(null);
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function disparar() {
    if (!previsao || !limiteValido || ocupado) return;
    if (!previsao.dryRun && !confirmado) return; // segunda trava, além do disabled
    setOcupado('disparar');
    setAviso(null);
    try {
      /* Dispara o MENOR entre o limite e o que foi previsto — nunca mais que o
         confirmado. `prever()` limita por elegíveis, `executar()` não: com
         limite 5000 e 50 elegíveis, o usuário confirma "50" e autorizaria até
         5000 consultas cobradas se a base mudasse entre a simulação e o clique. */
      const autorizado = Math.min(limite, previsao.quantidade);
      const r = await api<{ enfileirados: number; motivo?: string }>('/fila/sincronizar-agora', {
        method: 'POST',
        body: JSON.stringify({ limite: autorizado }),
      });
      /* Recusa do servidor (teto consumido, ninguém pendente) vinha com ícone
         verde de sucesso. Zero enfileirados com motivo é aviso, não conquista. */
      setAviso(
        r.enfileirados === 0 && r.motivo
          ? { tipo: 'erro', texto: r.motivo }
          : {
              tipo: 'ok',
              texto: `${r.enfileirados.toLocaleString('pt-BR')} consulta(s) enfileirada(s).`,
            },
      );
      setPrevisao(null);
      setConfirmado(false);
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function reprocessar() {
    if (ocupado) return;
    setOcupado('reprocessar');
    setAviso(null);
    try {
      await api('/fila/reprocessar', { method: 'POST' });
      setAviso({ tipo: 'ok', texto: 'Falhas devolvidas à fila.' });
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  const pct = consumo.st === 'ok' ? consumo.dados.percentual : 0;
  const critico = pct >= LIMIAR_CONSUMO_CRITICO;
  const ativos = fila.st === 'ok' ? fila.dados.ativos : 0;
  const falhos = fila.st === 'ok' ? fila.dados.falhos : 0;

  /**
   * A fila responde 200 mesmo com o Redis fora — com `disponivel: false` e os
   * contadores ZERADOS. Sem esta distinção a tela mostraria "0 aguardando, 0
   * ativos" e alguém concluiria que o enriquecimento terminou. `undefined` é o
   * default seguro: resposta antiga, sem o campo, continua sendo tratada como
   * disponível.
   */
  const filaIndisponivel = fila.st === 'ok' && fila.dados.disponivel === false;

  const contadores = [
    { r: 'Aguardando', v: fila.st === 'ok' ? fila.dados.aguardando : 0, I: Hourglass, c: 'text-ink' },
    { r: 'Ativos', v: ativos, I: Activity, c: 'text-marca-ciano' },
    { r: 'Concluídos', v: fila.st === 'ok' ? fila.dados.concluidos : 0, I: CheckCircle2, c: 'text-ok' },
    { r: 'Falhos', v: falhos, I: XCircle, c: falhos > 0 ? 'text-erro' : 'text-ink' },
    {
      r: 'Atrasados',
      v: fila.st === 'ok' ? fila.dados.atrasados : 0,
      I: Clock,
      c: fila.st === 'ok' && fila.dados.atrasados > 0 ? 'text-alerta' : 'text-ink',
    },
  ];

  return (
    <div className="relative min-h-screen">
      {/* Aurora ambiente — mesmo mundo visual do restante do painel */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute -right-40 -top-40 h-[36rem] w-[36rem] rounded-full opacity-[0.13] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#6366f1,transparent 68%)' }}
          animate={{ x: [0, -40, 0], y: [0, 40, 0] }}
          transition={{ duration: 24, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -left-32 top-1/2 h-[30rem] w-[30rem] rounded-full opacity-[0.1] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#22d3ee,transparent 68%)' }}
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 28, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
        />
      </div>

      <div className="relative p-6 lg:p-9">
        {/* ── Cabeçalho ── */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <p className="rotulo">Processamento</p>
            <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
              Fila e consumo
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {fila.st === 'ok' && (
              <div className="flex items-center gap-2.5 rounded-full border border-linha bg-vidro px-4 py-2 backdrop-blur-xl">
                <span className="relative flex h-2 w-2">
                  {ativos > 0 && (
                    <span
                      aria-hidden
                      className="absolute inline-flex h-full w-full animate-ping rounded-full bg-marca-ciano opacity-60"
                    />
                  )}
                  <span
                    aria-hidden
                    className={cn(
                      'relative inline-flex h-2 w-2 rounded-full',
                      ativos > 0 ? 'bg-marca-ciano' : 'bg-muted',
                    )}
                  />
                </span>
                <span className="text-[12px] text-ink-2">
                  {ativos > 0 ? `${inteiro(ativos)} em processamento` : 'Fila ociosa'}
                </span>
              </div>
            )}
            <button
              type="button"
              onClick={() => void carregar()}
              className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Atualizar
            </button>
          </div>
        </motion.header>

        {/* ── Teto diário: a informação que protege a conta ── */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className={cn('cartao p-6', critico && 'border-alerta/35 ring-1 ring-alerta/20')}
        >
          <div className="mb-5 flex flex-wrap items-center gap-2.5">
            <Gauge className={cn('h-4 w-4', critico ? 'text-alerta' : 'text-marca-ciano')} aria-hidden />
            <h2 className="font-display text-sm font-semibold text-ink">Teto diário de consultas</h2>
            <span className="rotulo ml-auto">
              {consumo.st === 'ok' ? consumo.dados.provider : 'provedor —'}
            </span>
          </div>

          {consumo.st === 'carregando' && <Esqueleto className="h-24" />}

          {consumo.st === 'erro' && (
            <BlocoErro
              msg={`Consumo indisponível: ${consumo.msg}. Sem este número não há como saber quanto ainda pode ser gasto hoje — não dispare consultas às cegas.`}
            />
          )}

          {consumo.st === 'ok' && (
            <>
              <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
                <div>
                  <p className="rotulo">Restantes hoje</p>
                  <Numero
                    animar={animar}
                    valor={consumo.dados.restantes}
                    formatar={inteiro}
                    className={cn(
                      'num mt-1.5 block font-display text-[34px] font-semibold leading-none',
                      critico ? 'text-alerta' : 'texto-marca',
                    )}
                  />
                </div>
                <div className="flex flex-wrap gap-x-8 gap-y-4">
                  <div>
                    <p className="rotulo">Usadas</p>
                    <p className="num mt-1.5 font-display text-lg font-semibold text-ink">
                      {inteiro(consumo.dados.usadas)}
                    </p>
                  </div>
                  <div>
                    <p className="rotulo">Teto</p>
                    <p className="num mt-1.5 font-display text-lg font-semibold text-ink-2">
                      {inteiro(consumo.dados.teto)}
                    </p>
                  </div>
                  <div>
                    <p className="rotulo">Consumido</p>
                    <p
                      className={cn(
                        'num mt-1.5 font-display text-lg font-semibold',
                        critico ? 'text-alerta' : 'text-ink',
                      )}
                    >
                      {pct.toFixed(0)}%
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6">
                <div
                  className="relative h-2.5 overflow-hidden rounded-full bg-superficie-2"
                  role="progressbar"
                  aria-valuenow={Math.round(pct)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Consumo do teto diário de consultas"
                >
                  <motion.div
                    className={cn('h-full rounded-full', critico ? 'bg-alerta' : 'bg-marca')}
                    initial={{ width: animar ? 0 : `${Math.min(pct, 100)}%` }}
                    animate={{ width: `${Math.min(pct, 100)}%` }}
                    transition={{
                      duration: animar ? 1.1 : 0,
                      ease: [0.16, 1, 0.3, 1],
                      delay: animar ? 0.3 : 0,
                    }}
                  />
                  {/* Marca do limiar: mostra onde o consumo vira crítico antes de virar. */}
                  <span
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-ink/45"
                    style={{ left: `${LIMIAR_CONSUMO_CRITICO}%` }}
                  />
                </div>
                <p
                  className="num mt-2 text-[11px] text-muted-2"
                  style={{ marginLeft: `min(${LIMIAR_CONSUMO_CRITICO}%, calc(100% - 5rem))` }}
                >
                  limiar {LIMIAR_CONSUMO_CRITICO}%
                </p>
              </div>

              {critico && (
                <p className="mt-4 flex items-start gap-2 rounded-sm bg-alerta/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-alerta">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Teto diário quase esgotado — restam {inteiro(consumo.dados.restantes)} consultas.
                  Reduza o limite da rodada ou aguarde a virada do dia.
                </p>
              )}
            </>
          )}
        </motion.section>

        {/* A fila responde 200 mesmo fora do ar, com os contadores zerados —
            sem este aviso, "0 aguardando" passaria por "acabou". */}
        {filaIndisponivel && (
          <div
            role="alert"
            className="mt-5 flex items-start gap-2.5 rounded-[12px] border border-alerta/30 bg-alerta/10 p-4"
          >
            <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-alerta" />
            <div className="text-[13px] leading-relaxed text-ink-2">
              <strong className="text-alerta">Fila indisponível.</strong>{' '}
              {fila.st === 'ok' && fila.dados.motivo}{' '}
              Os números abaixo não são reais — o serviço de filas não respondeu.
              <span className="mt-1 block text-[12px] text-muted">
                Nada foi perdido: as pessoas seguem pendentes e a sincronização diária as retoma
                quando o serviço voltar.
              </span>
            </div>
          </div>
        )}

        {/* ── Contadores da fila ── */}
        <div className="mt-5 grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
          {contadores.map((x, i) => (
            <CartaoKpi key={x.r} Icone={x.I} rotulo={x.r} indice={i}>
              {fila.st === 'carregando' && <Esqueleto className="h-7 w-1/2" />}
              {fila.st === 'erro' && <p className="num font-display text-2xl text-muted">—</p>}
              {fila.st === 'ok' && (
                <Numero
                  animar={animar}
                  valor={x.v}
                  formatar={inteiro}
                  className={cn('num block font-display text-2xl font-semibold leading-none', x.c)}
                />
              )}
            </CartaoKpi>
          ))}
        </div>

        {fila.st === 'erro' && (
          <BlocoErro
            className="mt-4"
            msg={`Fila indisponível: ${fila.msg}. Verifique se o Redis está no ar — os contadores acima não refletem a realidade.`}
          />
        )}

        {/* ── Disparo em três passos ── */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mt-5 cartao p-6"
        >
          <div className="mb-2 flex flex-wrap items-center gap-2.5">
            <Zap className="h-4 w-4 text-aurora-2" aria-hidden />
            <h2 className="font-display text-sm font-semibold text-ink">Sincronizar carteira</h2>
            <button
              type="button"
              onClick={() => void reprocessar()}
              disabled={ocupado !== null}
              className="ml-auto flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
            >
              {ocupado === 'reprocessar' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              )}
              Reprocessar falhas
            </button>
          </div>
          <p className="text-[12px] leading-relaxed text-muted">
            Cada consulta é cobrada pelo provedor. A previsão abaixo é obrigatória: o botão de
            disparo real só existe depois dela.
          </p>

          <ol className="mt-7 space-y-8">
            {/* Passo 1 — limite */}
            <Passo
              n={1}
              titulo="Defina o limite da rodada"
              descricao={`Obrigatório, de ${LIMITE_MIN} a ${LIMITE_MAX.toLocaleString('pt-BR')} consultas. Alterar o limite descarta a previsão já feita.`}
              ativo
              concluido={limiteValido}
            >
              <div className="max-w-xs">
                <label htmlFor="limite" className="rotulo mb-2 block">
                  Limite desta rodada
                </label>
                <input
                  id="limite"
                  type="number"
                  inputMode="numeric"
                  min={LIMITE_MIN}
                  max={LIMITE_MAX}
                  step={1}
                  required
                  value={limiteTexto}
                  onChange={(e) => alterarLimite(e.target.value)}
                  aria-invalid={!limiteValido}
                  aria-describedby="limite-ajuda"
                  className={cn(
                    'num h-11 w-full rounded-sm border bg-superficie px-3.5 text-sm text-ink transition-colors',
                    limiteValido
                      ? 'border-linha hover:border-linha-2'
                      : 'border-erro/60 hover:border-erro',
                  )}
                />
                <p
                  id="limite-ajuda"
                  className={cn('mt-2 text-[12px]', limiteValido ? 'text-muted' : 'text-erro')}
                  role={limiteValido ? undefined : 'alert'}
                >
                  {limiteValido
                    ? `Serão avaliadas até ${inteiro(limite)} pessoas nesta rodada.`
                    : `Informe um número inteiro entre ${LIMITE_MIN} e ${LIMITE_MAX.toLocaleString('pt-BR')}.`}
                </p>
              </div>
            </Passo>

            {/* Passo 2 — previsão */}
            <Passo
              n={2}
              titulo="Simule antes de gastar"
              descricao="A previsão não consome crédito. Mostra quantas consultas seriam feitas, quanto sobra do teto e o custo estimado."
              ativo={limiteValido}
              concluido={previsao !== null}
            >
              <button
                type="button"
                onClick={() => void prever()}
                disabled={!limiteValido || ocupado !== null}
                className="flex h-11 items-center gap-2 rounded-sm border border-marca-ciano/40 bg-marca-ciano/10 px-5 font-display text-sm font-semibold text-marca-ciano transition-all hover:bg-marca-ciano/15 hover:shadow-brilho-ciano disabled:opacity-45 disabled:hover:shadow-none"
              >
                {ocupado === 'prever' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                )}
                Simular rodada
              </button>

              {previsao && (
                <div className="mt-5 animate-surgir rounded-sm border border-linha bg-superficie p-5">
                  <div className="grid gap-x-8 gap-y-4 grid-cols-2 sm:grid-cols-4">
                    <Info
                      rotulo="Consultas"
                      valor={inteiro(previsao.quantidade)}
                      destaque
                      perigo={!previsao.dryRun}
                    />
                    <Info rotulo="Elegíveis" valor={inteiro(previsao.elegiveis)} />
                    <Info rotulo="Teto restante" valor={inteiro(previsao.tetoRestante)} />
                    <Info
                      rotulo="Custo estimado"
                      valor={
                        previsao.custoEstimado === null
                          ? 'preço não configurado'
                          : brl(previsao.custoEstimado)
                      }
                    />
                  </div>

                  {previsao.observacao && (
                    <p className="mt-4 flex items-start gap-2 text-[12px] leading-relaxed text-alerta">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      {previsao.observacao}
                    </p>
                  )}

                  {previsao.dryRun ? (
                    <p className="mt-4 flex items-start gap-2 rounded-sm bg-ok/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-ok">
                      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      Modo simulação ativo (SYNC_DRY_RUN): a fila roda sem consumir crédito.
                    </p>
                  ) : (
                    <p className="mt-4 flex items-start gap-2 rounded-sm bg-alerta/10 px-3.5 py-2.5 text-[12px] leading-relaxed text-alerta">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                      Modo real: estas consultas serão cobradas por {previsao.provider}.
                    </p>
                  )}
                </div>
              )}
            </Passo>

            {/* Passo 3 — disparo */}
            <Passo
              n={3}
              titulo={previsao?.dryRun === false ? 'Confirme o disparo real' : 'Dispare a rodada'}
              descricao="Só é possível disparar exatamente o que foi previsto no passo anterior."
              ativo={previsao !== null}
              perigo={previsao?.dryRun === false}
              ultimo
            >
              {!previsao ? (
                <p className="flex items-start gap-2 rounded-sm border border-linha bg-superficie px-3.5 py-3 text-[12px] leading-relaxed text-muted">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  Bloqueado até a simulação do passo 2.
                </p>
              ) : (
                <>
                  {/* Em modo real, o aceite explícito é a última barreira antes do custo. */}
                  {!previsao.dryRun && (
                    <label className="mb-4 flex max-w-xl cursor-pointer items-start gap-3 rounded-sm border border-alerta/35 bg-alerta/[0.07] p-3.5">
                      <input
                        type="checkbox"
                        checked={confirmado}
                        onChange={(e) => setConfirmado(e.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-alerta"
                      />
                      <span className="text-[12px] leading-relaxed text-ink-2">
                        Confirmo o disparo de{' '}
                        <span className="num font-semibold text-alerta">
                          {inteiro(previsao.quantidade)}
                        </span>{' '}
                        consulta(s) reais, cobradas por {previsao.provider}
                        {previsao.custoEstimado !== null && (
                          <>
                            {' '}
                            (aprox.{' '}
                            <span className="num font-semibold text-alerta">
                              {brl(previsao.custoEstimado)}
                            </span>
                            )
                          </>
                        )}
                        .
                      </span>
                    </label>
                  )}

                  <button
                    type="button"
                    onClick={() => void disparar()}
                    disabled={
                      ocupado !== null ||
                      previsao.quantidade === 0 ||
                      !limiteValido ||
                      (!previsao.dryRun && !confirmado)
                    }
                    className={cn(
                      'flex h-12 items-center gap-2.5 rounded-sm px-6 font-display text-sm font-semibold transition-all',
                        /* Sem opacity: ela desbota fundo e texto juntos e o rotulo
                           do disparo caia para ~2:1. Cores explicitas mantem 4,5:1. */
                        'disabled:cursor-not-allowed disabled:bg-superficie-2 disabled:text-muted disabled:shadow-none disabled:hover:brightness-100',
                      previsao.dryRun
                        ? 'bg-marca text-[#05070f] hover:shadow-brilho'
                        : 'bg-alerta text-[#1a1200] shadow-[0_0_0_2px_rgba(245,158,11,.3)] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-marca-ciano/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                    )}
                  >
                    {ocupado === 'disparar' ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : previsao.dryRun ? (
                      <Play className="h-4 w-4" aria-hidden />
                    ) : (
                      <AlertTriangle className="h-4 w-4" aria-hidden />
                    )}
                    {previsao.dryRun
                      ? `Simular ${inteiro(previsao.quantidade)} consulta(s)`
                      : `Disparar ${inteiro(previsao.quantidade)} consulta(s) cobrada(s)`}
                  </button>

                  {previsao.quantidade === 0 && (
                    <p className="mt-3 text-[12px] text-muted">
                      Nada a enfileirar: nenhuma pessoa elegível dentro deste limite.
                    </p>
                  )}
                </>
              )}
            </Passo>
          </ol>

          {aviso && (
            <p
              role="status"
              className={cn(
                'mt-7 flex items-start gap-2 rounded-sm px-3.5 py-2.5 text-[12px] leading-relaxed',
                aviso.tipo === 'ok' ? 'bg-ok/10 text-ok' : 'bg-erro/10 text-erro',
              )}
            >
              {aviso.tipo === 'ok' ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              ) : (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {aviso.texto}
            </p>
          )}
        </motion.section>
      </div>
    </div>
  );
}

function Info({
  rotulo,
  valor,
  destaque,
  perigo,
}: {
  rotulo: string;
  valor: string;
  destaque?: boolean;
  perigo?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="rotulo">{rotulo}</p>
      <p
        className={cn(
          'num mt-1.5 truncate font-display font-semibold',
          destaque
            ? perigo
              ? 'text-xl text-alerta'
              : 'text-xl texto-marca'
            : 'text-[15px] text-ink',
        )}
        title={valor}
      >
        {valor}
      </p>
    </div>
  );
}
