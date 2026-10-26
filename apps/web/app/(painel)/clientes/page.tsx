'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Building2,
  Loader2,
  Plus,
  RefreshCw,
  KeyRound,
  Copy,
  Check,
  PackagePlus,
  History,
} from 'lucide-react';
import { api } from '@/lib/api';
import { ExcluirCliente } from '@/components/excluir-cliente';
import { brl, cn } from '@/lib/utils';
import { CARREGANDO, type Estado, BlocoErro, Vazio } from '@/components/estado';

interface Plano {
  id: string;
  nome: string;
  descricao: string | null;
  processosPorCiclo: number;
  preco: string;
  intervaloMeses: number;
}

interface Cliente {
  organizationId: string;
  nome: string;
  cnpj: string | null;
  ativo: boolean;
  usuarios: number;
  processosLiberados: number;
  ciclos: number;
  assinatura: {
    id: string;
    status: string;
    proximaRenovacaoEm: string | null;
    plano: { nome: string; processosPorCiclo: number };
  } | null;
}

interface Lote {
  id: string;
  competencia: string;
  quantidadeAlvo: number;
  quantidadeLiberada: number;
  criadoEm: string;
}

interface ResultadoLote {
  gerado: boolean;
  motivo?: string;
  dryRun: boolean;
  competencia: string;
  alvo: number;
  liberados: number;
  irmaosIncluidos: number;
  restantesNaBase: number;
}

interface Acesso {
  email: string;
  senhaInicial: string;
  aviso: string;
}

const dia = (iso: string | null) =>
  iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';
const mes = (iso: string) => {
  const [ano, m] = String(iso).slice(0, 7).split('-');
  return `${m}/${ano}`;
};

const TOM_STATUS: Record<string, string> = {
  ATIVA: 'border-ok/30 bg-ok/10 text-ok',
  PENDENTE: 'border-linha bg-superficie text-muted',
  INADIMPLENTE: 'border-alerta/30 bg-alerta/10 text-alerta',
  SUSPENSA: 'border-erro/30 bg-erro/10 text-erro',
  CANCELADA: 'border-linha bg-superficie text-muted',
};

export default function ClientesPage() {
  const [clientes, setClientes] = useState<Estado<Cliente[]>>(CARREGANDO);
  const [planos, setPlanos] = useState<Plano[]>([]);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  /* Cadastro */
  const [abrirForm, setAbrirForm] = useState(false);
  const [nome, setNome] = useState('');
  const [cnpj, setCnpj] = useState('');
  const [email, setEmail] = useState('');
  const [planoId, setPlanoId] = useState('');
  const [acesso, setAcesso] = useState<Acesso | null>(null);
  const [copiado, setCopiado] = useState(false);

  /* Simulação de lote e histórico, por cliente */
  const [previa, setPrevia] = useState<Record<string, ResultadoLote>>({});
  const [lotes, setLotes] = useState<Record<string, Lote[]>>({});

  const carregar = useCallback(async () => {
    const [c, p] = await Promise.allSettled([
      api<Cliente[]>('/distribuicao/clientes'),
      api<Plano[]>('/distribuicao/planos'),
    ]);
    setClientes(
      c.status === 'fulfilled'
        ? { st: 'ok', dados: c.value }
        : { st: 'erro', msg: (c.reason as Error)?.message ?? 'Falha ao carregar' },
    );
    if (p.status === 'fulfilled') {
      setPlanos(p.value);
      setPlanoId((atual) => atual || (p.value[0]?.id ?? ''));
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function criarPlanoPadrao() {
    setOcupado('plano');
    setAviso(null);
    try {
      await api('/distribuicao/planos', {
        method: 'POST',
        body: JSON.stringify({
          nome: 'Essencial 250',
          descricao: '250 processos novos por mês',
          processosPorCiclo: 250,
          preco: 1990,
        }),
      });
      setAviso({ tipo: 'ok', texto: 'Plano "Essencial 250" criado.' });
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function cadastrar() {
    if (!nome.trim() || !planoId || ocupado) return;
    setOcupado('cadastrar');
    setAviso(null);
    setAcesso(null);
    try {
      const r = await api<{ nome: string; acesso: Acesso | null }>('/distribuicao/clientes', {
        method: 'POST',
        body: JSON.stringify({
          nome: nome.trim(),
          planoId,
          ...(cnpj.replace(/\D/g, '').length === 14 ? { cnpj: cnpj.replace(/\D/g, '') } : {}),
          ...(email.trim() ? { emailUsuario: email.trim() } : {}),
        }),
      });
      /* A senha inicial vem UMA vez. Não recarrego a lista antes de mostrá-la,
         para não haver chance de a resposta se perder num re-render. */
      setAcesso(r.acesso);
      setAviso({ tipo: 'ok', texto: `Cliente "${r.nome}" cadastrado.` });
      setNome('');
      setCnpj('');
      setEmail('');
      setAbrirForm(false);
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function simular(orgId: string) {
    setOcupado(`sim-${orgId}`);
    setAviso(null);
    try {
      const r = await api<ResultadoLote>(`/distribuicao/clientes/${orgId}/lote?dryRun=true`, {
        method: 'POST',
      });
      setPrevia((p) => ({ ...p, [orgId]: r }));
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function gerar(orgId: string) {
    if (!previa[orgId] || ocupado) return; // só confirma o que foi simulado
    setOcupado(`ger-${orgId}`);
    setAviso(null);
    try {
      const r = await api<ResultadoLote>(`/distribuicao/clientes/${orgId}/lote`, { method: 'POST' });
      setAviso(
        r.gerado
          ? {
              tipo: 'ok',
              texto: `Lote ${mes(r.competencia)}: ${r.liberados} processo(s) liberado(s).`,
            }
          : { tipo: 'erro', texto: r.motivo ?? 'Nada foi liberado.' },
      );
      setPrevia((p) => {
        const { [orgId]: _, ...resto } = p;
        return resto;
      });
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function verLotes(orgId: string) {
    setOcupado(`lot-${orgId}`);
    try {
      /* Busca ANTES de entrar no updater: o callback do setState é síncrono. */
      const historico = await api<Lote[]>(`/distribuicao/clientes/${orgId}/lotes`);
      setLotes((l) => ({ ...l, [orgId]: historico }));
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
            <p className="rotulo">Comercial</p>
            <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
              Clientes e assinaturas
            </h1>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void carregar()}
              className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Atualizar
            </button>
            <button
              type="button"
              onClick={() => setAbrirForm((v) => !v)}
              disabled={planos.length === 0}
              title={planos.length === 0 ? 'Crie um plano antes' : undefined}
              className="flex h-9 items-center gap-2 rounded-full bg-marca px-4 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Novo cliente
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

        {/* A senha aparece UMA vez — e a tela diz isso com todas as letras. */}
        {acesso && (
          <div className="mb-5 rounded-[12px] border border-marca-ciano/30 bg-marca-ciano/10 p-5">
            <p className="flex items-center gap-2 font-display text-[14px] font-medium text-ink">
              <KeyRound className="h-4 w-4 text-marca-ciano" aria-hidden />
              Credencial de primeiro acesso
            </p>
            <p className="mt-1.5 text-[12px] text-muted">{acesso.aviso}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="num rounded-[10px] border border-linha bg-superficie px-3 py-2 text-[13px] text-ink">
                {acesso.email}
              </code>
              <code className="num rounded-[10px] border border-linha bg-superficie px-3 py-2 text-[13px] text-ink">
                {acesso.senhaInicial}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`${acesso.email} / ${acesso.senhaInicial}`)
                    .then(() => {
                      setCopiado(true);
                      setTimeout(() => setCopiado(false), 2000);
                    });
                }}
                className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
              >
                {copiado ? (
                  <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copiado ? 'Copiado' : 'Copiar'}
              </button>
              <button
                type="button"
                onClick={() => setAcesso(null)}
                className="text-[12px] text-muted underline-offset-4 hover:text-ink-2 hover:underline"
              >
                Já anotei, esconder
              </button>
            </div>
          </div>
        )}

        {/* Sem plano não há venda: o caminho de saída fica na própria tela. */}
        {planos.length === 0 && clientes.st === 'ok' && (
          <div className="cartao mb-5 flex flex-wrap items-center justify-between gap-4 p-5">
            <div>
              <p className="text-[13px] text-ink-2">Nenhum plano cadastrado.</p>
              <p className="text-[12px] text-muted">
                Um cliente só pode ser cadastrado sobre um plano — ele define quantos processos
                entram por ciclo.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void criarPlanoPadrao()}
              disabled={ocupado !== null}
              className="flex h-9 items-center gap-2 rounded-full bg-marca px-4 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {ocupado === 'plano' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-3.5 w-3.5" aria-hidden />
              )}
              Criar “Essencial 250”
            </button>
          </div>
        )}

        {/* ── Cadastro ── */}
        {abrirForm && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="cartao mb-5 overflow-hidden p-6"
          >
            <h2 className="font-display text-[15px] font-medium text-ink">Novo cliente</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="rotulo">Razão social</span>
                <input
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="Advocacia Silva & Souza"
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
                />
              </label>
              <label className="block">
                <span className="rotulo">CNPJ (opcional)</span>
                <input
                  value={cnpj}
                  onChange={(e) => setCnpj(e.target.value)}
                  placeholder="00000000000000"
                  inputMode="numeric"
                  className="num mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
                />
              </label>
              <label className="block">
                <span className="rotulo">E-mail de acesso</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="socio@escritorio.com.br"
                  type="email"
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
                />
              </label>
              <label className="block">
                <span className="rotulo">Plano</span>
                <select
                  value={planoId}
                  onChange={(e) => setPlanoId(e.target.value)}
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
                >
                  {planos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome} — {p.processosPorCiclo}/ciclo — {brl(Number(p.preco))}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="mt-3 text-[11px] text-muted">
              Sem e-mail, a empresa é criada e recebe lotes, mas ninguém consegue entrar nela.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void cadastrar()}
                disabled={!nome.trim() || !planoId || ocupado !== null}
                className="flex h-9 items-center gap-2 rounded-full bg-marca px-5 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                {ocupado === 'cadastrar' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Cadastrar
              </button>
              <button
                type="button"
                onClick={() => setAbrirForm(false)}
                className="text-[12px] text-muted underline-offset-4 hover:text-ink-2 hover:underline"
              >
                Cancelar
              </button>
            </div>
          </motion.section>
        )}

        {/* ── Lista ── */}
        {clientes.st === 'erro' && <BlocoErro msg={clientes.msg} />}
        {clientes.st === 'carregando' && (
          <div className="cartao p-6 text-[13px] text-muted">Carregando…</div>
        )}
        {clientes.st === 'ok' && clientes.dados.length === 0 && (
          <div className="cartao">
            <Vazio
              Icone={Building2}
              titulo="Nenhum cliente ainda"
              descricao="Cadastre o primeiro assinante para começar a distribuir carteira."
            />
          </div>
        )}

        <div className="grid gap-4">
          {clientes.st === 'ok' &&
            clientes.dados.map((c, i) => {
              const p = previa[c.organizationId];
              const hist = lotes[c.organizationId];
              return (
                <motion.section
                  key={c.organizationId}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 * i, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="cartao p-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h2 className="font-display text-[17px] font-medium text-ink">{c.nome}</h2>
                        {c.assinatura && (
                          <span
                            className={cn(
                              'rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                              TOM_STATUS[c.assinatura.status] ?? TOM_STATUS.PENDENTE,
                            )}
                          >
                            {c.assinatura.status.charAt(0) +
                              c.assinatura.status.slice(1).toLowerCase()}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] text-muted">
                        {c.assinatura
                          ? `${c.assinatura.plano.nome} · ${c.assinatura.plano.processosPorCiclo}/ciclo · próxima entrega ${dia(c.assinatura.proximaRenovacaoEm)}`
                          : 'Sem assinatura'}
                      </p>
                    </div>

                    <div className="flex items-center gap-5 text-right">
                      <div>
                        <p className="num text-[19px] font-semibold text-ink">
                          {c.processosLiberados.toLocaleString('pt-BR')}
                        </p>
                        <p className="rotulo">Liberados</p>
                      </div>
                      <div>
                        <p className="num text-[19px] font-semibold text-ink">{c.ciclos}</p>
                        <p className="rotulo">Ciclos</p>
                      </div>
                      <div>
                        <p className="num text-[19px] font-semibold text-ink">{c.usuarios}</p>
                        <p className="rotulo">Usuários</p>
                      </div>
                    </div>
                  </div>

                  {/* Simular → confirmar. Liberar lote entrega carteira; um clique
                      só, sem prévia, seria irreversível pelo @@unique. */}
                  <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-linha pt-4">
                    <button
                      type="button"
                      onClick={() => void simular(c.organizationId)}
                      disabled={ocupado !== null || !c.assinatura}
                      className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
                    >
                      {ocupado === `sim-${c.organizationId}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <PackagePlus className="h-3.5 w-3.5" aria-hidden />
                      )}
                      Simular lote
                    </button>

                    {p && (
                      <>
                        <span className="text-[12px] text-ink-2">
                          {p.liberados > 0
                            ? `Liberaria ${p.liberados} (alvo ${p.alvo}${p.irmaosIncluidos ? `, ${p.irmaosIncluidos} por parentesco` : ''}) · restam ${p.restantesNaBase.toLocaleString('pt-BR')} na base`
                            : (p.motivo ?? 'Nada a liberar')}
                        </span>
                        {p.liberados > 0 && (
                          <button
                            type="button"
                            onClick={() => void gerar(c.organizationId)}
                            disabled={ocupado !== null}
                            className="flex h-9 items-center gap-2 rounded-full bg-marca px-4 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
                          >
                            {ocupado === `ger-${c.organizationId}` && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                            )}
                            Confirmar liberação
                          </button>
                        )}
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => void verLotes(c.organizationId)}
                      disabled={ocupado !== null || !c.assinatura}
                      className="ml-auto flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
                    >
                      {ocupado === `lot-${c.organizationId}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <History className="h-3.5 w-3.5" aria-hidden />
                      )}
                      Histórico
                    </button>

                    {/* A ação destrutiva fica por último e separada: é a única
                        aqui que não tem desfazer. A tela SONDA antes de agir e
                        mostra se vai apagar ou anonimizar — quem decide isso é
                        o servidor, a partir do histórico da conta. */}
                    <ExcluirCliente
                      organizationId={c.organizationId}
                      nome={c.nome}
                      desabilitado={ocupado !== null}
                      aoConcluir={(modo, nome) => {
                        setAviso({
                          tipo: 'ok',
                          texto:
                            modo === 'EXCLUIDA'
                              ? `Conta "${nome}" excluída.`
                              : `Conta "${nome}" anonimizada — assinatura e faturas preservadas.`,
                        });
                        void carregar();
                      }}
                    />
                  </div>

                  {hist && (
                    <div className="mt-4">
                      {hist.length === 0 ? (
                        <p className="text-[12px] text-muted">Nenhum ciclo gerado ainda.</p>
                      ) : (
                        <ul className="divide-y divide-linha text-[12px]">
                          {hist.map((l) => (
                            <li key={l.id} className="flex items-center justify-between py-2">
                              <span className="text-ink-2">{mes(l.competencia)}</span>
                              <span className="num text-muted">
                                {l.quantidadeLiberada} liberado(s) · alvo {l.quantidadeAlvo}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </motion.section>
              );
            })}
        </div>
      </div>
    </div>
  );
}
