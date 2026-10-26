'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, RefreshCw, Receipt, CalendarClock, FilePlus2, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { brl, cn } from '@/lib/utils';
import { CARREGANDO, type Estado, BlocoErro, Vazio } from '@/components/estado';

type StatusFatura = 'ABERTA' | 'PAGA' | 'VENCIDA' | 'CANCELADA' | 'ESTORNADA';

interface FaturaAdmin {
  id: string;
  competencia: string;
  valor: string;
  status: StatusFatura;
  vencimentoEm: string;
  pagoEm: string | null;
  cliente: { id: string; nome: string };
  statusAssinatura: string;
}

interface ClienteResumo {
  organizationId: string;
  nome: string;
  assinatura: { status: string } | null;
}

const dia = (iso: string | null) =>
  iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';
const mes = (iso: string) => {
  const [ano, m] = String(iso).slice(0, 7).split('-');
  return `${m}/${ano}`;
};

const TOM_FATURA: Record<StatusFatura, string> = {
  PAGA: 'border-ok/30 bg-ok/10 text-ok',
  ABERTA: 'border-linha bg-superficie text-ink-2',
  VENCIDA: 'border-erro/30 bg-erro/10 text-erro',
  CANCELADA: 'border-linha bg-superficie text-muted',
  ESTORNADA: 'border-linha bg-superficie text-muted',
};

const FILTROS: { rotulo: string; valor: '' | StatusFatura }[] = [
  { rotulo: 'Todas', valor: '' },
  { rotulo: 'Abertas', valor: 'ABERTA' },
  { rotulo: 'Vencidas', valor: 'VENCIDA' },
  { rotulo: 'Pagas', valor: 'PAGA' },
];

export default function CobrancaPage() {
  const [faturas, setFaturas] = useState<Estado<FaturaAdmin[]>>(CARREGANDO);
  const [clientes, setClientes] = useState<ClienteResumo[]>([]);
  const [filtro, setFiltro] = useState<'' | StatusFatura>('');
  const [alvo, setAlvo] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  const carregar = useCallback(async (status: '' | StatusFatura) => {
    const [f, c] = await Promise.allSettled([
      api<FaturaAdmin[]>(`/cobranca/faturas${status ? `?status=${status}` : ''}`),
      api<ClienteResumo[]>('/distribuicao/clientes'),
    ]);
    setFaturas(
      f.status === 'fulfilled'
        ? { st: 'ok', dados: f.value }
        : { st: 'erro', msg: (f.reason as Error)?.message ?? 'Falha ao carregar' },
    );
    if (c.status === 'fulfilled') {
      setClientes(c.value);
      setAlvo((a) => a || (c.value.find((x) => x.assinatura)?.organizationId ?? ''));
    }
  }, []);

  useEffect(() => {
    void carregar(filtro);
  }, [carregar, filtro]);

  /* Agregado do que está na tela. Some só o que NÃO está pago — é o número que
     responde "quanto tenho a receber", e incluir o pago o transformaria em
     faturamento histórico, que é outra pergunta. */
  const totais = useMemo(() => {
    const lista = faturas.st === 'ok' ? faturas.dados : [];
    const soma = (s: StatusFatura) =>
      lista.filter((f) => f.status === s).reduce((t, f) => t + Number(f.valor), 0);
    return {
      aberto: soma('ABERTA'),
      vencido: soma('VENCIDA'),
      pago: soma('PAGA'),
      qtdVencidas: lista.filter((f) => f.status === 'VENCIDA').length,
    };
  }, [faturas]);

  async function emitir() {
    if (!alvo || ocupado) return;
    setOcupado('emitir');
    setAviso(null);
    try {
      const r = await api<{ emitida: boolean; motivo?: string; competencia: string; valor?: string }>(
        `/cobranca/clientes/${alvo}/fatura`,
        { method: 'POST' },
      );
      setAviso(
        r.emitida
          ? { tipo: 'ok', texto: `Fatura de ${mes(r.competencia)} emitida (${brl(Number(r.valor))}).` }
          : { tipo: 'erro', texto: r.motivo ?? 'Nada emitido.' },
      );
      await carregar(filtro);
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function darBaixa(id: string) {
    if (ocupado) return;
    setOcupado(`baixa-${id}`);
    setAviso(null);
    try {
      const r = await api<{ alterado: boolean; assinatura?: string }>(
        `/cobranca/faturas/${id}/pagamento`,
        { method: 'POST' },
      );
      setAviso({
        tipo: 'ok',
        texto: r.alterado
          ? `Baixa registrada.${r.assinatura ? ` Assinatura: ${r.assinatura.toLowerCase()}.` : ''}`
          : 'A fatura já estava paga.',
      });
      await carregar(filtro);
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function rodarVencimentos() {
    if (ocupado) return;
    setOcupado('vencimentos');
    setAviso(null);
    try {
      const r = await api<{ vencidas: number; inadimplentes: number; suspensas: number }>(
        '/cobranca/vencimentos',
        { method: 'POST' },
      );
      setAviso({
        tipo: r.suspensas > 0 ? 'erro' : 'ok',
        texto: `${r.vencidas} fatura(s) vencida(s) · ${r.inadimplentes} assinatura(s) em atraso · ${r.suspensas} suspensa(s).`,
      });
      await carregar(filtro);
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

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
              Cobrança
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => void carregar(filtro)}
              className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Atualizar
            </button>
            {/* Consequente: pode SUSPENDER cliente. Fica visualmente contido. */}
            <button
              type="button"
              onClick={() => void rodarVencimentos()}
              disabled={ocupado !== null}
              className="flex h-9 items-center gap-2 rounded-full border border-alerta/40 px-4 text-[12px] text-alerta transition-colors hover:bg-alerta/10 disabled:opacity-45"
              title="Vence faturas atrasadas, marca inadimplentes e suspende quem passou da carência"
            >
              {ocupado === 'vencimentos' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              )}
              Rodar vencimentos
            </button>
          </div>
        </motion.header>

        {aviso && (
          <div
            role="status"
            className={cn(
              'mb-5 rounded-[12px] border p-4 text-[12px]',
              aviso.tipo === 'ok'
                ? 'border-ok/30 bg-ok/10 text-ok'
                : 'border-erro/30 bg-erro/10 text-erro',
            )}
          >
            {aviso.texto}
          </div>
        )}

        {/* ── Totais do recorte em tela ── */}
        <div className="mb-5 grid gap-4 sm:grid-cols-3">
          {[
            { rotulo: 'A receber (em aberto)', valor: totais.aberto, tom: 'text-ink' },
            {
              rotulo: `Em atraso${totais.qtdVencidas ? ` · ${totais.qtdVencidas}` : ''}`,
              valor: totais.vencido,
              tom: totais.vencido > 0 ? 'text-erro' : 'text-ink',
            },
            { rotulo: 'Recebido (no recorte)', valor: totais.pago, tom: 'text-ok' },
          ].map((k, i) => (
            <motion.div
              key={k.rotulo}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 * i, duration: 0.5 }}
              className="cartao p-5"
            >
              <p className="rotulo">{k.rotulo}</p>
              <p className={cn('num mt-1.5 font-display text-[24px] font-semibold', k.tom)}>
                {brl(k.valor)}
              </p>
            </motion.div>
          ))}
        </div>

        {/* ── Emitir fatura ── */}
        <section className="cartao mb-5 flex flex-wrap items-end gap-3 p-5">
          <label className="block min-w-[240px] flex-1">
            <span className="rotulo">Emitir fatura do ciclo para</span>
            <select
              value={alvo}
              onChange={(e) => setAlvo(e.target.value)}
              className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
            >
              {clientes.filter((c) => c.assinatura).length === 0 && (
                <option value="">Nenhum cliente com assinatura</option>
              )}
              {clientes
                .filter((c) => c.assinatura)
                .map((c) => (
                  <option key={c.organizationId} value={c.organizationId}>
                    {c.nome} — {c.assinatura!.status.toLowerCase()}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void emitir()}
            disabled={!alvo || ocupado !== null}
            className="flex h-10 items-center gap-2 rounded-full bg-marca px-5 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
          >
            {ocupado === 'emitir' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Emitir
          </button>
          <p className="w-full text-[11px] text-muted">
            Uma fatura por competência: repetir no mesmo mês não duplica nada.
          </p>
        </section>

        {/* ── Filtros ── */}
        <div className="mb-4 flex flex-wrap gap-2">
          {FILTROS.map((f) => (
            <button
              key={f.rotulo}
              type="button"
              onClick={() => setFiltro(f.valor)}
              className={cn(
                'h-8 rounded-full border px-3.5 text-[12px] transition-colors',
                filtro === f.valor
                  ? 'border-marca-ciano/40 bg-marca-ciano/10 text-marca-ciano'
                  : 'border-linha text-muted hover:text-ink-2',
              )}
            >
              {f.rotulo}
            </button>
          ))}
        </div>

        {/* ── Faturas ── */}
        {faturas.st === 'erro' && <BlocoErro msg={faturas.msg} />}
        {faturas.st === 'carregando' && (
          <div className="cartao p-6 text-[13px] text-muted">Carregando…</div>
        )}
        {faturas.st === 'ok' && faturas.dados.length === 0 && (
          <div className="cartao">
            <Vazio
              Icone={Receipt}
              titulo="Nenhuma fatura neste recorte"
              descricao="Emita a fatura do ciclo de um cliente para começar."
            />
          </div>
        )}

        {faturas.st === 'ok' && faturas.dados.length > 0 && (
          <div className="cartao overflow-hidden">
            <ul className="divide-y divide-linha">
              {faturas.dados.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                  <div className="min-w-[180px] flex-1">
                    <p className="text-[13px] text-ink">{f.cliente.nome}</p>
                    <p className="text-[11px] text-muted-2">
                      {mes(f.competencia)} · vence {dia(f.vencimentoEm)}
                      {f.pagoEm ? ` · paga ${dia(f.pagoEm)}` : ''}
                    </p>
                  </div>
                  <span className="num shrink-0 text-[14px] text-ink">{brl(Number(f.valor))}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                      TOM_FATURA[f.status],
                    )}
                  >
                    {f.status.charAt(0) + f.status.slice(1).toLowerCase()}
                  </span>
                  <div className="w-[132px] shrink-0 text-right">
                    {f.status === 'ABERTA' || f.status === 'VENCIDA' ? (
                      <button
                        type="button"
                        onClick={() => void darBaixa(f.id)}
                        disabled={ocupado !== null}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-linha px-3 text-[11px] text-ink-2 transition-colors hover:border-ok/40 hover:text-ok disabled:opacity-45"
                      >
                        {ocupado === `baixa-${f.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <CheckCircle2 className="h-3 w-3" aria-hidden />
                        )}
                        Dar baixa
                      </button>
                    ) : (
                      <span className="text-[11px] text-muted-2">—</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
