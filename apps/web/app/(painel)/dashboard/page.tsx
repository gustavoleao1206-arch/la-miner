'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Users,
  FileText,
  Wallet,
  Target,
  TrendingUp,
  Gauge,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import {
  api,
  folegoDasAssinaturas,
  type Consumo,
  type EstadoFila,
  type Importacao,
  type PainelCarteira,
  type Prioridade,
  type ResumoCarteira,
} from '@/lib/api';
import { brl, compacto, cn, hojeISO, LIMIAR_CONSUMO_CRITICO } from '@/lib/utils';
import { useLote } from '@/lib/lote';
import { useUsuario } from '@/lib/usuario';
import { Contador, Esqueleto, useAnimavel } from '@/components/metricas';
import { faseExigivel } from '@/components/fase-processo';
import { Kpi } from '@/components/kpi';
import { HeroCarteira } from '@/components/dashboard/hero-carteira';
import { DonutPrioridade } from '@/components/dashboard/donut-prioridade';
import { MapaBrasil } from '@/components/dashboard/mapa-brasil';
import { Alertas } from '@/components/dashboard/alertas';
import { Sparkline } from '@/components/dashboard/sparkline';
import { BlocoErro, type Estado } from '@/components/estado';
import { comoEstadoQuery } from '@/lib/consultas';

/**
 * Rótulo do eixo Y desenhado por nós.
 *
 * O <Text> do Recharts quebra a linha sozinho quando o rótulo se aproxima da
 * largura do eixo — "UNIÃO FEDERAL" virava duas linhas no meio de sete de uma,
 * e o limiar interno não é previsível de fora. Renderizando o <text> direto,
 * a quebra deixa de existir e o truncamento fica sob nosso controle.
 */
function RotuloEixo({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fill="#94a3c4" fontSize={11}>
      {payload?.value}
    </text>
  );
}

/** Formata em reais compactos para caber no cartão sem quebrar. */
function brlCompacto(n: number) {
  if (n >= 1e9) return `R$ ${(n / 1e9).toFixed(2).replace('.', ',')} Bi`;
  if (n >= 1e6) return `R$ ${(n / 1e6).toFixed(1).replace('.', ',')} Mi`;
  return brl(n);
}

const pct = (parte: number, todo: number) => (todo > 0 ? (parte / todo) * 100 : 0);

/**
 * Percentual em pt-BR: "4,0%", não "4.0%".
 *
 * `toFixed` não localiza — devolve sempre ponto decimal. Numa tela em português
 * cheia de valores em real com vírgula, um "4.0%" no meio parece dado importado
 * de outro sistema, que é exatamente a impressão que um produto vendido para
 * escritório brasileiro não pode passar.
 */
const pctTexto = (n: number) =>
  `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

type Tendencia = {
  data: string;
  processos: number;
  pessoas: number;
  comAlgumContato: number;
  valorTotal: string;
  valorAlcancavel: string;
};

/** Variação do primeiro ao último ponto — só devolve algo com histórico (≥2 dias). */
function tendenciaSerie(serie: number[]): { texto: string; positiva: boolean } | undefined {
  if (serie.length < 2) return undefined;
  const primeiro = serie[0];
  const ultimo = serie[serie.length - 1];
  if (primeiro === 0) return undefined;
  const delta = ((ultimo - primeiro) / primeiro) * 100;
  if (Math.abs(delta) < 0.05) return undefined; // ruído: não vira seta
  return { texto: `${Math.abs(delta).toFixed(1).replace('.', ',')}%`, positiva: delta >= 0 };
}

export default function DashboardPage() {
  const animar = useAnimavel();
  /* `query` já vem pronta (`tribunal=..&exercicio=..`) e vazia enquanto o
     catálogo não resolveu — nesse intervalo a API responde com o padrão. */
  const { query, lote } = useLote();
  const q = query ? `?${query}` : '';

  /* O que o cliente não pode ver, ele nem BUSCA. Sem isto, toda sessão dele
     começaria com uma salva de 403 no console — e, pior, os painéis ficariam em
     esqueleto eterno, porque uma query desabilitada nunca resolve para 'ok'.
     Depende de `carregado`: antes de sabermos QUEM é, não se dispara nada
     administrativo. */
  const { ehCliente, carregado } = useUsuario();
  const soInterno = carregado && !ehCliente;

  /* React Query dá o dashboard VIVO: cada tela se atualiza sozinha no seu ritmo.
     Fila e consumo giram rápido (mudam durante o enriquecimento); os agregados
     da carteira, devagar. O adaptador `comoEstadoQuery` devolve o mesmo
     `Estado<T>` que o render já fala, e sem piscar no refetch — durante uma
     atualização o dado anterior continua na tela. */
  const resumoQ = useQuery({
    queryKey: ['resumo', query],
    queryFn: () => api<ResumoCarteira>(`/carteira/resumo${q}`),
    refetchInterval: 60_000,
  });
  const painelQ = useQuery({
    queryKey: ['painel', query],
    /* `hoje` daqui: o servidor não sabe o fuso, e "atrasada" muda com o relógio. */
    queryFn: () =>
      api<PainelCarteira>(`/carteira/painel?hoje=${hojeISO()}${query ? `&${query}` : ''}`),
    refetchInterval: 60_000,
  });
  /**
   * O fôlego das assinaturas. `enabled: soInterno` pelo mesmo motivo da fila: é
   * rota de ADMIN, e o cliente pedindo-a começaria a sessão com um 403 no
   * console. E ele não poderia fazer nada com a resposta — quem importa
   * carteira nova é a operação.
   *
   * Cinco minutos entre consultas: a resposta muda quando um lote é gerado, o
   * que acontece uma vez por mês. Pedi-la no ritmo da fila seria varrer a tabela
   * de liberações a cada doze segundos para ver o mesmo número.
   */
  const folegoQ = useQuery({
    queryKey: ['folego'],
    queryFn: folegoDasAssinaturas,
    refetchInterval: 300_000,
    enabled: soInterno,
  });
  const filaQ = useQuery({
    queryKey: ['fila'],
    queryFn: () => api<EstadoFila>('/fila/estado'),
    refetchInterval: 12_000,
    enabled: soInterno,
  });
  const consumoQ = useQuery({
    queryKey: ['consumo'],
    queryFn: () => api<Consumo>('/fila/consumo'),
    refetchInterval: 12_000,
    enabled: soInterno,
  });
  const importacoesQ = useQuery({
    queryKey: ['importacoes'],
    queryFn: () => api<Importacao[]>('/importacao?limite=5'),
    refetchInterval: 60_000,
    enabled: soInterno,
  });
  const mapaQ = useQuery({
    queryKey: ['mapa', query],
    queryFn: () => api<{ uf: string; requerentes: number }[]>(`/carteira/mapa${q}`),
    refetchInterval: 120_000,
  });
  /* Tendências mudam uma vez por dia (um snapshot), então giram devagar. */
  const tendenciasQ = useQuery({
    queryKey: ['tendencias', query],
    queryFn: () => api<Tendencia[]>(`/carteira/tendencias${q}`),
    refetchInterval: 300_000,
  });

  const dados = resumoQ.data ?? null;
  const erro = resumoQ.isError
    ? ((resumoQ.error as Error)?.message ?? 'Falha ao carregar a carteira')
    : null;
  const painel = comoEstadoQuery(painelQ);
  const fila = comoEstadoQuery(filaQ);
  const consumo = comoEstadoQuery(consumoQ);
  const importacoes = comoEstadoQuery(importacoesQ);
  const mapa = comoEstadoQuery(mapaQ);
  /* "Ao vivo": pisca discreto quando algo de peso está buscando de novo. */
  const atualizando = resumoQ.isFetching || painelQ.isFetching || filaQ.isFetching;

  /* Séries dos KPIs, na ordem cronológica que o backend devolve. Enquanto houver
     só o snapshot de hoje, o Sparkline mostra "coletando" em vez de uma curva. */
  const tend = tendenciasQ.data ?? [];
  const serieValorTotal = tend.map((t) => Number(t.valorTotal));
  const serieAlcancavel = tend.map((t) => Number(t.valorAlcancavel));
  const serieProcessos = tend.map((t) => t.processos);
  const serieRequerentes = tend.map((t) => t.pessoas);

  if (erro) {
    return (
      <div className="p-8">
        <div className="cartao border-erro/30 bg-erro/10 p-5 text-sm text-erro">
          Não foi possível carregar a carteira: {erro}
        </div>
      </div>
    );
  }

  const carregando = !dados;

  /**
   * A CARTEIRA SEPARADA POR EXIGIBILIDADE.
   *
   * Contado aqui, e não no servidor, porque a régua é o `FASES` que desenha o
   * selo na linha — ter uma segunda definição de "isto é exigível" na API seria
   * ter duas que divergem na próxima fase que entrar no enum.
   *
   * Fase que o mapa não conhece não entra em nenhum dos dois: `faseExigivel`
   * devolve `undefined`, e o `?? 0` abaixo NÃO a absorve — ela some da sublinha
   * em vez de ser contada como algo que ninguém decidiu. Por isso os dois
   * números não prometem somar `processos`, e o texto não diz que somam.
   */
  const exigiveis = (dados?.porFase ?? [])
    .filter((f) => faseExigivel(f.fase) === true)
    .reduce((t, f) => t + f.quantidade, 0);
  const emFaseAnterior = (dados?.porFase ?? [])
    .filter((f) => faseExigivel(f.fase) === false)
    .reduce((t, f) => t + f.quantidade, 0);
  /* Só a cobertura é lida aqui, para os KPIs. A operação vai inteira para o
     componente `Operacao`, que trata os próprios estados de carga e erro. */
  const cob = painel.st === 'ok' ? painel.dados.cobertura : null;

  const barras =
    dados?.porEntidade
      .map((e) => ({
        nome: e.entidade.length > 26 ? `${e.entidade.slice(0, 25)}…` : e.entidade,
        completo: e.entidade,
        valor: Number(e.valor),
        qtd: e.quantidade,
        comValor: e.comValor,
      }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 8) ?? [];

  /* As entidades reais são siglas curtas (INSS, UFPE, DNOCS), mas nada garante
     que continuem assim. Largura fixa desperdiçava ~100px de área útil com os
     dados atuais e truncaria com nomes longos — então dimensiona pelo maior
     rótulo (≈6,3px por caractere a 11px) dentro de limites sãos. */
  const maiorRotulo = barras.reduce((m, b) => Math.max(m, b.nome.length), 0);
  const larguraEixo = Math.round(Math.min(200, Math.max(56, maiorRotulo * 6.3 + 14)));

  return (
    <div className="relative min-h-screen">
      {/* Aurora ambiente — amarra o painel ao mesmo mundo visual do login */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
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
        {/* ── Herói: resumo executivo, liderado pela alcançabilidade ── */}
        <HeroCarteira
          resumo={dados}
          cobertura={cob}
          fila={fila.st === 'ok' ? fila.dados : null}
          atualizando={atualizando}
        />

        {/* ── Indicadores ──
            "Valor alcançável" entrou no lugar de "Enriquecidos" porque responde
            a pergunta que o dono do escritório faz: quanto DISSO dá para
            trabalhar. Contagem de gente enriquecida é meio, não fim — foi para
            a seção de alcançabilidade, ao lado do que ela produz. */}
        <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            Icone={Wallet}
            rotulo="Valor total"
            destaque
            indice={0}
            /* NÃO somar `valorIndicativo` aqui está certo — é palpite extraído do
               texto da publicação, e misturá-lo com dinheiro apurado poria número
               inventado no total do cliente. O que faltava era DIZER isso. */
            sub={
              emFaseAnterior > 0 ? (
                <span>
                  não inclui{' '}
                  <span className="num text-alerta">
                    {emFaseAnterior.toLocaleString('pt-BR')}
                  </span>{' '}
                  em fase anterior, sem valor apurado
                </span>
              ) : undefined
            }
            tendencia={tendenciaSerie(serieValorTotal)}
            sparkline={<Sparkline serie={serieValorTotal} cor="rgb(var(--marca-ciano))" />}
            valor={
              carregando ? (
                <Esqueleto className="h-8 w-3/4" />
              ) : (
                <Contador
                  valor={Number(dados.valorTotal)}
                  formatar={brlCompacto}
                  className="num texto-marca font-display text-[27px] font-semibold leading-none"
                />
              )
            }
          />

          <Kpi
            Icone={Target}
            rotulo="Valor alcançável"
            indice={1}
            href="/fila"
            tendencia={tendenciaSerie(serieAlcancavel)}
            sparkline={<Sparkline serie={serieAlcancavel} cor="rgb(var(--ok))" />}
            sub={
              cob ? (
                <span>
                  <span className="num text-ink-2">
                    {pctTexto(pct(Number(cob.valorAlcancavel), Number(cob.valorTotal)))}
                  </span>{' '}
                  do total tem contato
                </span>
              ) : undefined
            }
            valor={
              painel.st === 'carregando' ? (
                <Esqueleto className="h-8 w-3/4" />
              ) : painel.st === 'erro' ? (
                <span className="text-[13px] text-muted">—</span>
              ) : (
                <Contador
                  valor={Number(cob!.valorAlcancavel)}
                  formatar={brlCompacto}
                  className="num font-display text-[27px] font-semibold leading-none text-ok"
                />
              )
            }
          />

          {/* ── "Processos", e não "Precatórios" ──
              Até 06/09/2026 a base era 100% precatório expedido e as duas
              palavras diziam o mesmo. Com os pré-precatórios na mesma carteira —
              e no mesmo sorteio dos 250 — o rótulo antigo afirmava exigibilidade
              formada sobre crédito que ainda está em trânsito em julgado.

              O NÚMERO não muda: o cliente recebeu esses processos e pagou por
              eles; escondê-los subestimaria a carteira dele. O que estava errado
              era a palavra, e a sublinha é quem passa a dizer a diferença.

              É o mesmo conserto que a Consulta recebeu ("1 processo" no lugar de
              "1 precatório"); este agregado tinha ficado para trás. */}
          <Kpi
            Icone={FileText}
            rotulo="Processos"
            indice={2}
            href="/consulta"
            tendencia={tendenciaSerie(serieProcessos)}
            sparkline={<Sparkline serie={serieProcessos} cor="rgb(var(--marca-azul))" />}
            sub={
              carregando ? undefined : (
                <span>
                  <span className="num text-ink-2">{exigiveis.toLocaleString('pt-BR')}</span> exigível(is)
                  {emFaseAnterior > 0 && (
                    <>
                      {' · '}
                      <span className="num text-alerta">{emFaseAnterior.toLocaleString('pt-BR')}</span> em fase
                      anterior
                    </>
                  )}
                </span>
              )
            }
            valor={
              carregando ? (
                <Esqueleto className="h-8 w-1/2" />
              ) : (
                <Contador
                  valor={dados.processos}
                  formatar={(n) => Math.round(n).toLocaleString('pt-BR')}
                  className="num font-display text-[27px] font-semibold leading-none text-ink"
                />
              )
            }
          />

          <Kpi
            Icone={Users}
            rotulo="Requerentes"
            indice={3}
            href="/consulta"
            tendencia={tendenciaSerie(serieRequerentes)}
            sparkline={<Sparkline serie={serieRequerentes} cor="rgb(var(--marca-violeta))" />}
            sub={
              cob ? (
                <span>
                  <span className="num text-ink-2">
                    {cob.comAlgumContato.toLocaleString('pt-BR')}
                  </span>{' '}
                  com algum contato
                </span>
              ) : undefined
            }
            valor={
              carregando ? (
                <Esqueleto className="h-8 w-1/2" />
              ) : (
                <Contador
                  valor={dados.pessoas}
                  formatar={(n) => Math.round(n).toLocaleString('pt-BR')}
                  className="num font-display text-[27px] font-semibold leading-none text-ink"
                />
              )
            }
          />
        </div>

        {/* ── Prioridade + Mapa ──
            A distribuição por prioridade (donut) e a geografia dos requerentes,
            lado a lado. O mapa usa os endereços reais do enriquecimento. */}
        <div className="mt-5 grid items-start gap-5 xl:grid-cols-2">
          <DonutPrioridade
            dados={painel.st === 'ok' ? painel.dados.operacao.porPrioridade : null}
            carregando={painel.st === 'carregando'}
          />
          <MapaBrasil
            dados={mapa.st === 'ok' ? mapa.dados : null}
            carregando={mapa.st === 'carregando'}
          />
        </div>

        {/* ── Distribuição por entidade + Fila ── */}
        {/* Sem a coluna da fila, a entidade ocupa a linha inteira em vez de deixar
            um vão de 1fr onde o cliente veria um buraco. */}
        <div className={`mt-5 grid gap-5 ${soInterno ? 'xl:grid-cols-[1.6fr_1fr]' : ''}`}>
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.44, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            aria-labelledby="titulo-entidades"
            className="cartao p-6"
          >
            <div className="mb-6 flex items-center gap-2.5">
              <TrendingUp aria-hidden className="h-4 w-4 text-marca-ciano" />
              <h2 id="titulo-entidades" className="font-display text-sm font-semibold text-ink">
                Distribuição por entidade devedora
              </h2>
              {/* "por valor apurado", e não só "maiores": entidade cuja exposição
                  é toda pré-precatório soma R$ 0 e não aparece aqui. O rótulo
                  deixa de afirmar que esta é a lista das maiores. */}
              {!carregando && (
                <span className="ml-auto text-[11px] text-muted-2">
                  {barras.length} maiores por valor apurado
                </span>
              )}
            </div>

            {carregando ? (
              <div className="space-y-3.5">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Esqueleto key={i} className="h-9" />
                ))}
              </div>
            ) : (
              <div style={{ height: Math.max(barras.length * 46, 200) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={barras} layout="vertical" margin={{ left: 0, right: 16 }}>
                    <defs>
                      <linearGradient id="barra" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#8b5cff" />
                        <stop offset="55%" stopColor="#4f7cff" />
                        <stop offset="100%" stopColor="#26d5ee" />
                      </linearGradient>
                    </defs>
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="nome"
                      width={larguraEixo}
                      axisLine={false}
                      tickLine={false}
                      tick={<RotuloEixo />}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(255,255,255,.03)' }}
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as (typeof barras)[number];
                        return (
                          <div className="rounded-[12px] border border-linha bg-bg-2/95 px-3.5 py-2.5 shadow-elevado backdrop-blur-xl">
                            <p className="mb-1 max-w-[16rem] text-[12px] text-ink">{d.completo}</p>
                            <p className="num text-[13px] font-semibold text-marca-ciano">
                              {brl(d.valor)}
                            </p>
                            {/* "processos" pela mesma razão do KPI acima — e aqui o
                                descompasso é maior: `qtd` conta o pré-precatório e
                                o valor ao lado NÃO o soma, porque `Processo.valor`
                                é nulo nele. Chamar os dois de "precatórios"
                                sugeria que aquele dinheiro cobre aquela contagem. */}
                            <p className="num mt-0.5 text-[11px] text-muted">
                              {d.qtd.toLocaleString('pt-BR')} processos
                              {/* A diferença é exatamente o que a barra NÃO cobre: a
                                  soma acima é de valor apurado, e o pré-precatório
                                  entra na contagem somando R$ 0. Dizer quantos têm
                                  valor é o que impede o número de cima de parecer
                                  descrever o de baixo. */}
                              {d.comValor < d.qtd && (
                                <span className="text-muted-2">
                                  {' · '}
                                  {d.comValor.toLocaleString('pt-BR')} com valor apurado
                                </span>
                              )}
                            </p>
                          </div>
                        );
                      }}
                    />
                    <Bar
                      dataKey="valor"
                      radius={[0, 6, 6, 0]}
                      barSize={18}
                      minPointSize={7}
                      isAnimationActive={animar}
                      animationDuration={1100}
                    >
                      {barras.map((_, i) => (
                        <Cell key={i} fill="url(#barra)" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </motion.section>

          {/* Fila + teto diário: os dois falam do mesmo assunto — o custo e o
              ritmo do enriquecimento — e estavam separados em cartões distintos.
              SÓ INTERNO: é a engrenagem que o cliente não pode saber que existe. */}
          {soInterno && (
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.52, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            aria-labelledby="titulo-fila"
            className="cartao flex flex-col gap-5 p-6"
          >
            <div className="flex items-center gap-2.5">
              <Clock aria-hidden className="h-4 w-4 text-aurora-1" />
              <h2 id="titulo-fila" className="font-display text-sm font-semibold text-ink">
                Fila de enriquecimento
              </h2>
            </div>

            {fila.st === 'carregando' && (
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Esqueleto key={i} className="h-[62px] rounded-[12px]" />
                ))}
              </div>
            )}
            {fila.st === 'erro' && (
              <BlocoErro msg={`Fila indisponível: ${fila.msg}. Verifique se o Redis está no ar.`} />
            )}
            {fila.st === 'ok' && (
              <div className="grid grid-cols-2 gap-3">
                {[
                  { r: 'Aguardando', v: fila.dados.aguardando, c: 'text-ink' },
                  { r: 'Ativos', v: fila.dados.ativos, c: 'text-marca-ciano' },
                  { r: 'Concluídos', v: fila.dados.concluidos, c: 'text-ok' },
                  {
                    r: 'Falhos',
                    v: fila.dados.falhos,
                    c: fila.dados.falhos > 0 ? 'text-erro' : 'text-muted',
                  },
                ].map((x) => (
                  <div
                    key={x.r}
                    className="rounded-[12px] border border-linha bg-superficie px-3.5 py-3"
                  >
                    <p className={cn('num text-lg font-semibold', x.c)}>
                      {x.v.toLocaleString('pt-BR')}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted">{x.r}</p>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-auto border-t border-linha pt-5">
              {consumo.st === 'carregando' && <Esqueleto className="h-10" />}
              {consumo.st === 'erro' && <BlocoErro msg={`Consumo indisponível: ${consumo.msg}`} />}
              {consumo.st === 'ok' && (
                <>
                  <div className="mb-2.5 flex items-center gap-2">
                    <Gauge aria-hidden className="h-3.5 w-3.5 text-muted" />
                    <span className="rotulo">Teto diário · {consumo.dados.provider}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-superficie">
                    <motion.div
                      className={cn(
                        'h-full rounded-full',
                        consumo.dados.percentual >= LIMIAR_CONSUMO_CRITICO
                          ? 'bg-alerta'
                          : 'bg-marca',
                      )}
                      initial={{
                        width: animar ? 0 : `${Math.min(consumo.dados.percentual, 100)}%`,
                      }}
                      animate={{ width: `${Math.min(consumo.dados.percentual, 100)}%` }}
                      transition={{
                        duration: animar ? 1.2 : 0,
                        ease: [0.16, 1, 0.3, 1],
                        delay: animar ? 0.5 : 0,
                      }}
                    />
                  </div>
                  <p className="num mt-2 text-[11px] text-muted">
                    {consumo.dados.usadas.toLocaleString('pt-BR')} de{' '}
                    {consumo.dados.teto.toLocaleString('pt-BR')} consultas hoje
                  </p>
                </>
              )}
            </div>
          </motion.section>
          )}
        </div>

        {/* ── Atividade recente + Alertas ── */}
        <div className={`mt-5 grid items-start gap-5 ${soInterno ? 'xl:grid-cols-2' : ''}`}>
        {soInterno && (
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          aria-labelledby="titulo-importacoes"
          className="cartao p-6"
        >
          <div className="mb-5 flex items-center gap-2.5">
            <FileText aria-hidden className="h-4 w-4 text-aurora-3" />
            <h2 id="titulo-importacoes" className="font-display text-sm font-semibold text-ink">
              Importações recentes
            </h2>
          </div>
          {importacoes.st === 'carregando' && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Esqueleto key={i} className="h-12 rounded-[12px]" />
              ))}
            </div>
          )}
          {importacoes.st === 'erro' && (
            <BlocoErro msg={`Não foi possível listar as importações: ${importacoes.msg}`} />
          )}
          {importacoes.st === 'ok' && importacoes.dados.length === 0 && (
            <p className="text-[12px] text-muted">Nenhuma importação registrada ainda.</p>
          )}
          {importacoes.st === 'ok' && importacoes.dados.length > 0 && (
            <ul className="space-y-1">
              {importacoes.dados.map((imp, i) => {
                const ok = imp.falhas === 0;
                return (
                  <motion.li
                    key={imp.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.66 + i * 0.06, duration: 0.45 }}
                    className="flex items-center gap-3.5 rounded-[12px] px-3 py-2.5 transition-colors hover:bg-superficie-2"
                  >
                    {ok ? (
                      <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-ok" />
                    ) : (
                      <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-alerta" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-ink-2" title={imp.arquivoNome}>
                        {imp.arquivoNome}
                      </p>
                      <p className="text-[11px] text-muted-2">
                        {new Date(imp.criadoEm).toLocaleDateString('pt-BR', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        · {imp.user.nome}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-[13px] text-ink">{compacto(imp.sucesso)}</p>
                      <p className="text-[10px] text-muted-2">
                        {imp.falhas > 0 ? `${imp.falhas} falhas` : 'sem falhas'}
                      </p>
                    </div>
                  </motion.li>
                );
              })}
            </ul>
          )}
        </motion.section>
        )}

          <Alertas
            operacao={painel.st === 'ok' ? painel.dados.operacao : null}
            /* Para o cliente não existe fila: os alertas dele saem só da operação
               da própria carteira (tarefas, prazos), nunca do enriquecimento. */
            fila={soInterno && fila.st === 'ok' ? fila.dados : null}
            /* Nem fôlego: "a sua base está acabando" é conversa comercial que a
               operação tem COM ele, não um aviso na tela dele. */
            folego={soInterno ? (folegoQ.data ?? null) : null}
            carregando={painel.st === 'carregando'}
          />
        </div>
      </div>
    </div>
  );
}
