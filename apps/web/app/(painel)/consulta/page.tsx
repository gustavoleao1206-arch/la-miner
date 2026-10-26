'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Inbox,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RotateCw,
  Search,
  SearchX,
  ShieldCheck,
  X,
  XCircle,
} from 'lucide-react';
import { api, type Pagina, type PessoaLista } from '@/lib/api';
import { brl, cpfFormatado, cn } from '@/lib/utils';
import { useLote, useUfsDoLote } from '@/lib/lote';
import { Contador, Esqueleto, useAnimavel } from '@/components/metricas';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';
import { SeloFase, ValorIndicativo } from '@/components/fase-processo';

/* A lista de UFs saiu daqui: era um "Nordeste" fixo que nem batia com a
   jurisdição do TRF5 (incluía BA e PI, que são do TRF1). Agora vem do
   catálogo, com as do tribunal em foco primeiro. Ver `useUfsDoLote`. */

const POR_PAGINA = 20;

/**
 * Os quatro estados de enriquecimento, cada um com identidade própria.
 *
 * "Sem dados" e "Erro" pareciam quase iguais quando só mudava a cor do texto:
 * o operador precisa distinguir "o provedor respondeu que não conhece este CPF"
 * de "a consulta falhou e vale tentar de novo". Ícone + cor + rótulo, os três.
 */
/** Ícone decorativo: além da classe, precisa aceitar o aria-hidden que sempre o acompanha. */
/* Lucide aceita Booleanish em aria-hidden; restringir a boolean rejeita os ícones.
   Mesma convenção de components/metricas.tsx. */
type IconeDecorativo = React.ComponentType<{ className?: string }>;

const STATUS: Record<
  PessoaLista['statusEnriquecimento'],
  { rotulo: string; cor: string; Icone: IconeDecorativo }
> = {
  SINCRONIZADO: {
    rotulo: 'Enriquecido',
    cor: 'border-ok/25 bg-ok/10 text-ok',
    Icone: CheckCircle2,
  },
  PENDENTE: {
    rotulo: 'Pendente',
    cor: 'border-linha bg-superficie text-muted',
    Icone: Clock,
  },
  SEM_DADOS: {
    rotulo: 'Sem dados',
    cor: 'border-alerta/25 bg-alerta/10 text-alerta',
    Icone: AlertTriangle,
  },
  ERRO: {
    rotulo: 'Erro',
    cor: 'border-erro/25 bg-erro/10 text-erro',
    Icone: XCircle,
  },
};

/**
 * O invólucro existe por causa do `useSearchParams` no miolo: o Next exige
 * Suspense em volta de quem lê a URL de forma REATIVA. Aqui a reatividade é
 * necessária — o buscador do topo navega para `/consulta?q=...` e, se a página
 * já estiver aberta, só a mudança do parâmetro avisa que há um termo novo.
 * (No login e na confirmação a leitura é única e o `window.location` basta;
 * este é o caso diferente, e o porquê fica registrado.)
 */
export default function ConsultaPage() {
  return (
    <Suspense fallback={null}>
      <Consulta />
    </Suspense>
  );
}

function Consulta() {
  const [termo, setTermo] = useState('');
  const [uf, setUf] = useState('');
  const [pagina, setPagina] = useState(1);
  const [resultado, setResultado] = useState<Estado<Pagina<PessoaLista>>>(CARREGANDO);
  /* `carregando` vive à parte do Estado de propósito: ao paginar, a lista
     anterior continua na tela enquanto a próxima chega. Trocar o Estado para
     CARREGANDO apagaria os resultados e faria a página piscar esqueleto a cada
     clique em "Próxima". */
  const [carregando, setCarregando] = useState(true);
  /* Filtros REALMENTE aplicados na última busca — não os que estão digitados.
     O vazio precisa citar o que foi buscado; se citasse o campo, diria
     "nada encontrado para X" enquanto a lista na tela é o resultado de Y. */
  const [aplicado, setAplicado] = useState({ termo: '', uf: '' });

  const animar = useAnimavel();
  const ufs = useUfsDoLote();
  /* A busca é escopada pelo lote em foco, igual ao dashboard: sem isto o
     operador trocaria de tribunal na lateral e a consulta seguiria mostrando
     gente do lote anterior. */
  const { query: queryLote } = useLote();

  const buscar = useCallback(
    async (p: number, t: string = termo, u: string = uf) => {
      const limpo = t.trim();
      setCarregando(true);
      try {
        const q = new URLSearchParams({ pagina: String(p), porPagina: String(POR_PAGINA) });
        if (limpo) q.set('termo', limpo);
        if (u) q.set('uf', u);
        const alvo = `/carteira/buscar?${q}${queryLote ? `&${queryLote}` : ''}`;
        setResultado({ st: 'ok', dados: await api<Pagina<PessoaLista>>(alvo) });
        setAplicado({ termo: limpo, uf: u });
      } catch (e) {
        setResultado({ st: 'erro', msg: (e as Error).message });
      } finally {
        setCarregando(false);
      }
    },
    [termo, uf, queryLote],
  );

  /**
   * ── O DEFEITO QUE DEIXAVA A BUSCA MORTA (21/08/2026) ──
   *
   * O buscador global do cabeçalho sempre navegou para `/consulta?q=...`, e
   * esta página NUNCA leu o `q`: quem buscava pelo topo caía aqui e via a
   * lista inteira, sem filtro e sem erro. Este efeito consome o parâmetro —
   * aplica o termo, dispara a busca e LIMPA a URL via router (replace), para
   * que uma troca de UF depois não ressuscite um termo já abandonado.
   */
  const router = useRouter();
  const q = useSearchParams().get('q') ?? '';
  useEffect(() => {
    if (!q) return;
    setTermo(q);
    setPagina(1);
    void buscar(1, q);
    router.replace('/consulta', { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    /* Com `q` ainda na URL, a primeira busca é do efeito acima — disparar as
       duas criaria uma corrida em que a resposta SEM filtro pode chegar por
       último e vencer a filtrada. */
    if (new URLSearchParams(window.location.search).get('q')) return;
    void buscar(1);
    setPagina(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uf, queryLote]);

  function irPara(p: number) {
    setPagina(p);
    /* Pagina pelo filtro APLICADO, não pelo texto vivo do input. Sem isto,
       quem digita algo sem submeter e clica em "Próxima" envia um termo que
       nunca foi buscado — e recebe "nada corresponde" para um termo que tem
       resultados, porque a página 4 do termo novo não existe. */
    void buscar(p, aplicado.termo, aplicado.uf);
  }

  /* Passam '' explicitamente: setTermo só vale no próximo render, e `buscar`
     leria o termo antigo do closure — a lista voltaria filtrada. Quando a UF
     muda, quem refaz a busca é o efeito de [uf], já com o closure novo. */
  function limparTermo() {
    setTermo('');
    setPagina(1);
    void buscar(1, '');
  }

  function limparFiltros() {
    setTermo('');
    setPagina(1);
    if (uf) setUf('');
    else void buscar(1, '');
  }

  const temFiltro = Boolean(aplicado.termo || aplicado.uf);

  return (
    <div className="relative min-h-screen">
      {/* Aurora ambiente — mesmo mundo visual do dashboard e do login */}
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
        {/* ── Cabeçalho ── */}
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-7"
        >
          <p className="rotulo">Carteira</p>
          <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            Consulta
          </h1>
        </motion.header>

        {/* ── Busca (herói) ── */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="cartao p-6"
        >
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              /* `buscar(1)` lê o campo VIVO. Antes era `irPara(1)`, que pagina
                 pelo filtro JÁ APLICADO — e como o aplicado nasce vazio, o
                 Enter buscava lista inteira: digitar um CPF não filtrava NADA.
                 `irPara` continua certo para os botões de paginação, que é a
                 única coisa para a qual ele existe. */
              setPagina(1);
              void buscar(1);
            }}
            className="flex flex-col gap-4 lg:flex-row lg:items-end"
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="termo" className="rotulo mb-2.5 block">
                {/* "processo", como a lista de resultados logo abaixo, que já
                    deixou de chamar tudo de precatório. O campo tinha ficado
                    para trás na mesma tela. */}
                CPF, nome ou número do processo
              </label>
              <div className="group relative">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-2 transition-colors group-focus-within:text-marca-ciano"
                />
                <input
                  id="termo"
                  value={termo}
                  onChange={(e) => setTermo(e.target.value)}
                  placeholder="Ex.: 529.982.247-25 · FULANA DE TAL · 9900001-48.2025…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-[56px] w-full rounded-[14px] border border-white/[0.08] bg-white/[0.03] pl-12 pr-11 text-[15px] text-ink outline-none transition-all placeholder:text-muted-2 hover:border-white/[0.14] focus:border-marca-ciano/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
                />
                {termo && (
                  <button
                    type="button"
                    onClick={limparTermo}
                    aria-label="Limpar termo de busca"
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-2 transition-colors hover:text-ink-2"
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {/* flex-wrap por causa do piso de 320px: com a página em p-6 e o
                cartão em p-6, sobram 224px de conteúdo — select e botão lado a
                lado estouravam e empurravam a rolagem horizontal para a página. */}
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="uf" className="rotulo mb-2.5 block">
                  UF
                </label>
                <select
                  id="uf"
                  value={uf}
                  onChange={(e) => setUf(e.target.value)}
                  className="h-[56px] w-[6.5rem] rounded-[14px] border border-white/[0.08] bg-white/[0.03] px-3 text-sm text-ink outline-none transition-all hover:border-white/[0.14] focus:border-marca-ciano/50 focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
                >
                  {['', ...ufs].map((u) => (
                    <option key={u} value={u} className="bg-bg-2 text-ink">
                      {u || 'Todas'}
                    </option>
                  ))}
                </select>
              </div>

              <motion.button
                type="submit"
                disabled={carregando}
                whileHover={{ scale: 1.015 }}
                whileTap={{ scale: 0.985 }}
                className={cn(
                  'flex h-[56px] min-w-[8.5rem] flex-1 items-center justify-center gap-2.5 rounded-[14px] bg-marca px-7',
                  'font-display text-[15px] font-semibold text-[#05070f]',
                  'transition-shadow duration-300 hover:shadow-brilho-ciano',
                  'disabled:cursor-not-allowed disabled:opacity-45 lg:flex-none',
                )}
              >
                {carregando ? (
                  <Loader2 aria-hidden className="h-[18px] w-[18px] animate-spin" />
                ) : (
                  <Search aria-hidden className="h-[18px] w-[18px]" />
                )}
                Buscar
              </motion.button>
            </div>
          </form>

          <p className="mt-4 flex items-start gap-2 border-t border-linha pt-4 text-[11px] leading-relaxed text-muted-2">
            <ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
            <span>
              Busca somente no banco interno. Cada consulta é registrada para auditoria.
            </span>
          </p>
        </motion.section>

        {/* ── Resultados ── */}
        <div className="mt-6">
          {resultado.st === 'erro' && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className="cartao border-erro/25 p-6"
              role="alert"
            >
              <BlocoErro msg={`Não foi possível consultar a carteira: ${resultado.msg}`} />
              <button
                type="button"
                onClick={() => void buscar(pagina)}
                disabled={carregando}
                className="mt-4 flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie disabled:opacity-45"
              >
                <RotateCw aria-hidden className={cn('h-3.5 w-3.5', carregando && 'animate-spin')} />
                Tentar novamente
              </button>
            </motion.div>
          )}

          {resultado.st === 'carregando' && (
            <div className="space-y-3" aria-busy="true">
              {Array.from({ length: 4 }).map((_, i) => (
                <Esqueleto key={i} className="h-[132px] rounded" />
              ))}
            </div>
          )}

          {resultado.st === 'ok' && resultado.dados.itens.length === 0 && (
            <div className="cartao">
              {temFiltro ? (
                /* Buscou e não achou — o filtro é a causa, então a saída é mexer nele. */
                <Vazio
                  Icone={SearchX}
                  titulo="Nenhum requerente encontrado"
                  descricao={
                    aplicado.termo
                      ? `Nada corresponde a “${aplicado.termo}”${aplicado.uf ? ` em ${aplicado.uf}` : ''}. Revise a grafia ou amplie o filtro de UF.`
                      : `Nenhum requerente com endereço em ${aplicado.uf}.`
                  }
                  acao={
                    <button
                      type="button"
                      onClick={limparFiltros}
                      className="flex h-9 items-center gap-2 rounded-[11px] border border-linha px-4 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
                    >
                      <X aria-hidden className="h-3.5 w-3.5" />
                      Limpar filtros
                    </button>
                  }
                />
              ) : (
                /* Sem filtro nenhum e ainda assim vazio: não é busca frustrada,
                   é carteira sem dados. Mandar "revise o termo" aqui seria mentira. */
                <Vazio
                  Icone={Inbox}
                  titulo="A carteira ainda está vazia"
                  descricao="Nenhum requerente foi importado até agora. Envie uma planilha em Importação para começar a consultar."
                />
              )}
            </div>
          )}

          {resultado.st === 'ok' && resultado.dados.itens.length > 0 && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.4 }}
                className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2"
                role="status"
              >
                {/* O visual conta de 0 até o total; o leitor de tela recebe só o
                    número final. Dentro de uma live region, um contador animado
                    seria anunciado a cada quadro — dezenas de falas por busca. */}
                <p className="text-sm text-muted">
                  <span aria-hidden>
                    {animar ? (
                      <Contador
                        valor={resultado.dados.total}
                        formatar={(n) => Math.round(n).toLocaleString('pt-BR')}
                        className="num text-ink"
                      />
                    ) : (
                      <span className="num text-ink">
                        {resultado.dados.total.toLocaleString('pt-BR')}
                      </span>
                    )}{' '}
                    {resultado.dados.total === 1 ? 'resultado' : 'resultados'}
                    {resultado.dados.totalPaginas > 1 && (
                      <span className="num">
                        {' '}
                        · página {resultado.dados.pagina} de {resultado.dados.totalPaginas}
                      </span>
                    )}
                  </span>
                  <span className="sr-only">
                    {resultado.dados.total.toLocaleString('pt-BR')}{' '}
                    {resultado.dados.total === 1 ? 'resultado' : 'resultados'}
                    {resultado.dados.totalPaginas > 1 &&
                      `, página ${resultado.dados.pagina} de ${resultado.dados.totalPaginas}`}
                  </span>
                </p>
                {carregando && (
                  <span className="flex items-center gap-1.5 text-[11px] text-muted-2">
                    <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
                    atualizando…
                  </span>
                )}
              </motion.div>

              <div className={cn('space-y-3 transition-opacity', carregando && 'opacity-60')}>
                {resultado.dados.itens.map((p, i) => (
                  <CartaoPessoa key={p.id} p={p} indice={i} animar={animar} />
                ))}
              </div>

              {resultado.dados.totalPaginas > 1 && (
                <nav
                  aria-label="Paginação dos resultados"
                  className="mt-7 flex items-center justify-center gap-2"
                >
                  <button
                    onClick={() => irPara(resultado.dados.pagina - 1)}
                    disabled={resultado.dados.pagina <= 1 || carregando}
                    className="flex h-10 items-center gap-1.5 rounded-[12px] border border-linha px-4 text-sm text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <ChevronLeft aria-hidden className="h-4 w-4" />
                    Anterior
                  </button>
                  <span className="num px-3 text-sm text-muted">
                    {resultado.dados.pagina} / {resultado.dados.totalPaginas}
                  </span>
                  <button
                    onClick={() => irPara(resultado.dados.pagina + 1)}
                    disabled={resultado.dados.pagina >= resultado.dados.totalPaginas || carregando}
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
      </div>
    </div>
  );
}

function CartaoPessoa({
  p,
  indice,
  animar,
}: {
  p: PessoaLista;
  indice: number;
  animar: boolean;
}) {
  const st = STATUS[p.statusEnriquecimento] ?? STATUS.PENDENTE;
  const tel = p.telefones[0];
  const email = p.emails[0];
  const end = p.enderecos[0];
  const total = p.processos.reduce((s, v) => s + Number(v.valorIndividual ?? 0), 0);

  return (
    <motion.article
      /* Cascata com teto: são 20 cartões por página e 0,08s cada empurraria o
         último para 1,5s de espera. O escalonamento existe para dar ritmo, não
         para atrasar a leitura — a partir do 8º todos entram juntos. */
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: Math.min(indice, 8) * 0.04,
        duration: 0.55,
        ease: [0.16, 1, 0.3, 1],
      }}
      className="cartao p-5 transition-colors hover:border-linha-2 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-base font-semibold text-ink" title={p.nome}>
            {p.nome}
          </h3>
          {/* Dado pessoal: mesma exposição da versão anterior — CPF completo. */}
          <p className="num mt-1 text-sm text-muted">{cpfFormatado(p.cpf)}</p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2.5">
          <span
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              st.cor,
            )}
          >
            <st.Icone aria-hidden className="h-3 w-3" />
            {st.rotulo}
          </span>
          {total > 0 && (
            <span className="num texto-marca font-display text-base font-semibold">
              {brl(total)}
            </span>
          )}
        </div>
      </div>

      {/* Contato — exibição completa conforme política definida */}
      <div className="mt-4 flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-6">
        <Dado Icone={Phone} valor={tel ? `(${tel.ddd ?? '--'}) ${tel.numero}` : null} />
        <Dado Icone={Mail} valor={email?.endereco ?? null} />
        <Dado Icone={MapPin} valor={end ? [end.cidade, end.uf].filter(Boolean).join(' / ') : null} />
      </div>

      {p.processos.length > 0 && (
        <div className="mt-5 border-t border-linha pt-4">
          {/* "processo", e não "precatório": desde que os pré-precatórios entraram
              na mesma lista, chamar o conjunto de precatórios afirma exigibilidade
              que parte dele não tem. O estágio de cada um vai no selo da linha. */}
          <p className="rotulo mb-2.5">
            {p.processos.length === 1 ? '1 processo' : `${p.processos.length} processos`}
          </p>
          <ul className="space-y-0.5">
            {/* Cada precatório abre a página do processo no CRM. A linha
                inteira é o alvo do clique, não só o número: numa lista densa,
                um alvo de 12px de altura é difícil de acertar e o resto da
                linha parece clicável mas não é. */}
            {p.processos.map((v) => (
              <li key={v.processo.id}>
                <Link
                  href={`/processo/${v.processo.id}`}
                  className="group grid grid-cols-1 gap-x-4 rounded-[10px] px-2.5 py-2 transition-colors hover:bg-superficie-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto_auto] sm:items-baseline"
                >
                  <span
                    className="num truncate text-[12px] text-ink-2 transition-colors group-hover:text-marca-ciano"
                    title={v.processo.numeroPrecatorio}
                  >
                    {v.processo.numeroPrecatorio}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="truncate text-[12px] text-muted"
                      title={v.processo.entidadeDevedora ?? undefined}
                    >
                      {v.processo.entidadeDevedora ?? '—'}
                    </span>
                    <SeloFase fase={v.processo.fase} />
                  </span>
                  {/* Um pré-precatório não tem valor individual apurado. Imprimir
                      `brl(0)` aqui dizia ao advogado que o crédito vale zero —
                      pior que não dizer nada. Quando só existe o número extraído
                      do texto, quem aparece é o valor indicativo, com o til e a
                      palavra "estimado" que a fonte exige. */}
                  <span className="num text-[12px] text-ink sm:text-right">
                    {v.valorIndividual !== null ? (
                      brl(Number(v.valorIndividual))
                    ) : (
                      <ValorIndicativo valor={v.processo.valorIndicativo} />
                    )}
                  </span>
                  <ChevronRight
                    aria-hidden
                    className="hidden h-3.5 w-3.5 self-center text-muted transition-colors group-hover:text-marca-ciano sm:block"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </motion.article>
  );
}

function Dado({
  Icone,
  valor,
}: {
  Icone: IconeDecorativo;
  valor: string | null;
}) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-2',
        valor ? 'text-ink-2' : 'text-muted-2',
      )}
    >
      <Icone aria-hidden className="h-3.5 w-3.5 shrink-0" />
      {/* break-words e não truncate: um e-mail longo cortado no meio deixa de
          servir para copiar, e é justamente para copiar que ele está aqui. */}
      <span className="min-w-0 break-words">{valor ?? '—'}</span>
    </span>
  );
}
