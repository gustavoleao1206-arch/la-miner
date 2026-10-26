'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Fingerprint,
  Lock,
  Loader2,
  RotateCw,
  ScrollText,
  SearchX,
  ShieldCheck,
  UserSearch,
  Users,
  X,
} from 'lucide-react';
import {
  ErroApi,
  api,
  type ConsultaAuditoria,
  type Pagina,
  type ResumoAuditoria,
  type TrilhaCpf,
} from '@/lib/api';
import { cn, cpfFormatado } from '@/lib/utils';
import { CartaoKpi, Contador, Esqueleto, useAnimavel } from '@/components/metricas';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';

/**
 * Contrato com o módulo de auditoria da API (apps/api/src/modules/auditoria).
 *
 * Concentrado aqui de propósito: o backend foi escrito em paralelo a esta tela.
 * Se algum caminho ou nome de parâmetro divergir, o conserto é neste bloco e em
 * nenhum outro lugar do arquivo.
 */
/* Aliases dos tipos REAIS da API. Redeclarar interfaces locais foi o que deixou
   quatro divergências de contrato passarem pelo tsc: os tipos locais descreviam
   uma API que não existia, então nada podia contradizê-los. */
type PontoSerie = ResumoAuditoria['serieDiaria'][number];
type PaginaConsultas = Pagina<ConsultaAuditoria>;
type TrilhaTitular = TrilhaCpf;
interface UsuarioAuditoria { id: string; nome: string; email: string }

const ROTAS = {
  /** GET → ResumoAuditoria. Janela fixa de 30 dias, definida pelo backend. */
  resumo: '/auditoria/resumo',
  /** GET ?pagina&porPagina&userId&tipo&de&ate&contatoExibido → Pagina<Consulta>. */
  consultas: '/auditoria/consultas',
  /** GET → lista de usuários que já consultaram, para o filtro. */
  usuarios: '/auditoria/usuarios',
  /**
   * POST {cpf} → trilha completa de um CPF (LGPD art. 18).
   *
   * POST numa CONSULTA, de propósito: no caminho da URL o CPF entraria no log
   * de acesso do proxy, que não é nosso e não se apaga a pedido do titular. No
   * corpo, o logger já o censura. Nada é criado — a rota responde 200.
   */
  titular: '/auditoria/trilha-cpf',
} as const;

const POR_PAGINA = 25;

/* Os tipos gravados em consultas_cliente.tipo (o campo é String no schema, não
   enum — a lista abaixo espelha o comentário do modelo). */
const TIPOS = ['', 'CPF', 'NOME', 'PROCESSO', 'CIDADE', 'UF'] as const;

const ROTULO_TIPO: Record<string, string> = {
  CPF: 'CPF',
  NOME: 'Nome',
  PROCESSO: 'Processo',
  CIDADE: 'Cidade',
  UF: 'UF',
};

/* Campos opcionais onde o backend pode legitimamente não ter o dado (IP atrás
   de proxy, usuário removido) — e também para que uma divergência de contrato
   degrade um campo em vez de derrubar a tela inteira. */
const DIAS_SERIE = 30;

function inteiro(n: number) {
  return n.toLocaleString('pt-BR');
}

/**
 * Data/hora COM segundos.
 *
 * Num log de acesso, duas consultas no mesmo minuto são eventos diferentes e
 * precisam ser ordenáveis a olho — sem os segundos, a trilha do titular exibe
 * dois registros aparentemente simultâneos e a sequência dos fatos se perde.
 */
function dataHora(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Chave de dia no fuso LOCAL — ver comentário de `diaCurto`. */
function chaveDia(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * "2026-07-19" → "19/07".
 *
 * Formatado na unha porque `new Date('2026-07-19')` é interpretado como UTC:
 * no fuso de Brasília o rótulo sairia um dia atrasado, e um gráfico de auditoria
 * datado errado é pior do que gráfico nenhum.
 */
function diaCurto(dia: string) {
  const [, m, d] = dia.slice(0, 10).split('-');
  return d && m ? `${d}/${m}` : dia;
}

/**
 * Completa a série com os dias sem consulta.
 *
 * O backend só tem linhas para os dias em que alguém consultou. Plotado cru, um
 * intervalo de silêncio de uma semana vira um segmento reto entre dois pontos —
 * exatamente o oposto do que a auditoria precisa mostrar.
 */
function serieCompleta(pontos: PontoSerie[] | undefined): PontoSerie[] {
  const porDia = new Map<string, PontoSerie>();
  for (const p of pontos ?? []) porDia.set(p.data.slice(0, 10), p);

  const hoje = new Date();
  return Array.from({ length: DIAS_SERIE }, (_, i) => {
    const d = new Date(hoje);
    d.setDate(d.getDate() - (DIAS_SERIE - 1 - i));
    const chave = chaveDia(d);
    const achado = porDia.get(chave);
    return { data: chave, total: achado?.total ?? 0 };
  });
}

const FILTROS_VAZIOS = { userId: '', tipo: '', de: '', ate: '', apenasContato: false };
type Filtros = typeof FILTROS_VAZIOS;

export default function AuditoriaPage() {
  const [resumo, setResumo] = useState<Estado<ResumoAuditoria>>(CARREGANDO);
  const [usuarios, setUsuarios] = useState<UsuarioAuditoria[]>([]);

  const [filtros, setFiltros] = useState<Filtros>(FILTROS_VAZIOS);
  const [pagina, setPagina] = useState(1);
  const [tabela, setTabela] = useState<Estado<PaginaConsultas>>(CARREGANDO);
  /* Separado do Estado: ao paginar ou trocar filtro, as linhas anteriores
     continuam na tela esmaecidas em vez de piscarem esqueleto a cada clique. */
  const [carregandoTabela, setCarregandoTabela] = useState(true);

  const animar = useAnimavel();

  const carregarResumo = useCallback(async () => {
    setResumo(CARREGANDO);
    try {
      setResumo({ st: 'ok', dados: await api<ResumoAuditoria>(ROTAS.resumo) });
    } catch (e) {
      setResumo({ st: 'erro', msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void carregarResumo();
    /* A lista de usuários é acessório do filtro: se falhar, o select some e o
       resto da auditoria continua utilizável. Por isso não vira Estado. */
    api<UsuarioAuditoria[]>(ROTAS.usuarios)
      .then((u) => setUsuarios(Array.isArray(u) ? u : []))
      .catch(() => setUsuarios([]));
  }, [carregarResumo]);

  const carregarTabela = useCallback(async (f: Filtros, p: number) => {
    setCarregandoTabela(true);
    try {
      const q = new URLSearchParams({ pagina: String(p), porPagina: String(POR_PAGINA) });
      if (f.userId) q.set('userId', f.userId);
      if (f.tipo) q.set('tipo', f.tipo);
      if (f.de) q.set('de', f.de);
      if (f.ate) q.set('ate', f.ate);
      if (f.apenasContato) q.set('somenteContatoExibido', 'true');
      setTabela({ st: 'ok', dados: await api<PaginaConsultas>(`${ROTAS.consultas}?${q}`) });
    } catch (e) {
      setTabela({ st: 'erro', msg: (e as Error).message });
    } finally {
      setCarregandoTabela(false);
    }
  }, []);

  /* Filtros e página num único efeito: mudar um filtro também zera a página, e
     as duas atualizações caem no mesmo render — uma requisição, não duas. */
  useEffect(() => {
    void carregarTabela(filtros, pagina);
  }, [filtros, pagina, carregarTabela]);

  function mudarFiltro(parcial: Partial<Filtros>) {
    setFiltros((f) => ({ ...f, ...parcial }));
    setPagina(1);
  }

  const temFiltro =
    Boolean(filtros.userId || filtros.tipo || filtros.de || filtros.ate) || filtros.apenasContato;

  const serie = resumo.st === 'ok' ? serieCompleta(resumo.dados.serieDiaria) : [];
  const pctContato =
    resumo.st === 'ok' && resumo.dados.totalConsultas > 0
      ? (resumo.dados.consultasComContato / resumo.dados.totalConsultas) * 100
      : 0;

  return (
    <div className="relative min-h-screen">
      {/* Aurora ambiente — mesmo mundo visual do dashboard e da consulta */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute -right-40 -top-40 h-[36rem] w-[36rem] rounded-full opacity-[0.13] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#6366f1,transparent 68%)' }}
          animate={{ x: [0, -40, 0], y: [0, 40, 0] }}
          transition={{ duration: 25, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -left-32 top-1/2 h-[30rem] w-[30rem] rounded-full opacity-[0.1] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#22d3ee,transparent 68%)' }}
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 27, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
        />
      </div>

      <div className="relative p-6 lg:p-9">
        {/* ── Cabeçalho ── */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-7"
        >
          <p className="rotulo">Conformidade</p>
          <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            Auditoria
          </h1>
          {/* A natureza do registro precisa estar na tela, não só na política:
              quem opera tem de saber que o próprio uso está sendo gravado. */}
          <p className="mt-3 flex max-w-3xl items-start gap-2 text-[12px] leading-relaxed text-muted">
            <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-2" />
            <span>
              Registro imutável: toda consulta a dado pessoal é gravada e nunca é alterada nem
              removida. Serve à prestação de contas e à demonstração de conformidade
              (LGPD, art. 37) e à resposta ao titular (art. 18).
            </span>
          </p>
        </motion.header>

        {/* ══ 1. Quem andou consultando, e quanto ══ */}
        <section aria-labelledby="titulo-volume">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="titulo-volume" className="font-display text-sm font-semibold text-ink">
              Volume de acesso a dados pessoais
            </h2>
            <span className="rotulo">Últimos {DIAS_SERIE} dias</span>
          </div>

          {resumo.st === 'erro' ? (
            <div className="cartao border-erro/25 p-6" role="alert">
              <BlocoErro msg={`Não foi possível carregar os indicadores de auditoria: ${resumo.msg}`} />
              <button
                type="button"
                onClick={() => void carregarResumo()}
                className="mt-4 flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
              >
                <RotateCw aria-hidden className="h-3.5 w-3.5" />
                Tentar novamente
              </button>
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <CartaoKpi Icone={ScrollText} rotulo="Consultas registradas" indice={0}>
                  {resumo.st === 'carregando' ? (
                    <Esqueleto className="h-8 w-2/3" />
                  ) : (
                    <Contador
                      valor={resumo.dados.totalConsultas}
                      formatar={(n) => inteiro(Math.round(n))}
                      className="num font-display text-[28px] font-semibold leading-none text-ink"
                    />
                  )}
                </CartaoKpi>

                {/* O evento sensível não é a busca: é a exibição do contato.
                    Por isso este é o único indicador em destaque e em `alerta`. */}
                <CartaoKpi
                  Icone={Eye}
                  rotulo="Exibiram contato"
                  destaque
                  indice={1}
                  sub={
                    resumo.st === 'ok' ? (
                      <span>
                        <span className="num text-ink-2">
                          {pctContato.toFixed(pctContato >= 10 ? 0 : 1).replace('.', ',')}%
                        </span>{' '}
                        das consultas revelaram telefone ou e-mail
                      </span>
                    ) : undefined
                  }
                >
                  {resumo.st === 'carregando' ? (
                    <Esqueleto className="h-8 w-1/2" />
                  ) : (
                    <Contador
                      valor={resumo.dados.consultasComContato}
                      formatar={(n) => inteiro(Math.round(n))}
                      className="num font-display text-[28px] font-semibold leading-none text-alerta"
                    />
                  )}
                </CartaoKpi>

                <CartaoKpi Icone={Users} rotulo="Usuários distintos" indice={2}>
                  {resumo.st === 'carregando' ? (
                    <Esqueleto className="h-8 w-1/3" />
                  ) : (
                    <Contador
                      valor={resumo.dados.usuariosDistintos}
                      formatar={(n) => inteiro(Math.round(n))}
                      className="num font-display text-[28px] font-semibold leading-none text-ink"
                    />
                  )}
                </CartaoKpi>

                <CartaoKpi Icone={Fingerprint} rotulo="CPFs distintos" indice={3}>
                  {resumo.st === 'carregando' ? (
                    <Esqueleto className="h-8 w-1/3" />
                  ) : (
                    <Contador
                      valor={resumo.dados.cpfsDistintos}
                      formatar={(n) => inteiro(Math.round(n))}
                      className="num font-display text-[28px] font-semibold leading-none text-ink"
                    />
                  )}
                </CartaoKpi>
              </div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.28, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className="cartao mt-5 p-6"
              >
                <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2">
                  <h3 className="font-display text-sm font-semibold text-ink">Série diária</h3>
                  <div className="flex items-center gap-4 text-[11px] text-muted">
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="h-2 w-2 rounded-full bg-marca-ciano" />
                      Consultas
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="h-2 w-2 rounded-full bg-alerta" />
                      Com contato exibido
                    </span>
                  </div>
                </div>

                {resumo.st === 'carregando' ? (
                  <Esqueleto className="h-[240px] rounded-[12px]" />
                ) : (
                  <div className="h-[240px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={serie} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
                        <defs>
                          <linearGradient id="aud-total" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#26d5ee" stopOpacity={0.42} />
                            <stop offset="55%" stopColor="#4f7cff" stopOpacity={0.16} />
                            <stop offset="100%" stopColor="#8b5cff" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="aud-contato" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.34} />
                            <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          vertical={false}
                          stroke="rgba(150,175,235,.13)"
                          strokeDasharray="3 3"
                        />
                        <XAxis
                          dataKey="data"
                          tickFormatter={diaCurto}
                          axisLine={false}
                          tickLine={false}
                          minTickGap={26}
                          tick={{ fill: '#7d88a6', fontSize: 11 }}
                        />
                        <YAxis
                          allowDecimals={false}
                          width={44}
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: '#7d88a6', fontSize: 11 }}
                        />
                        <Tooltip
                          cursor={{ stroke: 'rgba(150,175,235,.26)', strokeWidth: 1 }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload as PontoSerie;
                            return (
                              <div className="rounded-[12px] border border-linha bg-bg-2/95 px-3.5 py-2.5 shadow-elevado backdrop-blur-xl">
                                <p className="num mb-1 text-[12px] text-ink">
                                  {diaCurto(String(label))}
                                </p>
                                {/* Uma série só: /auditoria/resumo devolve {data,total},
                                    sem recorte por contato exibido. Plotar uma segunda
                                    linha aqui seria inventar um zero que a API não afirma. */}
                                <p className="num text-[13px] font-semibold text-marca-ciano">
                                  {inteiro(d.total)} {d.total === 1 ? 'consulta' : 'consultas'}
                                </p>
                              </div>
                            );
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="total"
                          stroke="#26d5ee"
                          strokeWidth={2}
                          fill="url(#aud-total)"
                          isAnimationActive={animar}
                          animationDuration={1000}
                        />
                        <Area
                          type="monotone"
                          dataKey="comContato"
                          stroke="#f59e0b"
                          strokeWidth={1.5}
                          fill="url(#aud-contato)"
                          isAnimationActive={animar}
                          animationDuration={1000}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </motion.div>
            </>
          )}
        </section>

        {/* ══ 3. (posicionada aqui por findability) Trilha de um titular ══ */}
        <TrilhaDoTitular />

        {/* ══ 2. O que foi consultado ══ */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.44, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mt-6"
          aria-labelledby="titulo-registro"
        >
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 id="titulo-registro" className="font-display text-sm font-semibold text-ink">
              Registro de consultas
            </h2>
            {tabela.st === 'ok' && (
              <p className="text-[12px] text-muted" role="status">
                <span className="num text-ink-2">{inteiro(tabela.dados.total)}</span>{' '}
                {tabela.dados.total === 1 ? 'registro' : 'registros'}
                {tabela.dados.totalPaginas > 1 && (
                  <span className="num">
                    {' '}
                    · página {tabela.dados.pagina} de {tabela.dados.totalPaginas}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="cartao">
            {/* ── Filtros ── */}
            <div className="flex flex-wrap items-end gap-3 border-b border-linha p-5">
              {usuarios.length > 0 && (
                <div className="min-w-0">
                  <label htmlFor="f-usuario" className="rotulo mb-2 block">
                    Usuário
                  </label>
                  <select
                    id="f-usuario"
                    value={filtros.userId}
                    onChange={(e) => mudarFiltro({ userId: e.target.value })}
                    className="h-11 w-[11rem] max-w-full rounded-[12px] border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-ink outline-none transition-colors hover:border-white/[0.14] focus:border-marca-ciano/50"
                  >
                    <option value="" className="bg-bg-2 text-ink">
                      Todos
                    </option>
                    {usuarios.map((u) => (
                      <option key={u.id} value={u.id} className="bg-bg-2 text-ink">
                        {u.nome}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label htmlFor="f-tipo" className="rotulo mb-2 block">
                  Tipo
                </label>
                <select
                  id="f-tipo"
                  value={filtros.tipo}
                  onChange={(e) => mudarFiltro({ tipo: e.target.value })}
                  className="h-11 w-[8.5rem] rounded-[12px] border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-ink outline-none transition-colors hover:border-white/[0.14] focus:border-marca-ciano/50"
                >
                  {TIPOS.map((t) => (
                    <option key={t} value={t} className="bg-bg-2 text-ink">
                      {t ? ROTULO_TIPO[t] : 'Todos'}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="f-de" className="rotulo mb-2 block">
                  De
                </label>
                <input
                  id="f-de"
                  type="date"
                  value={filtros.de}
                  onChange={(e) => mudarFiltro({ de: e.target.value })}
                  className="num h-11 w-[9.5rem] rounded-[12px] border border-white/[0.08] bg-white/[0.03] px-3 text-[13px] text-ink outline-none transition-colors hover:border-white/[0.14] focus:border-marca-ciano/50"
                />
              </div>

              <div>
                <label htmlFor="f-ate" className="rotulo mb-2 block">
                  Até
                </label>
                <input
                  id="f-ate"
                  type="date"
                  value={filtros.ate}
                  onChange={(e) => mudarFiltro({ ate: e.target.value })}
                  className="num h-11 w-[9.5rem] rounded-[12px] border border-white/[0.08] bg-white/[0.03] px-3 text-[13px] text-ink outline-none transition-colors hover:border-white/[0.14] focus:border-marca-ciano/50"
                />
              </div>

              <label
                htmlFor="f-contato"
                className={cn(
                  'flex h-11 cursor-pointer items-center gap-2.5 rounded-[12px] border px-3.5 text-[13px] transition-colors',
                  filtros.apenasContato
                    ? 'border-alerta/40 bg-alerta/10 text-alerta'
                    : 'border-white/[0.08] bg-white/[0.03] text-ink-2 hover:border-white/[0.14]',
                )}
              >
                <input
                  id="f-contato"
                  type="checkbox"
                  checked={filtros.apenasContato}
                  onChange={(e) => mudarFiltro({ apenasContato: e.target.checked })}
                  className="h-4 w-4 accent-alerta"
                />
                Apenas com contato exibido
              </label>

              {temFiltro && (
                <button
                  type="button"
                  onClick={() => {
                    setFiltros(FILTROS_VAZIOS);
                    setPagina(1);
                  }}
                  className="flex h-11 items-center gap-2 rounded-[12px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
                >
                  <X aria-hidden className="h-3.5 w-3.5" />
                  Limpar
                </button>
              )}

              {carregandoTabela && tabela.st === 'ok' && (
                <span className="flex h-11 items-center gap-1.5 text-[11px] text-muted-2">
                  <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                  atualizando…
                </span>
              )}
            </div>

            {tabela.st === 'carregando' && (
              <div className="space-y-2 p-5" aria-busy="true">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Esqueleto key={i} className="h-11 rounded-[10px]" />
                ))}
              </div>
            )}

            {tabela.st === 'erro' && (
              <div className="p-6" role="alert">
                <BlocoErro msg={`Não foi possível carregar o registro de consultas: ${tabela.msg}`} />
                <button
                  type="button"
                  onClick={() => void carregarTabela(filtros, pagina)}
                  className="mt-4 flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
                >
                  <RotateCw aria-hidden className={cn('h-3.5 w-3.5', carregandoTabela && 'animate-spin')} />
                  Tentar novamente
                </button>
              </div>
            )}

            {tabela.st === 'ok' && tabela.dados.itens.length === 0 && (
              temFiltro ? (
                <Vazio
                  Icone={SearchX}
                  titulo="Nenhuma consulta com esses filtros"
                  descricao="O registro existe, mas nada corresponde ao recorte selecionado. Amplie o período ou remova um filtro."
                  acao={
                    <button
                      type="button"
                      onClick={() => {
                        setFiltros(FILTROS_VAZIOS);
                        setPagina(1);
                      }}
                      className="flex h-9 items-center gap-2 rounded-[11px] border border-linha px-4 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
                    >
                      <X aria-hidden className="h-3.5 w-3.5" />
                      Limpar filtros
                    </button>
                  }
                />
              ) : (
                <Vazio
                  Icone={ScrollText}
                  titulo="Nenhuma consulta registrada ainda"
                  descricao="Assim que alguém consultar a carteira, o acesso aparece aqui — e permanece."
                />
              )
            )}

            {tabela.st === 'ok' && tabela.dados.itens.length > 0 && (
              <>
                {/* A tabela é larga: rola dentro do cartão para que a página
                    nunca role na horizontal. */}
                <div className={cn('overflow-x-auto transition-opacity', carregandoTabela && 'opacity-60')}>
                  <table className="w-full min-w-[62rem] text-sm">
                    <caption className="sr-only">
                      Consultas registradas, com data e hora, usuário responsável, tipo e termo
                      buscado, quantidade de resultados, se o contato foi exibido e o IP de origem.
                    </caption>
                    <thead>
                      <tr className="border-b border-linha text-left">
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Data e hora</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Usuário</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Tipo</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Termo</th>
                        <th scope="col" className="rotulo px-5 py-3 text-right font-medium">Result.</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Contato</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">IP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tabela.dados.itens.map((c, i) => (
                        <motion.tr
                          key={c.id}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ delay: Math.min(i, 10) * 0.025, duration: 0.4 }}
                          className={cn(
                            /* `linha` já é rgba com alfa baixo e o modificador do
                               Tailwind SUBSTITUI esse alfa: `border-linha/60`
                               deixaria a grade 4x mais forte, não mais fraca. */
                            'border-b border-linha transition-colors last:border-0 hover:bg-superficie-2',
                            /* A linha inteira sinaliza o evento sensível — o
                               olho encontra a exibição de contato varrendo a
                               coluna da esquerda, sem ler célula por célula. */
                            c.contatoExibido && 'bg-alerta/[0.06]',
                          )}
                        >
                          <td className="num whitespace-nowrap px-5 py-3.5 text-[12px] text-ink-2">
                            {dataHora(c.criadoEm)}
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className="block max-w-[12rem] truncate text-[13px] text-ink"
                              title={c.user?.email ?? undefined}
                            >
                              {c.user?.nome ?? '—'}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            {/* Tipos em tom neutro de propósito: a única cor de
                                alerta da tabela pertence ao contato exibido. */}
                            <span className="inline-block whitespace-nowrap rounded-full border border-linha bg-superficie px-2.5 py-1 text-[11px] text-ink-2">
                              {ROTULO_TIPO[c.tipo] ?? c.tipo}
                            </span>
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className={cn(
                                'block max-w-[18rem] truncate text-[13px] text-ink-2',
                                c.tipo === 'CPF' && 'num',
                              )}
                              title={c.termo ?? 'Conteúdo descartado no prazo de retenção'}
                            >
                              {/* Com o termo descartado cai no `cpfConsultado`,
                                  que é a MESMA informação em coluna estruturada
                                  — mostrar "—" tendo o CPF ao lado seria perder
                                  legibilidade sem ganhar privacidade nenhuma.
                                  Só quando não há nem um nem outro vem o traço:
                                  em branco lê-se como "buscou nada", e o que
                                  houve foi descarte por prazo. */}
                              {c.tipo === 'CPF'
                                ? cpfFormatado(c.termo ?? c.cpfConsultado)
                                : (c.termo ?? '—')}
                            </span>
                          </td>
                          <td className="num px-5 py-3.5 text-right text-[13px] text-ink-2">
                            {inteiro(c.totalResultados ?? 0)}
                          </td>
                          <td className="px-5 py-3.5">
                            {c.contatoExibido ? (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-alerta/30 bg-alerta/10 px-2.5 py-1 text-[11px] font-medium text-alerta">
                                <Eye aria-hidden className="h-3 w-3" />
                                Exibido
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-2">
                                <EyeOff aria-hidden className="h-3 w-3" />
                                Não
                              </span>
                            )}
                          </td>
                          <td className="num whitespace-nowrap px-5 py-3.5 text-[12px] text-muted">
                            {c.ip ?? '—'}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {tabela.dados.totalPaginas > 1 && (
                  <nav
                    aria-label="Paginação do registro de consultas"
                    className="flex items-center justify-center gap-2 border-t border-linha p-5"
                  >
                    {/* `disabled` só nos limites, nunca durante o carregamento:
                        desabilitar o botão recém-clicado joga o foco no <body>.
                        O clique redundante é ignorado no handler. */}
                    <button
                      onClick={() => !carregandoTabela && setPagina((p) => Math.max(1, p - 1))}
                      disabled={tabela.dados.pagina <= 1}
                      className="flex h-10 items-center gap-1.5 rounded-[12px] border border-linha px-4 text-sm text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <ChevronLeft aria-hidden className="h-4 w-4" />
                      Anterior
                    </button>
                    <span className="num px-3 text-sm text-muted">
                      {tabela.dados.pagina} / {tabela.dados.totalPaginas}
                    </span>
                    <button
                      onClick={() =>
                        !carregandoTabela &&
                        setPagina((p) => Math.min(tabela.dados.totalPaginas, p + 1))
                      }
                      disabled={tabela.dados.pagina >= tabela.dados.totalPaginas}
                      className="flex h-10 items-center gap-1.5 rounded-[12px] border border-linha px-4 text-sm text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      Próxima
                      <ChevronRight aria-hidden className="h-4 w-4" />
                    </button>
                  </nav>
                )}
              </>
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}

/**
 * "Quem acessou os dados DESTE titular?" — a resposta ao art. 18 da LGPD.
 *
 * Fica em bloco próprio, acima da tabela geral, porque a pergunta chega de fora
 * e com prazo: quando o titular pede, ninguém quer descobrir que a resposta
 * estava no rodapé atrás de uma paginação.
 */
function TrilhaDoTitular() {
  const [cpf, setCpf] = useState('');
  const [consultado, setConsultado] = useState('');
  const [trilha, setTrilha] = useState<Estado<ConsultaAuditoria[]> | null>(null);
  const [carregando, setCarregando] = useState(false);

  const digitos = cpf.replace(/\D/g, '');
  const valido = digitos.length === 11;

  async function buscar(e: React.FormEvent) {
    e.preventDefault();
    if (!valido || carregando) return;
    setCarregando(true);
    setTrilha(CARREGANDO);
    setConsultado(digitos);
    try {
      /* Uma chamada só. Existia aqui um fallback por query string, criado como
         rede de segurança para o contrato — mas a divergência real estava no
         NOME do segmento (/auditoria/cpf, não /auditoria/titular), então as
         duas tentativas davam 404 e cada busca pagava duas requisições.

         O CPF vai no CORPO: na URL ele acabaria no log de acesso do proxy. */
      const dados = await api<TrilhaTitular>(ROTAS.titular, {
        method: 'POST',
        body: JSON.stringify({ cpf: digitos }),
      });
      setTrilha({ st: 'ok', dados: dados.consultas });
    } catch (err) {
      setTrilha({ st: 'erro', msg: (err as Error).message });
    } finally {
      setCarregando(false);
    }
  }

  function limpar() {
    setCpf('');
    setConsultado('');
    setTrilha(null);
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.36, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="cartao mt-6 p-6"
      aria-labelledby="titulo-titular"
    >
      <div className="mb-5 flex items-start gap-2.5">
        <UserSearch aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-marca-ciano" />
        <div className="min-w-0">
          <h2 id="titulo-titular" className="font-display text-sm font-semibold text-ink">
            Trilha de acesso por titular
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">
            Informe o CPF para listar todos os acessos aos dados dessa pessoa. É o que se entrega
            ao titular que exerce o direito de acesso (LGPD, art. 18).
          </p>
        </div>
      </div>

      <form method="post" onSubmit={buscar} className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <label htmlFor="cpf-titular" className="sr-only">
            CPF do titular
          </label>
          <div className="group relative">
            <Fingerprint
              aria-hidden
              className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-2 transition-colors group-focus-within:text-marca-ciano"
            />
            <input
              id="cpf-titular"
              value={cpf}
              onChange={(e) => setCpf(e.target.value)}
              placeholder="000.000.000-00"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="dica-cpf"
              className="num h-[52px] w-full rounded-[14px] border border-white/[0.08] bg-white/[0.03] pl-12 pr-11 text-[15px] text-ink outline-none transition-all placeholder:text-muted-2 hover:border-white/[0.14] focus:border-marca-ciano/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
            />
            {cpf && (
              <button
                type="button"
                onClick={limpar}
                aria-label="Limpar CPF"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-2 transition-colors hover:text-ink-2"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            )}
          </div>
          {/* A validação acontece antes da requisição: um CPF incompleto traria
              trilha vazia, indistinguível de "ninguém consultou este titular". */}
          <p id="dica-cpf" className="mt-2 text-[11px] text-muted-2">
            {digitos.length > 0 && !valido
              ? `CPF incompleto — ${digitos.length} de 11 dígitos.`
              : 'Somente os 11 dígitos; a pontuação é opcional.'}
          </p>
        </div>

        <motion.button
          type="submit"
          whileHover={valido ? { scale: 1.015 } : undefined}
          whileTap={valido ? { scale: 0.985 } : undefined}
          aria-disabled={!valido || carregando}
          className={cn(
            'flex h-[52px] shrink-0 items-center justify-center gap-2.5 rounded-[14px] bg-marca px-7',
            'font-display text-[15px] font-semibold text-[#05070f] transition-shadow duration-300',
            valido && !carregando ? 'hover:shadow-brilho-ciano' : 'cursor-not-allowed opacity-45',
          )}
        >
          {carregando ? (
            <Loader2 aria-hidden className="h-[18px] w-[18px] animate-spin" />
          ) : (
            <ShieldCheck aria-hidden className="h-[18px] w-[18px]" />
          )}
          Ver trilha
        </motion.button>
      </form>

      {trilha && (
        <div className="mt-5 border-t border-linha pt-5">
          {trilha.st === 'carregando' && (
            <div className="space-y-2" aria-busy="true">
              {Array.from({ length: 3 }).map((_, i) => (
                <Esqueleto key={i} className="h-14 rounded-[12px]" />
              ))}
            </div>
          )}

          {trilha.st === 'erro' && (
            <div role="alert">
              <BlocoErro msg={`Não foi possível levantar a trilha deste titular: ${trilha.msg}`} />
            </div>
          )}

          {trilha.st === 'ok' && trilha.dados.length === 0 && (
            <Vazio
              Icone={ShieldCheck}
              titulo="Nenhum acesso registrado"
              descricao={`Não há consulta alguma ao CPF ${cpfFormatado(consultado)} no registro. Esta é uma resposta válida ao titular.`}
            />
          )}

          {trilha.st === 'ok' && trilha.dados.length > 0 && (
            <>
              <p className="mb-4 text-[13px] text-muted" role="status">
                <span className="num text-ink">{inteiro(trilha.dados.length)}</span>{' '}
                {trilha.dados.length === 1 ? 'acesso registrado' : 'acessos registrados'} ao CPF{' '}
                <span className="num text-ink-2">{cpfFormatado(consultado)}</span>
              </p>

              {/* Linha do tempo, não tabela: aqui a pergunta é a sequência de
                  quem tocou nesta pessoa, e não a comparação entre colunas. */}
              <ol className="space-y-2">
                {trilha.dados.map((c, i) => (
                  <motion.li
                    key={c.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(i, 10) * 0.04, duration: 0.45 }}
                    className={cn(
                      'flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[12px] border-l-2 px-4 py-3',
                      c.contatoExibido
                        ? 'border-l-alerta bg-alerta/[0.06]'
                        : 'border-l-linha-2 bg-superficie',
                    )}
                  >
                    <span className="num shrink-0 text-[12px] text-ink-2">
                      {dataHora(c.criadoEm)}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink">
                      <Users aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <span className="truncate" title={c.user?.email ?? undefined}>
                        {c.user?.nome ?? '—'}
                      </span>
                    </span>
                    <span className="text-[11px] text-muted">
                      {ROTULO_TIPO[c.tipo] ?? c.tipo} ·{' '}
                      <span className="num">{inteiro(c.totalResultados ?? 0)}</span>{' '}
                      {(c.totalResultados ?? 0) === 1 ? 'resultado' : 'resultados'}
                    </span>
                    {c.contatoExibido && (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-alerta/30 bg-alerta/10 px-2.5 py-1 text-[11px] font-medium text-alerta">
                        <Eye aria-hidden className="h-3 w-3" />
                        Contato exibido
                      </span>
                    )}
                    <span className="num ml-auto shrink-0 text-[11px] text-muted-2">
                      {c.ip ?? '—'}
                    </span>
                  </motion.li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </motion.section>
  );
}
