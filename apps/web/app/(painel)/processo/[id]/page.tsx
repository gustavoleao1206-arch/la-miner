'use client';

import { faseExigivel, SeloFase, ValorIndicativo } from '@/components/fase-processo';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  BellRing,
  Building2,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Eye,
  FileText,
  FileUp,
  Flag,
  Gavel,
  Landmark,
  ListChecks,
  Loader2,
  Lock,
  Mail,
  MapPin,
  MessageCircle,
  MessageSquare,
  Phone,
  Pin,
  Plus,
  RefreshCw,
  RotateCw,
  SearchX,
  Sparkles,
  Tag,
  Trash2,
  UserCircle2,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  ErroApi,
  api,
  crm,
  type Anotacao,
  type Etiqueta,
  type EtiquetaComUso,
  type EventoProcesso,
  type MembroEquipe,
  type PapelProcessual,
  type ParteProcesso,
  type Prioridade,
  type ProcessoDetalhe,
  type StatusEnriquecimento,
  type Tarefa,
  type TipoEventoProcesso,
  type TipoTarefa,
} from '@/lib/api';
import { brl, cn, cpfFormatado, dataCalendario, diaISO, diaLegivel, hojeISO } from '@/lib/utils';
import { CartaoKpi, Esqueleto } from '@/components/metricas';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';
import { FunilProcesso } from '@/components/crm/funil-processo';
import { NegociacaoProcesso } from '@/components/crm/negociacao-processo';
import { useUsuario } from '@/lib/usuario';

/* Lucide aceita Booleanish em aria-hidden; restringir a boolean rejeita os
   ícones. Mesma convenção de consulta/page.tsx e components/metricas.tsx. */
type IconeDecorativo = React.ComponentType<{ className?: string }>;

const STATUS: Record<StatusEnriquecimento, { rotulo: string; cor: string; Icone: IconeDecorativo }> = {
  SINCRONIZADO: { rotulo: 'Enriquecido', cor: 'border-ok/25 bg-ok/10 text-ok', Icone: CheckCircle2 },
  PENDENTE: { rotulo: 'Pendente', cor: 'border-linha bg-superficie text-muted', Icone: Clock },
  SEM_DADOS: { rotulo: 'Sem dados', cor: 'border-alerta/25 bg-alerta/10 text-alerta', Icone: AlertTriangle },
  ERRO: { rotulo: 'Erro', cor: 'border-erro/25 bg-erro/10 text-erro', Icone: XCircle },
};

/**
 * Prioridade em ordem CRESCENTE de urgência — a mesma do enum no banco.
 *
 * A ordem do objeto é a ordem dos botões na tela. Trocá-la aqui reordena o
 * controle sem tocar em JSX, mas também quebraria a leitura de quem espera
 * "baixa à esquerda, urgente à direita"; é ordenação semântica, não estética.
 */
const PRIORIDADE: Record<Prioridade, { rotulo: string; cor: string; ativo: string }> = {
  BAIXA: { rotulo: 'Baixa', cor: 'text-muted', ativo: 'border-linha-2 bg-superficie-2 text-ink-2' },
  NORMAL: { rotulo: 'Normal', cor: 'text-muted', ativo: 'border-linha-2 bg-superficie-2 text-ink-2' },
  ALTA: { rotulo: 'Alta', cor: 'text-muted', ativo: 'border-alerta/30 bg-alerta/10 text-alerta' },
  URGENTE: { rotulo: 'Urgente', cor: 'text-muted', ativo: 'border-erro/30 bg-erro/10 text-erro' },
};

const ORDEM_PRIORIDADE = Object.keys(PRIORIDADE) as Prioridade[];

/** Classes por token de cor de etiqueta. Mapa fechado: Tailwind não vê classe montada em runtime. */
const COR_ETIQUETA: Record<string, string> = {
  'marca-ciano': 'border-marca-ciano/30 bg-marca-ciano/10 text-marca-ciano',
  'marca-azul': 'border-marca-azul/30 bg-marca-azul/10 text-marca-azul',
  'marca-violeta': 'border-marca-violeta/30 bg-marca-violeta/10 text-marca-violeta',
  'marca-ouro': 'border-marca-ouro/30 bg-marca-ouro/10 text-marca-ouro',
  ok: 'border-ok/25 bg-ok/10 text-ok',
  alerta: 'border-alerta/25 bg-alerta/10 text-alerta',
  erro: 'border-erro/25 bg-erro/10 text-erro',
};

const corEtiqueta = (cor: string) => COR_ETIQUETA[cor] ?? COR_ETIQUETA['marca-ciano'];

const PAPEL: Record<PapelProcessual, string> = {
  REQUERENTE: 'Requerente',
  EXEQUENTE: 'Exequente',
  CESSIONARIO: 'Cessionário',
  ESPOLIO: 'Espólio',
  OUTRO: 'Outro',
};

/**
 * Identidade visual de cada tipo de evento.
 *
 * Cor por SIGNIFICADO, não por decoração: importação é neutra (aconteceu),
 * atualização é ciano (o sistema corrigiu algo sozinho), acesso do cliente é
 * âmbar (alguém de fora leu o processo — é o que se audita depois).
 */
const EVENTO: Record<TipoEventoProcesso, { rotulo: string; Icone: IconeDecorativo; cor: string }> = {
  IMPORTADO: { rotulo: 'Importado', Icone: FileUp, cor: 'border-linha-2 bg-superficie text-muted' },
  DADO_ATUALIZADO: {
    rotulo: 'Dado atualizado',
    Icone: RefreshCw,
    cor: 'border-marca-ciano/30 bg-marca-ciano/10 text-marca-ciano',
  },
  ENRIQUECIDO: { rotulo: 'Enriquecido', Icone: Sparkles, cor: 'border-ok/25 bg-ok/10 text-ok' },
  STATUS_ALTERADO: {
    rotulo: 'Status alterado',
    Icone: Gavel,
    cor: 'border-marca-violeta/30 bg-marca-violeta/10 text-marca-violeta',
  },
  OBSERVACAO: { rotulo: 'Anotação', Icone: MessageSquare, cor: 'border-linha-2 bg-superficie text-ink-2' },
  ACESSO_CLIENTE: { rotulo: 'Acesso do cliente', Icone: Eye, cor: 'border-alerta/25 bg-alerta/10 text-alerta' },
};

/**
 * Rótulos legíveis dos campos que aparecem num diff.
 *
 * É só apresentação — a fonte da verdade é CAMPOS_LOGAVEIS, no motor de diff do
 * backend. Manter uma cópia aqui evita acoplar o front ao pacote do banco; o
 * pior caso de divergência é a tela mostrar o nome cru do campo, nunca um dado
 * errado, e por isso o acesso abaixo cai em `?? campo`.
 */
const ROTULO_CAMPO: Record<string, string> = {
  numeroOriginario: 'número do processo originário',
  numeroRequisitorio: 'número do requisitório',
  vara: 'vara',
  entidadeDevedora: 'entidade devedora',
  natureza: 'natureza',
  situacao: 'situação',
  valor: 'valor',
  exercicio: 'exercício',
  dataAutuacao: 'data de autuação',
};

function dataHora(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* Data de calendário (nascimento, autuação, prazo) vem de `lib/utils`: a regra
   de fuso é a mesma em toda tela e já errou uma vez morando aqui dentro.
   `dataHora` abaixo continua local — instante se lê no fuso de quem lê. */
const dataCurta = dataCalendario;

function telefone(t: ParteProcesso['pessoa']['telefones'][number]) {
  const n = t.numero.replace(/\D/g, '');
  const local = n.length === 9 ? `${n.slice(0, 5)}-${n.slice(5)}` : n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
  return t.ddd ? `(${t.ddd}) ${local}` : local;
}

function endereco(e: ParteProcesso['pessoa']['enderecos'][number]) {
  const rua = [e.logradouro, e.numero, e.complemento].filter(Boolean).join(', ');
  const local = [e.bairro, [e.cidade, e.uf].filter(Boolean).join('/')].filter(Boolean).join(' · ');
  const cep = e.cep ? `CEP ${e.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : '';
  return [rua, local, cep].filter(Boolean).join(' — ') || '—';
}

/** Valor de um lado do de/para, já legível. `null` no diff = campo estava vazio. */
function ladoDoDiff(campo: string, v: string | number | null) {
  if (v === null) return '(vazio)';
  if (campo === 'dataAutuacao' && typeof v === 'string') return dataCurta(v);
  return String(v);
}

export default function ProcessoPage() {
  const { id } = useParams<{ id: string }>();
  const { podeDarBaixa } = useUsuario();
  const [processo, setProcesso] = useState<Estado<ProcessoDetalhe>>(CARREGANDO);
  /* 404 à parte do erro genérico: "este processo não existe" é uma resposta
     definitiva, e oferecer "Tentar novamente" nela empurraria o operador a
     repetir uma chamada que vai falhar igual. Erro de rede, sim, vale repetir. */
  const [ausente, setAusente] = useState(false);

  const carregar = useCallback(async () => {
    if (!id) return;
    setProcesso(CARREGANDO);
    setAusente(false);
    try {
      setProcesso({ st: 'ok', dados: await api<ProcessoDetalhe>(`/carteira/processos/${id}`) });
    } catch (e) {
      if (e instanceof ErroApi && e.status === 404) setAusente(true);
      setProcesso({ st: 'erro', msg: (e as Error).message });
    }
  }, [id]);

  /**
   * Carrega uma vez por processo — e uma vez só.
   *
   * Abrir esta página GRAVA uma linha de auditoria no servidor: é consulta a
   * dado pessoal. Com `reactStrictMode: true`, o React dispara o efeito duas
   * vezes em desenvolvimento, o que gravaria DOIS acessos a cada abertura e
   * inflaria justamente o registro que existe para demonstrar conformidade com
   * a LGPD — contra uma base que tem gente real.
   *
   * Abortar a primeira requisição não resolveria: quando o cliente desiste, o
   * servidor já recebeu a chamada e já escreveu a linha. Daí a trava ser aqui,
   * antes de sair. A chave é o `id`, então navegar para outro processo carrega
   * normalmente, e o botão "Tentar novamente" chama `carregar` direto, sem
   * passar por ela.
   */
  const idCarregado = useRef<string | null>(null);
  useEffect(() => {
    if (!id || idCarregado.current === id) return;
    idCarregado.current = id;
    void carregar();
  }, [id, carregar]);

  /* A equipe é a MESMA para o seletor de responsável do processo e o das
     tarefas. Buscar aqui em cima e passar para baixo evita a chamada duplicada
     que aparecia na rede quando cada seção pedia a sua. Falha em silêncio: sem
     a lista os seletores ficam só com "sem responsável", e derrubar a página
     inteira por causa de um combo seria desproporcional. */
  const [equipe, setEquipe] = useState<MembroEquipe[]>([]);
  useEffect(() => {
    crm.equipe().then(setEquipe).catch(() => setEquipe([]));
  }, []);

  const p = processo.st === 'ok' ? processo.dados : null;

  /* Aplica o resultado de uma escrita sem reler o processo do servidor. Um
     refetch gravaria OUTRA linha de auditoria de acesso a dado pessoal, e
     mudar prioridade não é consultar o titular de novo. */
  const aplicar = useCallback((patch: Partial<ProcessoDetalhe>) => {
    setProcesso((atual) =>
      atual.st === 'ok' ? { st: 'ok', dados: { ...atual.dados, ...patch } } : atual,
    );
  }, []);

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute -right-40 -top-40 h-[36rem] w-[36rem] rounded-full opacity-[0.13] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#6366f1,transparent 68%)' }}
          animate={{ x: [0, -40, 0], y: [0, 40, 0] }}
          transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -left-32 top-1/3 h-[30rem] w-[30rem] rounded-full opacity-[0.1] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#22d3ee,transparent 68%)' }}
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 24, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
        />
      </div>

      <div className="relative p-6 lg:p-9">
        {/* Nenhum item da navegação lateral corresponde a esta rota, então o
            caminho de volta precisa estar na própria página. */}
        <Link
          href="/consulta"
          className="mb-5 inline-flex items-center gap-2 rounded-sm px-2 py-1 text-[12px] text-muted transition-colors hover:bg-superficie hover:text-ink-2"
        >
          <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
          Voltar para a consulta
        </Link>

        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-7"
        >
          {/* ⚠ O RÓTULO SEGUE A FASE, e não é decoração.
              Ele dizia "Precatório" para tudo. Num pré-precatório isso é
              simplesmente falso: o precatório ainda não existe, e o número
              exibido abaixo é o do PROCESSO. Chamar as duas coisas pelo mesmo
              nome na tela onde o advogado decide a abordagem é o tipo de
              imprecisão que ele descobre depois de ligar para o titular. */}
          <p className="rotulo">
            {p
              ? `${p.fase === 'PRECATORIO_EXPEDIDO' ? 'Precatório' : 'Pré-precatório'} · ${p.tribunal.sigla}` +
                (p.exercicio ? ` · Exercício ${p.exercicio}` : '')
              : 'Processo'}
          </p>
          <h1 className="num mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            {p ? p.numeroPrecatorio : <Esqueleto className="h-8 w-[22rem]" />}
          </h1>
          {p && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <SeloFase fase={p.fase} />
              <ValorIndicativo valor={p.valorIndicativo} className="text-[12px]" />
            </div>
          )}
          {p?.situacao && (
            <p className="mt-2.5 inline-flex max-w-full items-start gap-2 rounded-[11px] border border-linha bg-superficie px-3 py-1.5 text-[12px] text-ink-2">
              <Gavel aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-marca-ciano" />
              <span className="min-w-0">{p.situacao}</span>
            </p>
          )}
        </motion.header>

        {ausente && (
          <div className="cartao" role="alert">
            <Vazio
              Icone={SearchX}
              titulo="Processo não encontrado"
              descricao="O endereço pode estar errado, ou o processo pertence a outra organização."
              acao={
                <Link
                  href="/consulta"
                  className="flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
                >
                  <ArrowLeft aria-hidden className="h-3.5 w-3.5" />
                  Ir para a consulta
                </Link>
              }
            />
          </div>
        )}

        {processo.st === 'erro' && !ausente && (
          <div className="cartao border-erro/25 p-6" role="alert">
            <BlocoErro msg={`Não foi possível carregar o processo: ${processo.msg}`} />
            <button
              type="button"
              onClick={() => void carregar()}
              className="mt-4 flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
            >
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              Tentar novamente
            </button>
          </div>
        )}

        {processo.st === 'carregando' && (
          <div aria-busy="true">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Esqueleto key={i} className="h-[132px] rounded" />
              ))}
            </div>
            <div className="mt-5 grid gap-5 lg:grid-cols-3">
              <Esqueleto className="h-[26rem] rounded lg:col-span-2" />
              <Esqueleto className="h-[26rem] rounded" />
            </div>
          </div>
        )}

        {p && (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {/* ── O MAIOR NÚMERO DA TELA TEM DE SER O QUE EXISTE ──
                  Num pré-precatório `valor` é NULO, e `brl(null)` devolve "—".
                  O cartão de DESTAQUE dizia então "Valor do precatório: —"
                  enquanto o cabeçalho logo acima já mostrava "~R$ 250.000
                  estimado": o número existia e o lugar mais visível da página o
                  ignorava, com um travessão que se lê como dado faltando.

                  O rótulo segue a `faseExigivel` — a mesma régua do selo —, e
                  não a presença do valor: fase desconhecida devolve `undefined`,
                  cai em "Valor do crédito" e não afirma. */}
              <CartaoKpi
                Icone={Banknote}
                rotulo={faseExigivel(p.fase) ? 'Valor do precatório' : 'Valor do crédito'}
                indice={0}
                destaque
              >
                {p.valor !== null ? (
                  <span className="num texto-marca">{brl(p.valor)}</span>
                ) : p.valorIndicativo !== null ? (
                  /* O til e a palavra "estimado" viajam junto com o número, aqui
                     como em toda parte: é palpite extraído do texto da
                     publicação, e no cartão de destaque isso pesa mais. */
                  <ValorIndicativo valor={p.valorIndicativo} className="num text-[19px]" />
                ) : (
                  <span className="num texto-marca">—</span>
                )}
              </CartaoKpi>
              <CartaoKpi Icone={Landmark} rotulo="Entidade devedora" indice={1}>
                <span className="text-[19px]">{p.entidadeDevedora ?? '—'}</span>
              </CartaoKpi>
              <CartaoKpi
                Icone={Users}
                rotulo="Partes"
                indice={2}
                sub={p.partes.length === 1 ? PAPEL[p.partes[0].papel] : undefined}
              >
                <span className="num">{p.partes.length}</span>
              </CartaoKpi>
              <CartaoKpi Icone={FileText} rotulo="Natureza" indice={3}>
                <span className="text-[19px]">{p.natureza ?? '—'}</span>
              </CartaoKpi>
            </div>

            <BarraCrm processo={p} equipe={equipe} aoAtualizar={aplicar} />

            {/* O funil vem LOGO ABAIXO da triagem e ACIMA de tarefas e
                anotações: é a pergunta que o operador responde primeiro ao
                abrir um processo — em que pé isto está, e quando falei com o
                titular pela última vez. */}
            <FunilProcesso
              processoId={p.id}
              estagio={p.estagio}
              estagioEm={p.estagioEm}
              motivoPerda={p.motivoPerda}
              ultimoContatoEm={p.ultimoContatoEm}
              aoAtualizar={aplicar}
            />

            {/* A negociação vem LOGO DEPOIS do funil, e antes de tarefas e
                anotações: quem abre um processo em PROPOSTA quer ver o número
                antes de qualquer outra coisa — e é o único bloco da tela que
                fala de dinheiro do NEGÓCIO, e não do valor de face. */}
            <NegociacaoProcesso processoId={p.id} podeDarBaixa={podeDarBaixa} esferaTribunal={p.tribunal.esfera} exercicio={p.exercicio} />

            <div className="mt-5 grid items-start gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                <Tarefas
                  processoId={p.id}
                  tarefas={p.tarefas}
                  equipe={equipe}
                  aoAtualizar={aplicar}
                />
                <Anotacoes processoId={p.id} anotacoes={p.anotacoes} aoAtualizar={aplicar} />
                <DadosDoProcesso processo={p} />
                <Partes partes={p.partes} />
              </div>
              <LinhaDoTempo
                eventos={p.eventos}
                total={p.totalEventos}
                truncada={p.eventosTruncados}
                atualizadoEm={p.editadoEm}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Barra de controle do CRM ──

/**
 * Prioridade, responsável e etiquetas.
 *
 * Escreve direto e avisa o pai pelo `aoAtualizar`, em vez de recarregar o
 * processo: um refetch dispararia OUTRA linha de auditoria de acesso a dado
 * pessoal, e trocar de prioridade não é consultar o titular de novo. O preço é
 * a tela guardar seu próprio estado; o benefício é o registro da LGPD contar
 * acessos, não cliques.
 */
function BarraCrm({
  processo: p,
  equipe,
  aoAtualizar,
}: {
  processo: ProcessoDetalhe;
  equipe: MembroEquipe[];
  aoAtualizar: (patch: Partial<ProcessoDetalhe>) => void;
}) {
  const [vocabulario, setVocabulario] = useState<EtiquetaComUso[]>([]);
  const [editandoEtiquetas, setEditandoEtiquetas] = useState(false);
  const [novaEtiqueta, setNovaEtiqueta] = useState('');
  const [salvando, setSalvando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /* O vocabulário de etiquetas fica aqui porque só este componente usa; a
     equipe subiu para a página, que a compartilha com as tarefas — antes as
     duas seções pediam a mesma lista, e a rede mostrava a chamada repetida. */
  const carregarVocabulario = useCallback(async () => {
    try {
      setVocabulario(await crm.listarEtiquetas());
    } catch (err) {
      setErro((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void carregarVocabulario();
  }, [carregarVocabulario]);

  async function comSalvamento<T>(chave: string, fn: () => Promise<T>) {
    setSalvando(chave);
    setErro(null);
    try {
      return await fn();
    } catch (e) {
      setErro((e as Error).message);
      return null;
    } finally {
      setSalvando(null);
    }
  }

  async function mudarPrioridade(prioridade: Prioridade) {
    if (prioridade === p.prioridade) return;
    const r = await comSalvamento('prioridade', () => crm.definirPrioridade(p.id, prioridade));
    if (r) aoAtualizar({ prioridade: r.prioridade });
  }

  async function mudarResponsavel(valor: string) {
    const responsavelId = valor === '' ? null : valor;
    const r = await comSalvamento('responsavel', () => crm.definirResponsavel(p.id, responsavelId));
    if (r) {
      aoAtualizar({
        responsavel: responsavelId ? (equipe.find((m) => m.id === responsavelId) ?? null) : null,
      });
    }
  }

  async function alternarEtiqueta(etiqueta: Etiqueta) {
    const tem = p.etiquetas.some((e) => e.id === etiqueta.id);
    const proximas = tem
      ? p.etiquetas.filter((e) => e.id !== etiqueta.id)
      : [...p.etiquetas, etiqueta];
    const r = await comSalvamento(`etiqueta:${etiqueta.id}`, () =>
      crm.definirEtiquetas(p.id, proximas.map((e) => e.id)),
    );
    if (r) aoAtualizar({ etiquetas: r.map((v) => v.etiqueta) });
  }

  async function criarEAplicar() {
    const nome = novaEtiqueta.trim();
    if (!nome) return;
    const criada = await comSalvamento('nova', async () => {
      const etiqueta = await crm.criarEtiqueta(nome);
      const vinculos = await crm.definirEtiquetas(p.id, [
        ...new Set([...p.etiquetas.map((e) => e.id), etiqueta.id]),
      ]);
      return { etiqueta, vinculos };
    });
    if (criada) {
      aoAtualizar({ etiquetas: criada.vinculos.map((v) => v.etiqueta) });
      setNovaEtiqueta('');
      void carregarVocabulario(); // a nova entra na lista de sugestões
    }
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-crm"
      className="cartao mt-5 p-6"
    >
      <h2 id="titulo-crm" className="sr-only">
        Acompanhamento do processo
      </h2>

      <div className="flex flex-wrap items-start gap-x-10 gap-y-6">
        {/* Prioridade */}
        <div>
          <p className="rotulo mb-2 flex items-center gap-1.5">
            <Flag aria-hidden className="h-3 w-3" />
            Prioridade
          </p>
          <div role="group" aria-label="Prioridade do processo" className="flex flex-wrap gap-1.5">
            {ORDEM_PRIORIDADE.map((nivel) => {
              const ativo = p.prioridade === nivel;
              return (
                <button
                  key={nivel}
                  type="button"
                  aria-pressed={ativo}
                  disabled={salvando === 'prioridade'}
                  onClick={() => void mudarPrioridade(nivel)}
                  className={cn(
                    'rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                    ativo
                      ? PRIORIDADE[nivel].ativo
                      : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
                  )}
                >
                  {PRIORIDADE[nivel].rotulo}
                </button>
              );
            })}
          </div>
        </div>

        {/* Responsável */}
        <div className="min-w-[13rem]">
          <label htmlFor="responsavel" className="rotulo mb-2 flex items-center gap-1.5">
            <UserCircle2 aria-hidden className="h-3 w-3" />
            Responsável
          </label>
          <div className="relative">
            <select
              id="responsavel"
              value={p.responsavel?.id ?? ''}
              disabled={salvando === 'responsavel'}
              onChange={(e) => void mudarResponsavel(e.target.value)}
              className="h-9 w-full appearance-none rounded-[11px] border border-linha bg-superficie px-3 pr-9 text-[13px] text-ink-2 transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:outline-none disabled:opacity-60"
            >
              <option value="">Sem responsável</option>
              {equipe.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nome}
                </option>
              ))}
            </select>
            <ChevronDown
              aria-hidden
              className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted"
            />
          </div>
        </div>

        {/* Etiquetas */}
        <div className="min-w-0 flex-1">
          <p className="rotulo mb-2 flex items-center gap-1.5">
            <Tag aria-hidden className="h-3 w-3" />
            Etiquetas
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {p.etiquetas.map((e) => (
              <span
                key={e.id}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                  corEtiqueta(e.cor),
                )}
              >
                {e.nome}
                <button
                  type="button"
                  onClick={() => void alternarEtiqueta(e)}
                  aria-label={`Remover etiqueta ${e.nome}`}
                  className="opacity-60 transition-opacity hover:opacity-100"
                >
                  <X aria-hidden className="h-3 w-3" />
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setEditandoEtiquetas((v) => !v)}
              aria-expanded={editandoEtiquetas}
              aria-controls="painel-etiquetas"
              className="flex items-center gap-1 rounded-full border border-linha px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-linha-2 hover:bg-superficie hover:text-ink-2"
            >
              <Plus aria-hidden className="h-3 w-3" />
              {p.etiquetas.length === 0 ? 'Adicionar etiqueta' : 'Editar'}
            </button>
          </div>

          {editandoEtiquetas && (
            <motion.div
              id="painel-etiquetas"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="mt-3 rounded-[12px] border border-linha bg-superficie p-3"
            >
              {vocabulario.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {vocabulario.map((e) => {
                    const aplicada = p.etiquetas.some((x) => x.id === e.id);
                    return (
                      <button
                        key={e.id}
                        type="button"
                        aria-pressed={aplicada}
                        disabled={salvando === `etiqueta:${e.id}`}
                        onClick={() => void alternarEtiqueta(e)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-60',
                          aplicada ? corEtiqueta(e.cor) : 'border-linha text-muted hover:bg-superficie-2',
                        )}
                      >
                        {aplicada && <Check aria-hidden className="h-3 w-3" />}
                        {e.nome}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <input
                  value={novaEtiqueta}
                  onChange={(e) => setNovaEtiqueta(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void criarEAplicar();
                    }
                  }}
                  maxLength={40}
                  placeholder="Nova etiqueta…"
                  aria-label="Nome da nova etiqueta"
                  className="h-8 min-w-0 flex-1 rounded-[10px] border border-linha bg-bg-2 px-2.5 text-[12px] text-ink placeholder:text-muted-2 focus:border-marca-ciano/40 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void criarEAplicar()}
                  disabled={!novaEtiqueta.trim() || salvando === 'nova'}
                  className="flex h-8 items-center gap-1.5 rounded-[10px] border border-linha px-3 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie-2 disabled:opacity-40"
                >
                  {salvando === 'nova' ? (
                    <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                  ) : (
                    <Plus aria-hidden className="h-3 w-3" />
                  )}
                  Criar
                </button>
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {erro && <BlocoErro msg={erro} className="mt-4" />}
    </motion.section>
  );
}

// ── Tarefas e follow-ups ──

const TIPO_TAREFA: Record<TipoTarefa, { rotulo: string; Icone: IconeDecorativo }> = {
  TAREFA: { rotulo: 'Tarefa', Icone: ListChecks },
  FOLLOW_UP: { rotulo: 'Follow-up', Icone: BellRing },
};

function Tarefas({
  processoId,
  tarefas,
  equipe,
  aoAtualizar,
}: {
  processoId: string;
  tarefas: Tarefa[];
  equipe: MembroEquipe[];
  aoAtualizar: (patch: Partial<ProcessoDetalhe>) => void;
}) {
  const [titulo, setTitulo] = useState('');
  const [prazo, setPrazo] = useState('');
  const [tipo, setTipo] = useState<TipoTarefa>('TAREFA');
  const [responsavelId, setResponsavelId] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [verConcluidas, setVerConcluidas] = useState(false);

  const hoje = hojeISO();
  const pendentes = tarefas.filter((t) => !t.concluidaEm);
  const concluidas = tarefas.filter((t) => t.concluidaEm);
  const atrasadas = pendentes.filter((t) => t.prazo && diaISO(t.prazo) < hoje).length;

  /* Reordena igual ao backend, senão uma tarefa recém-concluída só desceria na
     próxima abertura da página e pareceria que o clique não pegou. */
  const ordenar = (lista: Tarefa[]) =>
    [...lista].sort(
      (a, b) =>
        Number(Boolean(a.concluidaEm)) - Number(Boolean(b.concluidaEm)) ||
        // Sem prazo vai para o fim, nunca para o topo.
        (a.prazo ? diaISO(a.prazo) : '9999-99-99').localeCompare(
          b.prazo ? diaISO(b.prazo) : '9999-99-99',
        ) ||
        new Date(a.criadoEm).getTime() - new Date(b.criadoEm).getTime(),
    );

  async function criar() {
    const limpo = titulo.trim();
    if (!limpo) return;
    setSalvando(true);
    setErro(null);
    try {
      const nova = await crm.criarTarefa(processoId, {
        titulo: limpo,
        tipo,
        prazo: prazo || null,
        responsavelId: responsavelId || null,
      });
      aoAtualizar({ tarefas: ordenar([...tarefas, nova]) });
      setTitulo('');
      setPrazo('');
      setResponsavelId('');
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  async function alterar(t: Tarefa, dados: Parameters<typeof crm.editarTarefa>[2]) {
    setOcupada(t.id);
    setErro(null);
    try {
      const atualizada = await crm.editarTarefa(processoId, t.id, dados);
      aoAtualizar({ tarefas: ordenar(tarefas.map((x) => (x.id === t.id ? atualizada : x))) });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupada(null);
    }
  }

  async function remover(t: Tarefa) {
    if (!window.confirm(`Remover "${t.titulo}"? Não há como desfazer.`)) return;
    setOcupada(t.id);
    setErro(null);
    try {
      await crm.removerTarefa(processoId, t.id);
      aoAtualizar({ tarefas: tarefas.filter((x) => x.id !== t.id) });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupada(null);
    }
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.32, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-tarefas"
      className="cartao p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="titulo-tarefas" className="font-display text-sm font-semibold text-ink">
          Tarefas e follow-ups
        </h2>
        <div className="flex items-center gap-3">
          {/* O número que muda a conduta de quem abre o processo vem primeiro. */}
          {atrasadas > 0 && (
            <span
              role="status"
              className="flex items-center gap-1.5 rounded-full border border-erro/30 bg-erro/10 px-2.5 py-1 text-[11px] font-medium text-erro"
            >
              <AlertTriangle aria-hidden className="h-3 w-3" />
              <span className="num">{atrasadas}</span> em atraso
            </span>
          )}
          <span className="rotulo num">
            {pendentes.length} {pendentes.length === 1 ? 'pendente' : 'pendentes'}
          </span>
        </div>
      </div>

      {/* Composer */}
      <div className="mt-4 space-y-2.5">
        <input
          value={titulo}
          onChange={(e) => setTitulo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void criar();
            }
          }}
          maxLength={300}
          placeholder="O que precisa ser feito?"
          aria-label="Título da tarefa"
          className="h-10 w-full rounded-[12px] border border-linha bg-superficie px-3.5 text-[13px] text-ink placeholder:text-muted-2 focus:border-marca-ciano/40 focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Tipo" className="flex gap-1.5">
            {(Object.keys(TIPO_TAREFA) as TipoTarefa[]).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tipo === t}
                onClick={() => setTipo(t)}
                className={cn(
                  'flex items-center gap-1.5 rounded-[10px] border px-2.5 py-1.5 text-[12px] transition-colors',
                  tipo === t
                    ? 'border-marca-ciano/30 bg-marca-ciano/10 text-marca-ciano'
                    : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
                )}
              >
                {TIPO_TAREFA[t].rotulo}
              </button>
            ))}
          </div>

          <label className="sr-only" htmlFor="prazo-nova">
            Prazo
          </label>
          {/* type="date" devolve exatamente "AAAA-MM-DD", que é o formato que a
              API exige — nenhuma conversão de fuso no caminho. */}
          <input
            id="prazo-nova"
            type="date"
            value={prazo}
            onChange={(e) => setPrazo(e.target.value)}
            className="h-8 rounded-[10px] border border-linha bg-superficie px-2.5 text-[12px] text-ink-2 focus:border-marca-ciano/40 focus:outline-none"
          />

          <label className="sr-only" htmlFor="resp-nova">
            Responsável pela tarefa
          </label>
          <select
            id="resp-nova"
            value={responsavelId}
            onChange={(e) => setResponsavelId(e.target.value)}
            className="h-8 rounded-[10px] border border-linha bg-superficie px-2.5 text-[12px] text-ink-2 focus:border-marca-ciano/40 focus:outline-none"
          >
            <option value="">Sem responsável</option>
            {equipe.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome}
              </option>
            ))}
          </select>

          <motion.button
            type="button"
            whileHover={{ scale: 1.015 }}
            whileTap={{ scale: 0.985 }}
            onClick={() => void criar()}
            disabled={!titulo.trim() || salvando}
            className="ml-auto flex h-8 items-center gap-1.5 rounded-[10px] border border-marca-ciano/30 bg-marca-ciano/10 px-3.5 text-[12px] font-medium text-marca-ciano transition-colors hover:bg-marca-ciano/15 disabled:opacity-40"
          >
            {salvando ? (
              <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
            ) : (
              <Plus aria-hidden className="h-3 w-3" />
            )}
            Adicionar
          </motion.button>
        </div>
      </div>

      {erro && <BlocoErro msg={erro} className="mt-3" />}

      {pendentes.length === 0 && concluidas.length === 0 ? (
        <p className="mt-5 border-t border-linha pt-5 text-[12px] leading-relaxed text-muted">
          Nada pendente neste processo. Use <strong className="text-ink-2">Follow-up</strong> para
          marcar uma data de voltar a olhar, e <strong className="text-ink-2">Tarefa</strong> para
          algo que alguém precisa fazer.
        </p>
      ) : (
        <ul className="mt-5 space-y-2 border-t border-linha pt-5">
          {pendentes.map((t, i) => (
            <ItemTarefa
              key={t.id}
              tarefa={t}
              indice={i}
              hoje={hoje}
              ocupada={ocupada === t.id}
              aoAlternar={() => void alterar(t, { concluida: true })}
              aoRemover={() => void remover(t)}
            />
          ))}
        </ul>
      )}

      {concluidas.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setVerConcluidas((v) => !v)}
            aria-expanded={verConcluidas}
            className="flex items-center gap-1.5 rounded-sm px-1 py-1 text-[12px] text-muted transition-colors hover:text-ink-2"
          >
            <ChevronDown
              aria-hidden
              className={cn('h-3.5 w-3.5 transition-transform', verConcluidas && 'rotate-180')}
            />
            <span className="num">{concluidas.length}</span>{' '}
            {concluidas.length === 1 ? 'concluída' : 'concluídas'}
          </button>
          {verConcluidas && (
            <ul className="mt-2 space-y-2">
              {concluidas.map((t, i) => (
                <ItemTarefa
                  key={t.id}
                  tarefa={t}
                  indice={i}
                  hoje={hoje}
                  ocupada={ocupada === t.id}
                  aoAlternar={() => void alterar(t, { concluida: false })}
                  aoRemover={() => void remover(t)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </motion.section>
  );
}

function ItemTarefa({
  tarefa: t,
  indice,
  hoje,
  ocupada,
  aoAlternar,
  aoRemover,
}: {
  tarefa: Tarefa;
  indice: number;
  hoje: string;
  ocupada: boolean;
  aoAlternar: () => void;
  aoRemover: () => void;
}) {
  const feita = Boolean(t.concluidaEm);
  const dia = t.prazo ? diaISO(t.prazo) : null;
  const atrasada = !feita && dia !== null && dia < hoje;
  const hojeMesmo = !feita && dia === hoje;
  const meta = TIPO_TAREFA[t.tipo] ?? TIPO_TAREFA.TAREFA;

  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(indice, 8) * 0.03, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'flex items-start gap-3 rounded-[12px] border p-3.5',
        atrasada ? 'border-erro/25 bg-erro/5' : 'border-linha bg-superficie',
      )}
    >
      <button
        type="button"
        onClick={aoAlternar}
        disabled={ocupada}
        role="checkbox"
        aria-checked={feita}
        aria-label={feita ? `Reabrir ${t.titulo}` : `Concluir ${t.titulo}`}
        className={cn(
          'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors disabled:opacity-40',
          feita
            ? 'border-ok/40 bg-ok/15 text-ok'
            : 'border-linha-2 text-transparent hover:border-marca-ciano/50 hover:bg-marca-ciano/10',
        )}
      >
        {ocupada ? (
          <Loader2 aria-hidden className="h-3 w-3 animate-spin text-muted" />
        ) : (
          <Check aria-hidden className="h-3 w-3" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'break-words text-[13px] leading-snug',
            feita ? 'text-muted line-through' : 'text-ink-2',
          )}
        >
          {t.titulo}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1 text-muted">
            <meta.Icone aria-hidden className="h-3 w-3" />
            {meta.rotulo}
          </span>
          {dia && (
            <span
              className={cn(
                'num flex items-center gap-1',
                atrasada ? 'font-medium text-erro' : hojeMesmo ? 'font-medium text-alerta' : 'text-muted',
              )}
            >
              <CalendarClock aria-hidden className="h-3 w-3" />
              {diaLegivel(t.prazo!)}
              {/* O rótulo textual existe para não depender só da cor. */}
              {atrasada && ' · atrasada'}
              {hojeMesmo && ' · hoje'}
            </span>
          )}
          {t.responsavel && (
            <span className="flex items-center gap-1 text-muted">
              <UserCircle2 aria-hidden className="h-3 w-3" />
              {t.responsavel.nome}
            </span>
          )}
          {feita && (
            <span className="num text-muted">concluída em {dataHora(t.concluidaEm!)}</span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={aoRemover}
        disabled={ocupada}
        aria-label={`Remover ${t.titulo}`}
        className="shrink-0 rounded-[9px] p-1.5 text-muted transition-colors hover:bg-erro/10 hover:text-erro disabled:opacity-40"
      >
        <Trash2 aria-hidden className="h-3.5 w-3.5" />
      </button>
    </motion.li>
  );
}

// ── Anotações ──

function Anotacoes({
  processoId,
  anotacoes,
  aoAtualizar,
}: {
  processoId: string;
  anotacoes: Anotacao[];
  aoAtualizar: (patch: Partial<ProcessoDetalhe>) => void;
}) {
  const [texto, setTexto] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  /* Reordena do mesmo jeito que o backend: fixadas primeiro, mais recente
     depois. Sem isto, uma anotação recém-fixada só subiria na próxima abertura
     da página — e o operador clicaria de novo achando que o botão falhou. */
  const ordenar = (lista: Anotacao[]) =>
    [...lista].sort(
      (a, b) =>
        Number(b.fixada) - Number(a.fixada) ||
        new Date(b.criadoEm).getTime() - new Date(a.criadoEm).getTime(),
    );

  async function criar() {
    const limpo = texto.trim();
    if (!limpo) return;
    setSalvando(true);
    setErro(null);
    try {
      const nova = await crm.criarAnotacao(processoId, limpo);
      aoAtualizar({ anotacoes: ordenar([nova, ...anotacoes]) });
      setTexto('');
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarFixada(a: Anotacao) {
    setOcupada(a.id);
    setErro(null);
    try {
      const atualizada = await crm.editarAnotacao(processoId, a.id, { fixada: !a.fixada });
      aoAtualizar({
        anotacoes: ordenar(anotacoes.map((x) => (x.id === a.id ? atualizada : x))),
      });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupada(null);
    }
  }

  async function remover(a: Anotacao) {
    /* Confirmação porque a exclusão é DEFINITIVA — a anotação não vai para uma
       lixeira. É esse mesmo apagar de verdade que torna possível atender um
       pedido de exclusão do titular, então não dá para amaciá-lo com soft
       delete; resta avisar antes. */
    if (!window.confirm('Remover esta anotação? Não há como desfazer.')) return;
    setOcupada(a.id);
    setErro(null);
    try {
      await crm.removerAnotacao(processoId, a.id);
      aoAtualizar({ anotacoes: anotacoes.filter((x) => x.id !== a.id) });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setOcupada(null);
    }
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-anotacoes"
      className="cartao p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="titulo-anotacoes" className="font-display text-sm font-semibold text-ink">
          Anotações
        </h2>
        <span className="rotulo num">{anotacoes.length}</span>
      </div>

      <div className="mt-4">
        <label htmlFor="nova-anotacao" className="sr-only">
          Nova anotação
        </label>
        <textarea
          id="nova-anotacao"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="O que aconteceu neste processo?"
          className="w-full resize-y rounded-[12px] border border-linha bg-superficie px-3.5 py-3 text-[13px] leading-relaxed text-ink placeholder:text-muted-2 focus:border-marca-ciano/40 focus:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          {/* Contador só perto do limite: mostrar 0/5000 o tempo todo é ruído. */}
          <span className="num text-[11px] text-muted">
            {texto.length > 4500 ? `${texto.length}/5000` : ''}
          </span>
          <motion.button
            type="button"
            whileHover={{ scale: 1.015 }}
            whileTap={{ scale: 0.985 }}
            onClick={() => void criar()}
            disabled={!texto.trim() || salvando}
            className="flex h-9 items-center gap-2 rounded-[11px] border border-marca-ciano/30 bg-marca-ciano/10 px-4 text-[13px] font-medium text-marca-ciano transition-colors hover:bg-marca-ciano/15 disabled:opacity-40"
          >
            {salvando ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageSquare aria-hidden className="h-3.5 w-3.5" />
            )}
            Anotar
          </motion.button>
        </div>
      </div>

      {erro && <BlocoErro msg={erro} className="mt-3" />}

      {anotacoes.length === 0 ? (
        <p className="mt-5 border-t border-linha pt-5 text-[12px] leading-relaxed text-muted">
          Nenhuma anotação ainda. O que for escrito aqui fica no processo, com autor e data — e
          pode ser editado ou apagado depois.
        </p>
      ) : (
        <ul className="mt-5 space-y-3 border-t border-linha pt-5">
          {anotacoes.map((a, i) => (
            <motion.li
              key={a.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: Math.min(i, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                'rounded-[12px] border p-4',
                a.fixada ? 'border-marca-ouro/30 bg-marca-ouro/5' : 'border-linha bg-superficie',
              )}
            >
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">
                {a.texto}
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="num text-[11px] text-muted">
                  {a.autor.nome} · {dataHora(a.criadoEm)}
                  {a.editadoEm !== a.criadoEm && ' · editada'}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void alternarFixada(a)}
                    disabled={ocupada === a.id}
                    aria-pressed={a.fixada}
                    aria-label={a.fixada ? 'Desafixar anotação' : 'Fixar anotação no topo'}
                    className={cn(
                      'rounded-[9px] p-1.5 transition-colors disabled:opacity-40',
                      a.fixada
                        ? 'text-marca-ouro hover:bg-marca-ouro/10'
                        : 'text-muted hover:bg-superficie-2 hover:text-ink-2',
                    )}
                  >
                    <Pin aria-hidden className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remover(a)}
                    disabled={ocupada === a.id}
                    aria-label="Remover anotação"
                    className="rounded-[9px] p-1.5 text-muted transition-colors hover:bg-erro/10 hover:text-erro disabled:opacity-40"
                  >
                    {ocupada === a.id ? (
                      <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 aria-hidden className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>
            </motion.li>
          ))}
        </ul>
      )}
    </motion.section>
  );
}

// ── Dados do processo ──

function Campo({ rotulo, children, mono }: { rotulo: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="rotulo">{rotulo}</dt>
      <dd className={cn('mt-1 break-words text-[13px] text-ink-2', mono && 'num')}>{children}</dd>
    </div>
  );
}

function DadosDoProcesso({ processo: p }: { processo: ProcessoDetalhe }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.28, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-dados"
      className="cartao p-6"
    >
      <h2 id="titulo-dados" className="font-display text-sm font-semibold text-ink">
        Dados do processo
      </h2>

      <dl className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
        <Campo rotulo={faseExigivel(p.fase) ? 'Número do precatório' : 'Número do processo'} mono>
          {p.numeroPrecatorio}
        </Campo>
        <Campo rotulo="Processo originário" mono>
          {p.numeroOriginario ?? '—'}
        </Campo>
        <Campo rotulo="Requisitório" mono>
          {p.numeroRequisitorio ?? '—'}
        </Campo>
        <Campo rotulo="Tribunal">
          {p.tribunal.sigla} — {p.tribunal.nome}
        </Campo>
        <Campo rotulo="Vara">{p.vara ?? '—'}</Campo>
        <Campo rotulo="Entidade devedora">{p.entidadeDevedora ?? '—'}</Campo>
        <Campo rotulo="Natureza">{p.natureza ?? '—'}</Campo>
        <Campo rotulo="Exercício" mono>
          {p.exercicio ?? '—'}
        </Campo>
        <Campo rotulo="Data de autuação" mono>
          {dataCurta(p.dataAutuacao)}
        </Campo>
        <Campo rotulo="Valor" mono>
          {brl(p.valor)}
        </Campo>
        <div className="sm:col-span-2">
          <Campo rotulo="Situação">{p.situacao ?? '—'}</Campo>
        </div>
        <div className="sm:col-span-2">
          <Campo rotulo="Origem do dado">{p.fonte ?? '—'}</Campo>
        </div>
      </dl>
    </motion.section>
  );
}

// ── Partes ──

function Partes({ partes }: { partes: ParteProcesso[] }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.36, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-partes"
      className="cartao p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="titulo-partes" className="font-display text-sm font-semibold text-ink">
          Partes
        </h2>
        <span className="rotulo">
          {partes.length} {partes.length === 1 ? 'parte' : 'partes'}
        </span>
      </div>

      {partes.length === 0 ? (
        <Vazio
          Icone={Users}
          titulo="Nenhuma parte vinculada"
          descricao="Este processo existe na carteira, mas nenhuma pessoa foi associada a ele na importação."
        />
      ) : (
        <ul className="mt-5 space-y-4">
          {partes.map((parte, i) => (
            <CartaoParte key={parte.pessoa.id} parte={parte} indice={i} />
          ))}
        </ul>
      )}
    </motion.section>
  );
}

function CartaoParte({ parte, indice }: { parte: ParteProcesso; indice: number }) {
  const { pessoa } = parte;
  /* `statusEnriquecimento` ausente = resposta do CLIENTE, não status desconhecido.
     Ele recebe o contato; a maquinaria que o obteve não é assunto dele — nem o
     selo de status, nem o texto de ausência, que fala de fila e de provedor.
     `STATUS[undefined]` devolvia `undefined` e o `.cor` abaixo derrubava a
     página inteira: era este o TypeError. */
  const st = pessoa.statusEnriquecimento ? STATUS[pessoa.statusEnriquecimento] : null;
  /* Maiúscula porque entra como componente no JSX. Sem status (cliente), um
     ícone neutro: a ausência de contato é um fato, não um diagnóstico. */
  const IconeSemContato = st?.Icone ?? Phone;
  const temContato =
    pessoa.telefones.length > 0 || pessoa.emails.length > 0 || pessoa.enderecos.length > 0;

  return (
    <motion.li
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: Math.min(indice, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
      className="rounded-[14px] border border-linha bg-superficie p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-[15px] font-medium text-ink">{pessoa.nome}</p>
          <p className="num mt-1 text-[12px] text-muted">{cpfFormatado(pessoa.cpf)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {pessoa.obito && (
            <span className="rounded-full border border-erro/25 bg-erro/10 px-2.5 py-1 text-[11px] font-medium text-erro">
              Óbito
            </span>
          )}
          <span className="rounded-full border border-linha bg-superficie-2 px-2.5 py-1 text-[11px] font-medium text-ink-2">
            {PAPEL[parte.papel]}
          </span>
          {/* Só quando há status. Para o cliente o campo não vem, e o selo é
              vocabulário do enriquecimento — não é para ele existir. */}
          {st && (
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
                st.cor,
              )}
            >
              <st.Icone aria-hidden className="h-3 w-3" />
              {st.rotulo}
            </span>
          )}
        </div>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Campo rotulo="Valor da parte" mono>
          {brl(parte.valorIndividual)}
        </Campo>
        <Campo rotulo="Nascimento" mono>
          {dataCurta(pessoa.dataNascimento)}
        </Campo>
      </dl>

      {temContato ? (
        <div className="mt-4 space-y-3 border-t border-linha pt-4">
          {pessoa.telefones.length > 0 && (
            <div className="flex items-start gap-2.5">
              <Phone aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-marca-ciano" />
              <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
                {pessoa.telefones.map((t) => (
                  <li key={`${t.ddd ?? ''}${t.numero}`} className="num flex items-center gap-1.5 text-[13px] text-ink-2">
                    {telefone(t)}
                    {t.whatsapp && (
                      <MessageCircle aria-label="tem WhatsApp" className="h-3 w-3 text-ok" />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pessoa.emails.length > 0 && (
            <div className="flex items-start gap-2.5">
              <Mail aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-marca-ciano" />
              <ul className="min-w-0 space-y-1.5">
                {pessoa.emails.map((e) => (
                  <li key={e.endereco} className="break-all text-[13px] text-ink-2">
                    {e.endereco}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pessoa.enderecos.length > 0 && (
            <div className="flex items-start gap-2.5">
              <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-marca-ciano" />
              <ul className="min-w-0 space-y-1.5">
                {pessoa.enderecos.map((e, i) => (
                  <li key={i} className="text-[13px] text-ink-2">
                    {endereco(e)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pessoa.ultimaSincronizacao && (
            <p className="num text-[11px] text-muted">
              Contato sincronizado em {dataHora(pessoa.ultimaSincronizacao)}
            </p>
          )}
        </div>
      ) : (
        /* Uma moldura vazia faria parecer defeito da tela; o texto diz o que
           aconteceu e aponta onde isso muda.

           Este ramo já foi a regra — 3.839 das 3.974 pessoas PENDENTE. Depois da
           carga do TRF1 e do enriquecimento em massa a base tem zero pendentes,
           então hoje ele é exceção: quase sempre cai em SEM_DADOS.

           Sem `st` é o CLIENTE. Para ele existe só o fato "não há contato" — a
           fila, o provedor e o próprio verbo "enriquecer" não aparecem. */
        <div className="mt-4 flex items-start gap-2.5 border-t border-linha pt-4">
          <IconeSemContato aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
          <p className="text-[12px] leading-relaxed text-muted">
            {!st && 'Não há telefone, e-mail ou endereço cadastrados para esta parte.'}
            {pessoa.statusEnriquecimento === 'PENDENTE' && (
              <>
                Sem telefone, e-mail ou endereço: esta pessoa ainda não passou pelo enriquecimento.{' '}
                <Link href="/fila" className="text-marca-ciano transition-colors hover:underline">
                  Ver a fila
                </Link>
                .
              </>
            )}
            {pessoa.statusEnriquecimento === 'SEM_DADOS' &&
              'O provedor respondeu que não tem contato para este CPF. Não é falha da consulta.'}
            {pessoa.statusEnriquecimento === 'ERRO' &&
              'A última sincronização falhou. Vale reprocessar pela fila.'}
            {pessoa.statusEnriquecimento === 'SINCRONIZADO' &&
              'Sincronizada, mas sem nenhum contato ativo no momento.'}
          </p>
        </div>
      )}

      {parte.observacoes && (
        <p className="mt-4 border-t border-linha pt-4 text-[12px] leading-relaxed text-ink-2">
          {parte.observacoes}
        </p>
      )}
    </motion.li>
  );
}

// ── Linha do tempo ──

function LinhaDoTempo({
  eventos,
  total,
  truncada,
  atualizadoEm,
}: {
  eventos: EventoProcesso[];
  total: number;
  truncada: boolean;
  atualizadoEm: string;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.44, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-timeline"
      className="cartao p-6"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="titulo-timeline" className="font-display text-sm font-semibold text-ink">
          Linha do tempo
        </h2>
        <span className="rotulo num">{total}</span>
      </div>

      {eventos.length === 0 ? (
        <Vazio
          Icone={CalendarClock}
          titulo="Sem histórico"
          descricao="Nenhum evento foi registrado para este processo."
        />
      ) : (
        <ol className="mt-5 space-y-1">
          {eventos.map((e, i) => (
            <ItemDaTimeline key={e.id} evento={e} indice={i} ultimo={i === eventos.length - 1} />
          ))}
        </ol>
      )}

      {truncada && (
        <p className="mt-4 border-t border-linha pt-4 text-[11px] text-muted" role="status">
          Mostrando os {eventos.length} eventos mais recentes de {total}.
        </p>
      )}

      <p className="num mt-4 border-t border-linha pt-4 text-[11px] text-muted">
        Processo atualizado em {dataHora(atualizadoEm)}
      </p>
    </motion.section>
  );
}

function ItemDaTimeline({
  evento,
  indice,
  ultimo,
}: {
  evento: EventoProcesso;
  indice: number;
  ultimo: boolean;
}) {
  const meta = EVENTO[evento.tipo] ?? EVENTO.OBSERVACAO;
  /* Ausentes na resposta do CLIENTE, e não vazios: a projeção remonta o evento
     com id/tipo/descricao/criadoEm só. Sem este `??`, `camposAlterados.length`
     lançava TypeError — e como todo processo tem ao menos o evento IMPORTADO,
     era em toda abertura de processo, para todo cliente.

     O de/para some junto, o que é o comportamento certo: para o cliente a
     timeline conta O QUE aconteceu, não a auditoria interna da mudança. */
  const campos = evento.camposAlterados ?? [];
  const detalhe = evento.detalhe ?? {};

  return (
    <motion.li
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.45, delay: Math.min(indice, 10) * 0.04, ease: [0.16, 1, 0.3, 1] }}
      className="relative flex gap-3.5 pb-5"
    >
      {/* Fio vertical ligando os marcos; o último não puxa linha para o vazio. */}
      {!ultimo && <span aria-hidden className="absolute left-[13px] top-8 h-[calc(100%-1.5rem)] w-px bg-linha" />}

      <span
        className={cn(
          'relative z-10 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border',
          meta.cor,
        )}
      >
        <meta.Icone aria-hidden className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-ink-2">{evento.descricao}</p>
        <p className="num mt-1 text-[11px] text-muted">
          <span className="sr-only">{meta.rotulo} em </span>
          {dataHora(evento.criadoEm)}
        </p>

        {campos.length > 0 && (
          <ul className="mt-2.5 space-y-1.5">
            {campos.map((campo) => {
              const par = detalhe[campo];
              const nome = ROTULO_CAMPO[campo] ?? campo;

              /* Campo presente em `camposAlterados` e ausente de `detalhe` é o
                 caso sigiloso: o motor de diff registra QUE mudou e nunca
                 QUANTO. Dizer isso na tela é melhor que omitir a linha — o
                 operador vê que houve correção e entende por que não há de/para,
                 em vez de achar que a timeline perdeu a informação. */
              if (!par) {
                return (
                  <li
                    key={campo}
                    className="flex items-start gap-2 rounded-[10px] border border-linha bg-superficie px-2.5 py-1.5 text-[11px] text-muted"
                  >
                    <Lock aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>
                      <span className="text-ink-2">{nome}</span> corrigido — o valor não é registrado
                      no histórico
                    </span>
                  </li>
                );
              }

              return (
                <li
                  key={campo}
                  className="rounded-[10px] border border-linha bg-superficie px-2.5 py-1.5 text-[11px]"
                >
                  <span className="text-ink-2">{nome}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5 text-muted">
                    <span className="line-through">{ladoDoDiff(campo, par.de)}</span>
                    <span aria-hidden>→</span>
                    <span className="sr-only">passou para</span>
                    <span className="text-marca-ciano">{ladoDoDiff(campo, par.para)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {evento.importacaoId && (
          <Link
            href="/importacao"
            className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-marca-ciano"
          >
            <Building2 aria-hidden className="h-3 w-3" />
            Veio de uma importação
          </Link>
        )}
      </div>
    </motion.li>
  );
}
