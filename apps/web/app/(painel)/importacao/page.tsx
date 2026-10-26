'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileSpreadsheet,
  FileText,
  Landmark,
  ListChecks,
  Loader2,
  Upload,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import {
  ErroApi,
  api,
  enviarPlanilha,
  estadoImportacao,
  perfisDeImportacao,
  type DestinoImportacao,
  type EstadoImportacao,
  type Importacao,
  type LinhaErro,
  type PerfilDeImportacao,
  type SimulacaoImportacao,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLote } from '@/lib/lote';
import { CartaoKpi, Contador, Esqueleto, useAnimavel } from '@/components/metricas';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';

/**
 * Extensões aceitas pelo backend.
 *
 * `.xls` (Excel 97-2003) SAIU: só o SheetJS lia aquele formato binário, e ele
 * carregava vulnerabilidade alta sem correção publicada. Tirá-lo daqui evita o
 * pior caminho — o seletor de arquivos deixar escolher algo que a API vai
 * recusar depois do upload inteiro subir.
 */
const FORMATOS = ['.csv', '.xlsx'];

const STATUS: Record<string, { rotulo: string; classe: string }> = {
  RECEBIDA: { rotulo: 'Recebida', classe: 'border-linha-2 bg-superficie text-muted' },
  PROCESSANDO: { rotulo: 'Processando', classe: 'border-marca-ciano/30 bg-marca-ciano/10 text-marca-ciano' },
  CONCLUIDA: { rotulo: 'Concluída', classe: 'border-ok/30 bg-ok/10 text-ok' },
  CONCLUIDA_COM_ERROS: { rotulo: 'Concluída com erros', classe: 'border-alerta/30 bg-alerta/10 text-alerta' },
  FALHOU: { rotulo: 'Falhou', classe: 'border-erro/30 bg-erro/10 text-erro' },
};

function inteiro(n: number) {
  return n.toLocaleString('pt-BR');
}

function dataHora(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function tamanho(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Traduz o resultado do upsert com diff em uma frase.
 *
 * A importação deixou de sobrescrever tudo: agora ela compara campo a campo e
 * só grava o que mudou. Isso torna o reenvio da mesma planilha inofensivo — mas
 * a garantia só vale se o operador CONSEGUIR VER que nada foi tocado. Sem estes
 * números ele teria de abrir processo a processo para ter certeza, que é
 * exatamente o trabalho que o diff existe para poupar.
 *
 * Por isso a frase inteira muda quando criados e atualizados são zero: "não
 * mexeu em nada" é o caso que ele mais precisa reconhecer de relance, e uma
 * lista de zeros não comunica isso — obriga a lê-la e interpretá-la.
 *
 * Os números vêm do BANCO agora (B5): a resposta do envio virou um recibo, e o
 * resultado chega minutos depois pela rota de acompanhamento. É por isso que
 * eles passaram a ser colunas de `Importacao` em vez de campos de uma resposta.
 */
function resumoImportacao(r: EstadoImportacao) {
  const criados = r.processosCriados;
  const atualizados = r.processosAtualizados;
  const inalterados = r.processosInalterados;

  const ignoradas = r.ignoradas > 0 ? ` ${inteiro(r.ignoradas)} ignorada(s).` : '';
  const linhas =
    `${inteiro(r.totalLinhas)} linha(s): ${inteiro(r.sucesso)} sem erro, ` +
    `${inteiro(r.falhas)} com erro.${ignoradas}`;
  /* Só citar a fila quando houve fila. Um "0 enfileirado" no fim de toda
     mensagem vira ruído que o olho aprende a pular — junto com o resto dela. */
  const fila = r.enfileirados > 0 ? ` ${inteiro(r.enfileirados)} enfileirado(s) para enriquecimento.` : '';

  if (criados === 0 && atualizados === 0) {
    return `${linhas} Nenhum processo mudou — os ${inteiro(inalterados)} já estavam iguais na carteira.${fila}`;
  }

  return (
    `${linhas} ${inteiro(criados)} processo(s) novo(s), ${inteiro(atualizados)} atualizado(s) e ` +
    `${inteiro(inalterados)} sem mudança — cada alteração ficou registrada na linha do tempo.${fila}`
  );
}

type Aviso = { tom: 'ok' | 'alerta' | 'erro'; texto: string };

export default function ImportacaoPage() {
  const [historico, setHistorico] = useState<Estado<Importacao[]>>(CARREGANDO);
  const [enviando, setEnviando] = useState(false);
  const [emVoo, setEmVoo] = useState<{ nome: string; bytes: number } | null>(null);
  /* Guarda o File junto: a confirmação reenvia o MESMO arquivo, sem depender do
     input, que é limpo após a simulação. */
  const [simulacao, setSimulacao] = useState<{ dados: SimulacaoImportacao; arquivo: File } | null>(null);
  const [segundos, setSegundos] = useState(0);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [erros, setErros] = useState<{ id: string; nome: string; estado: Estado<LinhaErro[]> } | null>(null);
  const [arrastando, setArrastando] = useState(false);
  /* A carga que está na fila agora. `acompanhando` é o id que dispara o ciclo
     de consulta; `andamento` é o último estado lido. */
  const [acompanhando, setAcompanhando] = useState<string | null>(null);
  const [andamento, setAndamento] = useState<EstadoImportacao | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const painelErros = useRef<HTMLElement>(null);
  /* dragenter/dragleave também disparam ao cruzar os filhos da zona. Contando as
     entradas e saídas, o realce só some quando o ponteiro deixa a zona inteira —
     sem isso a borda pisca a cada ícone ou parágrafo sobrevoado. */
  const profundidadeArrasto = useRef(0);

  const animar = useAnimavel();

  /* Destino da carga: para onde as linhas vão. Começa no lote em foco, mas é
     editável aqui — o seletor da lateral só lista lotes que JÁ existem, e a
     primeira importação de um tribunal novo, por definição, não está lá. */
  const { lote, catalogo } = useLote();
  const [destino, setDestino] = useState<{ tribunal: string; exercicio: number } | null>(null);
  useEffect(() => {
    if (lote && !destino) setDestino(lote);
  }, [lote, destino]);

  /**
   * O MODO MULTI-TRIBUNAL, que até 06/09/2026 não tinha por onde ser pedido.
   *
   * `perfilId` nulo é o caminho de sempre — o tribunal escolhido aqui. Não nulo
   * significa "o tribunal vem de uma coluna da planilha", e aí os seletores de
   * tribunal e exercício deixam de fazer sentido e saem de cena.
   *
   * Um estado só decide o modo. Com dois (um booleano e um id), eles divergem na
   * primeira mudança e a tela mostra um e manda outro.
   */
  const [perfilId, setPerfilId] = useState<string | null>(null);
  const [perfisMulti, setPerfisMulti] = useState<PerfilDeImportacao[]>([]);
  useEffect(() => {
    /* Falha em silêncio de propósito: sem a lista, a tela continua servindo o
       modo de sempre. Um erro vermelho aqui assustaria quem só quer importar
       dívida consolidada, que é a rotina. */
    perfisDeImportacao()
      .then((ps) => setPerfisMulti(ps.filter((p) => p.multiTribunal)))
      .catch(() => setPerfisMulti([]));
  }, []);

  /* O `!` nas chamadas seria mentira: se o catálogo falhar, `destino` fica nulo
     e a planilha subiria sem destino. A guarda transforma isso numa recusa
     explicável em vez de um envio para o tribunal padrão.

     Agora ela produz o ALVO já na forma que a API fala, em vez de um booleano
     ao lado de um valor que ainda pode ser nulo: quem tem o booleano ainda
     precisa de um `!` na hora de enviar, e é ali que a mentira voltaria. */
  const alvo: DestinoImportacao | null =
    perfilId !== null
      ? { modo: 'PERFIL', perfilId }
      : destino !== null &&
          destino.tribunal !== '' &&
          Number.isInteger(destino.exercicio) &&
          destino.exercicio >= 1988 &&
          destino.exercicio <= 2100
        ? { modo: 'TRIBUNAL', tribunal: destino.tribunal, exercicio: destino.exercicio }
        : null;
  const destinoValido = alvo !== null;

  const carregar = useCallback(async () => {
    try {
      setHistorico({ st: 'ok', dados: await api<Importacao[]>('/importacao?limite=20') });
    } catch (e) {
      setHistorico({ st: 'erro', msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* O envio não tem progresso real (o backend responde só ao terminar), então o
     único número honesto que temos para mostrar é o tempo decorrido. */
  useEffect(() => {
    if (!enviando) return;
    setSegundos(0);
    const id = window.setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [enviando]);

  const erroId = erros?.id;
  useEffect(() => {
    if (erroId) painelErros.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [erroId]);

  /* Escolher o arquivo SIMULA; importar de verdade exige o relatório na tela.
     Antes, soltar o arquivo já gravava — e uma planilha com o cabeçalho errado
     só revelava o estrago depois, com a carteira suja e crédito de API gasto
     em pessoas que ficariam invisíveis nos agregados. */
  async function simular(arquivo: File) {
    if (alvo === null) {
      setAviso({
        tom: 'erro',
        texto: 'Escolha o destino da carga antes de enviar a planilha.',
      });
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setEnviando(true);
    setEmVoo({ nome: arquivo.name, bytes: arquivo.size });
    setAviso(null);
    setErros(null);
    setSimulacao(null);
    try {
      const s = await enviarPlanilha(arquivo, alvo, true);
      setSimulacao({ dados: s, arquivo });
    } catch (e) {
      setAviso({ tom: 'erro', texto: (e as Error).message });
    } finally {
      setEnviando(false);
      setEmVoo(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  /**
   * Acompanha a carga que está na fila.
   *
   * Desde o B5 o envio devolve um RECIBO: a planilha foi aceita e o trabalho
   * roda no worker, que a 9,7 ms por linha pode levar minutos. Sem este ciclo, a
   * tela diria "recebida" e nunca mais mudaria — e o operador não teria como
   * saber se a carga andou, travou ou terminou.
   *
   * Um segundo e meio entre consultas: a rota lê o resumo já gravado na própria
   * importação (não varre as linhas), e o intervalo é curto o bastante para a
   * barra parecer viva sem transformar uma carga de dez minutos em quatrocentas
   * requisições.
   */
  useEffect(() => {
    if (!acompanhando) return;
    let vivo = true;
    let timer = 0;

    const consultar = async () => {
      try {
        const e = await estadoImportacao(acompanhando);
        if (!vivo) return;

        if (!e.terminou) {
          setAndamento(e);
          timer = window.setTimeout(consultar, 1500);
          return;
        }

        setAcompanhando(null);
        setAndamento(null);
        setAviso(
          e.status === 'FALHOU'
            ? { tom: 'erro', texto: e.mensagemErro ?? 'A importação falhou.' }
            : { tom: e.falhas > 0 ? 'alerta' : 'ok', texto: resumoImportacao(e) },
        );
        await carregar();
      } catch (err) {
        if (!vivo) return;
        /* A consulta falhou, a CARGA não: ela continua no worker. Dizer isso é o
           que impede o operador de reenviar a planilha achando que se perdeu. */
        setAcompanhando(null);
        setAndamento(null);
        setAviso({
          tom: 'alerta',
          texto:
            `O acompanhamento parou (${(err as Error).message}), mas a importação continua ` +
            'rodando no servidor. Atualize o histórico em instantes para ver o resultado.',
        });
      }
    };

    void consultar();
    return () => {
      vivo = false;
      window.clearTimeout(timer);
    };
  }, [acompanhando, carregar]);

  async function confirmar() {
    if (!simulacao || alvo === null) return;
    const arquivo = simulacao.arquivo;
    setEnviando(true);
    setEmVoo({ nome: arquivo.name, bytes: arquivo.size });
    setAviso(null);
    setErros(null);
    try {
      const recibo = await enviarPlanilha(arquivo, alvo);
      setSimulacao(null);
      /* O envio acabou; o TRABALHO começou. O ciclo acima assume daqui. */
      setAcompanhando(recibo.importacaoId);
      await carregar();
    } catch (e) {
      const msg = (e as Error).message;
      /* A recusa de arquivo já importado é uma proteção funcionando, não uma
         falha: o backend a devolve como 400 com esta frase. Distinguir pelo
         texto é frágil, mas o pior caso é só o tom do aviso — a mensagem da
         API aparece igual em qualquer situação. */
      const duplicado = e instanceof ErroApi && /já foi importado/i.test(msg);
      setAviso({ tom: duplicado ? 'alerta' : 'erro', texto: msg });
    } finally {
      setEnviando(false);
      setEmVoo(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function verErros(imp: Importacao) {
    setErros({ id: imp.id, nome: imp.arquivoNome, estado: CARREGANDO });
    try {
      const linhas = await api<LinhaErro[]>(`/importacao/${imp.id}/erros?limite=100`);
      setErros({ id: imp.id, nome: imp.arquivoNome, estado: { st: 'ok', dados: linhas } });
    } catch (e) {
      setErros({ id: imp.id, nome: imp.arquivoNome, estado: { st: 'erro', msg: (e as Error).message } });
    }
  }

  const lista = historico.st === 'ok' ? historico.dados : [];
  const totalLinhas = lista.reduce((s, i) => s + i.totalLinhas, 0);
  const totalFalhas = lista.reduce((s, i) => s + i.falhas, 0);

  return (
    <div className="relative min-h-screen">
      {/* Aurora ambiente — mesma atmosfera do dashboard e do login */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
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
          className="mb-8"
        >
          <p className="rotulo">Entrada de dados</p>
          <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            Importação de planilhas
          </h1>
        </motion.header>

        {/* ── Destino da carga ──
            Fica ACIMA da zona de upload, e não ao lado: é a decisão que precede
            o arquivo. Enterrado num canto, o operador solta a planilha primeiro
            e só descobre o tribunal errado depois — quando já é uma simulação
            para reler em vez de um campo para conferir. */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.04, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          aria-labelledby="titulo-destino"
          className="cartao mb-5 flex flex-wrap items-end gap-x-6 gap-y-4 p-5"
        >
          <div className="min-w-0">
            <h2 id="titulo-destino" className="rotulo mb-2 flex items-center gap-1.5">
              <Landmark aria-hidden className="h-3 w-3" />
              Destino da carga
            </h2>
            <p className="text-[12px] text-muted">
              {perfilId === null
                ? 'Os processos entram sob este tribunal e exercício.'
                : 'O tribunal de cada processo vem de uma coluna da planilha.'}
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            {/* O MODO vem primeiro porque manda nos campos seguintes: escolhido
                um perfil multi-tribunal, tribunal e exercício deixam de existir.
                Saem da tela em vez de ficar desabilitado — campo cinza convida a
                tentar clicar e a perguntar por que não dá. */}
            {perfisMulti.length > 0 && (
              <div>
                <label htmlFor="destino-modo" className="rotulo mb-1.5 block">
                  Modo
                </label>
                <select
                  id="destino-modo"
                  value={perfilId ?? ''}
                  disabled={enviando}
                  onChange={(e) => setPerfilId(e.target.value === '' ? null : e.target.value)}
                  className="h-9 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:outline-none disabled:opacity-50"
                >
                  <option value="">Tribunal escolhido</option>
                  {perfisMulti.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {perfilId === null && (
            <>
            <div>
              <label htmlFor="destino-tribunal" className="rotulo mb-1.5 block">
                Tribunal
              </label>
              <select
                id="destino-tribunal"
                value={destino?.tribunal ?? ''}
                disabled={enviando || catalogo.length === 0}
                onChange={(e) =>
                  setDestino((d) => ({ tribunal: e.target.value, exercicio: d?.exercicio ?? new Date().getFullYear() }))
                }
                className="h-9 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:outline-none disabled:opacity-50"
              >
                {/* TODOS os tribunais, inclusive os sem carteira: é aqui que a
                    primeira importação de uma região nova acontece. */}
                {catalogo.map((t) => (
                  <option key={t.sigla} value={t.sigla} title={t.nome}>
                    {t.sigla}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="destino-exercicio" className="rotulo mb-1.5 block">
                Exercício
              </label>
              <input
                id="destino-exercicio"
                type="number"
                min={1988}
                max={2100}
                step={1}
                value={destino?.exercicio ?? ''}
                disabled={enviando}
                onChange={(e) =>
                  setDestino((d) => ({
                    tribunal: d?.tribunal ?? '',
                    exercicio: Number(e.target.value),
                  }))
                }
                className="num h-9 w-24 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:outline-none disabled:opacity-50"
              />
            </div>
            </>
            )}
          </div>

          {/* Ano é campo livre porque a carteira nova pode ser de qualquer
              exercício; a API recusa fora de 1988..2100. O aviso aqui evita que
              o operador só descubra o erro depois de subir 20 MB. */}
          {perfilId === null && destino && (destino.exercicio < 1988 || destino.exercicio > 2100) && (
            <BlocoErro msg="Informe um exercício entre 1988 e 2100." className="w-full" />
          )}
        </motion.section>

        {/* ── Herói: zona de upload + requisitos ── */}
        <div className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
          <motion.section
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="group relative"
            onDragEnter={(e) => {
              e.preventDefault();
              if (enviando) return;
              profundidadeArrasto.current += 1;
              setArrastando(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => {
              profundidadeArrasto.current = Math.max(0, profundidadeArrasto.current - 1);
              if (profundidadeArrasto.current === 0) setArrastando(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              profundidadeArrasto.current = 0;
              setArrastando(false);
              if (enviando) return;
              const f = e.dataTransfer.files?.[0];
              if (f) void simular(f);
            }}
          >
            {/* Halo em gradiente: acende no arrasto e, mais discreto, no hover.
                Fica num elemento próprio para a transição ser de opacidade
                (composição) e não de box-shadow, que repinta a cada quadro. */}
            <div
              aria-hidden
              className={cn(
                'pointer-events-none absolute -inset-1 rounded-[22px] blur-[14px] transition-opacity duration-300',
                arrastando ? 'opacity-70' : 'opacity-0 group-hover:opacity-30',
              )}
              style={{ background: 'linear-gradient(135deg,rgba(139,92,255,.55),rgba(38,213,238,.45))' }}
            />

            <input
              id="planilha"
              ref={inputRef}
              type="file"
              accept={FORMATOS.join(',')}
              /* NÃO usar `disabled` aqui: este é o único elemento focável da
                 zona (o "botão" é um <span>). Desabilitá-lo durante o envio faz
                 o navegador devolver o foco ao <body>, e quem navega por teclado
                 recomeça do topo do documento. A guarda vai no onChange, como o
                 onDrop já fazia. */
              /* sr-only em vez de hidden: o campo continua alcançável pelo
                 teclado, e o anel de foco aparece na zona via peer. */
              className="peer sr-only"
              onChange={(e) => {
                if (enviando) return;
                const f = e.target.files?.[0];
                if (f) void simular(f);
              }}
            />

            <label
              htmlFor="planilha"
              aria-busy={enviando}
              className={cn(
                'relative flex h-full min-h-[19rem] flex-col items-center justify-center rounded-[20px] border border-dashed p-8 text-center transition-colors duration-200',
                'bg-vidro shadow-cartao backdrop-blur-xl',
                'peer-focus-visible:ring-2 peer-focus-visible:ring-marca-ciano/70 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg',
                enviando
                  ? 'cursor-progress border-linha-2'
                  : arrastando
                    ? 'cursor-copy border-marca-ciano/70 bg-marca-ciano/[0.06]'
                    : 'cursor-pointer border-linha-2 hover:border-marca-azul/50',
              )}
            >
              {enviando ? (
                <>
                  <span className="flex h-14 w-14 items-center justify-center rounded-[17px] border border-marca-ciano/30 bg-marca-ciano/10">
                    <Loader2 aria-hidden className="h-6 w-6 animate-spin text-marca-ciano" />
                  </span>
                  {/* role="status" anuncia o início do envio a leitor de tela.
                      Fica só nesta frase, e não no contador de segundos ao lado:
                      envolver o contador faria a região ser reanunciada a cada
                      segundo, tornando a tela impossível de ouvir. */}
                  {/* "Conferindo", e não mais "processando": desde o B5 a
                      requisição só valida e enfileira. O processamento tem
                      painel próprio, com progresso de verdade. */}
                  <p role="status" className="mt-5 font-display text-base font-medium text-ink">
                    Enviando e conferindo
                  </p>
                  <p className="mt-1.5 max-w-sm truncate text-[13px] text-ink-2" title={emVoo?.nome}>
                    {emVoo?.nome}
                    {emVoo ? ` · ${tamanho(emVoo.bytes)}` : ''}
                  </p>

                  {/* Progresso indeterminado: o endpoint só responde ao final, e
                      uma barra percentual aqui seria inventada. */}
                  <div
                    role="progressbar"
                    aria-label="Enviando planilha — progresso indeterminado"
                    className="mt-5 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-superficie-2"
                  >
                    {animar ? (
                      <motion.div
                        className="h-full w-1/3 rounded-full bg-marca-3"
                        animate={{ x: ['-120%', '340%'] }}
                        transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulsar rounded-full bg-marca-3" />
                    )}
                  </div>

                  <p className="num mt-3 text-[11px] text-muted">
                    {segundos}s decorridos · o servidor não informa percentual
                  </p>
                </>
              ) : (
                <>
                  <span
                    className={cn(
                      'flex h-14 w-14 items-center justify-center rounded-[17px] border transition-colors',
                      arrastando
                        ? 'border-marca-ciano/40 bg-marca-ciano/15'
                        : 'border-linha-2 bg-superficie',
                    )}
                  >
                    <FileSpreadsheet
                      aria-hidden
                      className={cn('h-6 w-6 transition-colors', arrastando ? 'text-marca-ciano' : 'text-muted')}
                    />
                  </span>

                  <p className="mt-5 font-display text-base font-medium text-ink">
                    {arrastando ? 'Solte para importar' : 'Arraste a planilha aqui'}
                  </p>
                  <p className="mt-1.5 text-[13px] text-muted">
                    ou clique em qualquer ponto desta área para escolher o arquivo
                  </p>

                  <span className="mt-6 flex h-10 items-center gap-2 rounded-sm bg-marca px-5 font-display text-sm font-semibold text-[#05070f] transition-shadow group-hover:shadow-brilho">
                    <Upload aria-hidden className="h-4 w-4" />
                    Selecionar planilha
                  </span>

                  <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                    {FORMATOS.map((f) => (
                      <span
                        key={f}
                        className="num rounded-full border border-linha bg-superficie px-2.5 py-1 text-[11px] text-ink-2"
                      >
                        {f}
                      </span>
                    ))}
                    <span className="text-[11px] text-muted">até 25 MB</span>
                  </div>
                </>
              )}
            </label>
          </motion.section>

          {/* Requisitos e regras — o que evita a maior parte das recusas */}
          <motion.aside
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.16, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="cartao flex flex-col gap-5 p-6"
          >
            <div className="flex items-center gap-2.5">
              <ListChecks aria-hidden className="h-4 w-4 text-marca-ciano" />
              <h2 className="font-display text-sm font-semibold text-ink">Antes de enviar</h2>
            </div>

            <ul className="space-y-3.5 text-[13px] leading-relaxed text-ink-2">
              <li className="flex gap-2.5">
                <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                <span>
                  A planilha precisa ter uma coluna de <strong className="font-medium text-ink">CPF</strong> e
                  uma de <strong className="font-medium text-ink">nome</strong>. O cabeçalho é reconhecido
                  automaticamente.
                </span>
              </li>
              <li className="flex gap-2.5">
                <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                <span>
                  Formatos aceitos: <span className="num text-ink">.csv</span> e{' '}
                  <span className="num text-ink">.xlsx</span>, com até 25 MB e 100 mil linhas.
                  Arquivo <span className="num text-ink">.xls</span> antigo: abra no Excel e
                  salve como <span className="num text-ink">.xlsx</span>.
                </span>
              </li>
              <li className="flex gap-2.5">
                <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-alerta" />
                <span>
                  Arquivos de conteúdo idêntico a um já importado são recusados, para não duplicar a
                  carteira. A recusa informa a data da importação anterior.
                </span>
              </li>
              <li className="flex gap-2.5">
                <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-alerta" />
                <span>
                  Linhas inválidas não bloqueiam a importação: o restante entra e os erros ficam
                  disponíveis linha a linha no histórico.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Clock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-marca-ciano" />
                <span>
                  A gravação acontece <strong className="font-medium text-ink">em segundo plano</strong>.
                  Depois de confirmar, você pode sair desta página — o andamento e o resultado ficam
                  no histórico.
                </span>
              </li>
            </ul>
          </motion.aside>
        </div>

        {/* ── Resultado do último envio ── */}
        {aviso && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            role={aviso.tom === 'ok' ? 'status' : 'alert'}
            className={cn(
              'mt-5 flex items-start gap-3 rounded-[16px] border px-4 py-3.5 text-[13px] leading-relaxed',
              aviso.tom === 'ok' && 'border-ok/30 bg-ok/10 text-ok',
              aviso.tom === 'alerta' && 'border-alerta/30 bg-alerta/10 text-alerta',
              aviso.tom === 'erro' && 'border-erro/30 bg-erro/10 text-erro',
            )}
          >
            {aviso.tom === 'ok' && <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
            {aviso.tom === 'alerta' && <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
            {aviso.tom === 'erro' && <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0 flex-1">{aviso.texto}</span>
            <button
              onClick={() => setAviso(null)}
              aria-label="Dispensar aviso"
              className="-mr-1 shrink-0 rounded-sm p-1 opacity-70 transition-opacity hover:opacity-100"
            >
              <X aria-hidden className="h-4 w-4" />
            </button>
          </motion.div>
        )}

        {/* ── A carga que está rodando agora ──
            Substitui o "aguarde" indeterminado que existia enquanto o trabalho
            acontecia dentro da requisição. Agora há progresso REAL para mostrar:
            o worker grava `processadas` a cada bloco de 500 linhas. */}
        {andamento && (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className="cartao mt-5 p-5"
            aria-labelledby="titulo-andamento"
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <Loader2 aria-hidden className="h-4 w-4 animate-spin text-marca-ciano" />
              <h2 id="titulo-andamento" className="font-display text-sm font-semibold text-ink">
                {andamento.status === 'RECEBIDA' ? 'Na fila' : 'Processando'}
              </h2>
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={andamento.arquivoNome}>
                {andamento.arquivoNome}
              </span>
            </div>

            {/* Progresso de verdade, com valor: o leitor de tela anuncia o
                número, e não um "carregando" sem fim. */}
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={andamento.totalLinhas}
              aria-valuenow={andamento.processadas}
              aria-valuetext={`${inteiro(andamento.processadas)} de ${inteiro(andamento.totalLinhas)} linhas`}
              className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-superficie-2"
            >
              <div
                className="h-full rounded-full bg-marca-3 transition-[width] duration-500 ease-out"
                style={{
                  width: `${andamento.totalLinhas > 0 ? Math.round((andamento.processadas / andamento.totalLinhas) * 100) : 0}%`,
                }}
              />
            </div>

            <p className="num mt-2.5 text-[12px] text-ink-2">
              {inteiro(andamento.processadas)} de {inteiro(andamento.totalLinhas)} linha(s)
              {andamento.processadas > 0 && (
                <>
                  {' · '}
                  <span className="text-ok">{inteiro(andamento.sucesso)} sem erro</span>
                  {andamento.falhas > 0 && (
                    <>
                      {' · '}
                      <span className="text-erro">{inteiro(andamento.falhas)} com erro</span>
                    </>
                  )}
                </>
              )}
            </p>

            {/* A frase que muda o que o operador FAZ nos próximos minutos. Sem
                ela, ele fica olhando a barra — que é exatamente o que tirar o
                trabalho da requisição existe para evitar. */}
            <p className="mt-2 text-[12px] leading-relaxed text-muted">
              Pode fechar esta página: o processamento continua no servidor e o resultado fica no
              histórico abaixo.
            </p>
          </motion.section>
        )}

        {/* ── Indicadores das últimas importações ── */}
        {historico.st === 'ok' && historico.dados.length > 0 && (
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <CartaoKpi
              Icone={FileText}
              rotulo="Importações"
              indice={0}
              destaque
              sub="mais recentes registradas"
            >
              <Contador
                valor={lista.length}
                formatar={(n) => inteiro(Math.round(n))}
                className="num font-display text-[28px] font-semibold leading-none text-ink"
              />
            </CartaoKpi>
            <CartaoKpi Icone={ListChecks} rotulo="Linhas lidas" indice={1} sub="somando essas importações">
              <Contador
                valor={totalLinhas}
                formatar={(n) => inteiro(Math.round(n))}
                className="num font-display text-[28px] font-semibold leading-none text-ink"
              />
            </CartaoKpi>
            <CartaoKpi
              Icone={AlertTriangle}
              rotulo="Linhas com erro"
              indice={2}
              sub="revise pelo histórico abaixo"
            >
              <Contador
                valor={totalFalhas}
                formatar={(n) => inteiro(Math.round(n))}
                className={cn(
                  'num font-display text-[28px] font-semibold leading-none',
                  totalFalhas > 0 ? 'text-alerta' : 'text-ink',
                )}
              />
            </CartaoKpi>
          </div>
        )}


        {/* ── Relatório da simulação ──
            Fica entre a zona de upload e o histórico de propósito: é o passo
            obrigatório entre escolher o arquivo e gravá-lo. */}
        {simulacao && (
          <motion.section
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="cartao mt-5 p-6"
            aria-labelledby="titulo-simulacao"
          >
            <div className="mb-5 flex flex-wrap items-center gap-2.5">
              <ListChecks aria-hidden className="h-4 w-4 text-marca-ciano" />
              <h2 id="titulo-simulacao" className="font-display text-sm font-semibold text-ink">
                Simulação — nada foi gravado
              </h2>
              <span className="num ml-auto rounded-full border border-linha bg-superficie px-2.5 py-1 text-[11px] text-ink-2">
                {/* O perfil multi-tribunal não tem sigla, e o `null` renderizava
                    como vazio — sobrava um " · " órfão antes do nome. */}
                {simulacao.dados.perfil.tribunal
                  ? `${simulacao.dados.perfil.tribunal} · ${simulacao.dados.perfil.nome}`
                  : simulacao.dados.perfil.nome}
              </span>
            </div>

            <p className="mb-5 truncate text-[12px] text-muted" title={simulacao.arquivo.name}>
              {simulacao.arquivo.name} · {tamanho(simulacao.arquivo.size)} ·{' '}
              {inteiro(simulacao.dados.totalLinhas)} linha(s) lida(s)
            </p>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { r: 'Pessoas novas', v: simulacao.dados.pessoas.novas, c: 'text-marca-ciano' },
                { r: 'Já na carteira', v: simulacao.dados.pessoas.existentes, c: 'text-ink' },
                { r: 'Processos novos', v: simulacao.dados.processos.novos, c: 'text-ink' },
                { r: 'Iriam enriquecer', v: simulacao.dados.seriamEnfileiradas, c: 'text-alerta' },
              ].map((x) => (
                <div key={x.r} className="rounded-[12px] border border-linha bg-superficie px-3.5 py-3">
                  <p className={cn('num text-lg font-semibold', x.c)}>{inteiro(x.v)}</p>
                  <p className="mt-0.5 text-[11px] text-muted">{x.r}</p>
                </div>
              ))}
            </div>

            {/* Quantas linhas ficam de fora pelo MÉTODO do CPF — dito antes do
                confirmar, porque é a diferença entre "1.087 linhas lidas" e o
                que de fato vai virar processo e consulta paga. */}
            {simulacao.dados.recusadasPeloMetodo?.total > 0 && (
              <p className="mt-4 flex items-start gap-2 rounded-[12px] border border-linha bg-superficie px-3.5 py-3 text-[12px] text-ink-2">
                <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <span>
                  <span className="num font-medium text-ink">
                    {inteiro(simulacao.dados.recusadasPeloMetodo.total)}
                  </span>{' '}
                  linha(s) não entram: {simulacao.dados.recusadasPeloMetodo.motivo}. Os números
                  acima já descontam essas linhas, e nenhuma consulta é paga por elas.
                </span>
              </p>
            )}

            {simulacao.dados.arquivoJaImportado && (
              <p className="mt-4 flex items-start gap-2 rounded-[12px] border border-alerta/25 bg-alerta/[0.07] px-3.5 py-3 text-[12px] text-alerta">
                <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Este mesmo arquivo já foi importado em{' '}
                  {dataHora(simulacao.dados.arquivoJaImportado.em)}. Confirmar será recusado.
                </span>
              </p>
            )}

            {/* Aviso que nasceu com a fila: enviada às 14h05, uma carga grande
                ainda está rodando às 14h12. Sem isto, a simulação diria "tudo
                certo" para um arquivo que o confirmar vai barrar. */}
            {simulacao.dados.emAndamento && (
              <p className="mt-4 flex items-start gap-2 rounded-[12px] border border-marca-ciano/25 bg-marca-ciano/[0.07] px-3.5 py-3 text-[12px] text-marca-ciano">
                <Clock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Este mesmo arquivo já está sendo importado desde{' '}
                  {dataHora(simulacao.dados.emAndamento.em)} —{' '}
                  {inteiro(simulacao.dados.emAndamento.processadas)} de{' '}
                  {inteiro(simulacao.dados.emAndamento.totalLinhas)} linhas processadas. Confirmar
                  será recusado; acompanhe no histórico.
                </span>
              </p>
            )}

            {simulacao.dados.problemas.length > 0 && (
              <div className="mt-5">
                <p className="rotulo mb-2.5">
                  {inteiro(simulacao.dados.totalProblemas)} linha(s) com problema
                  {simulacao.dados.problemas.length < simulacao.dados.totalProblemas &&
                    ` · mostrando as ${simulacao.dados.problemas.length} primeiras`}
                </p>
                <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                  {simulacao.dados.problemas.map((x) => (
                    <li
                      key={x.linha}
                      className="flex items-center gap-3 rounded-[10px] border border-linha bg-superficie px-3 py-2 text-[12px]"
                    >
                      <span className="num shrink-0 text-muted">Linha {x.linha}</span>
                      <span className="text-ink-2">{x.motivo}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-linha pt-5">
              <button
                onClick={() => void confirmar()}
                disabled={enviando || Boolean(simulacao.dados.arquivoJaImportado)}
                className={cn(
                  'flex h-11 items-center gap-2 rounded-sm bg-marca px-5 font-display text-sm font-semibold text-[#05070f] transition-all',
                  'hover:shadow-brilho focus-visible:ring-2 focus-visible:ring-marca-ciano/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                  /* Sem opacity: ela desbota fundo e texto juntos e derruba o rótulo abaixo de 4,5:1. */
                  'disabled:cursor-not-allowed disabled:bg-superficie-2 disabled:text-muted disabled:shadow-none',
                )}
              >
                {enviando ? (
                  <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload aria-hidden className="h-4 w-4" />
                )}
                Importar de verdade
              </button>
              <button
                onClick={() => setSimulacao(null)}
                disabled={enviando}
                className="flex h-11 items-center gap-2 rounded-sm border border-linha px-4 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
              >
                <X aria-hidden className="h-4 w-4" />
                Descartar
              </button>
              <p className="text-[11px] text-muted">
                Escolher outro arquivo simula de novo — gravar exige este botão.
              </p>
            </div>
          </motion.section>
        )}

        {/* ── Histórico ── */}
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.24, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="cartao mt-5 overflow-hidden"
        >
          <div className="flex items-center gap-2.5 border-b border-linha px-6 py-4">
            <Clock aria-hidden className="h-4 w-4 text-aurora-3" />
            <h2 className="font-display text-sm font-semibold text-ink">Importações recentes</h2>
            {historico.st === 'ok' && historico.dados.length > 0 && (
              <span className="ml-auto text-[11px] text-muted">últimas {historico.dados.length}</span>
            )}
          </div>

          {historico.st === 'carregando' && (
            <div className="space-y-3 p-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <Esqueleto key={i} className="h-11" />
              ))}
            </div>
          )}

          {historico.st === 'erro' && (
            <div className="p-6">
              <BlocoErro msg={`Não foi possível carregar o histórico: ${historico.msg}`} />
              <button
                onClick={() => {
                  setHistorico(CARREGANDO);
                  void carregar();
                }}
                className="mt-4 h-9 rounded-sm border border-linha-2 bg-superficie px-4 text-[13px] text-ink-2 transition-colors hover:text-ink"
              >
                Tentar novamente
              </button>
            </div>
          )}

          {historico.st === 'ok' && historico.dados.length === 0 && (
            <Vazio
              Icone={FileSpreadsheet}
              titulo="Nenhuma importação ainda"
              descricao="Envie a primeira planilha acima e o histórico aparece aqui, com o resultado de cada linha."
            />
          )}

          {historico.st === 'ok' && historico.dados.length > 0 && (
            /* A tabela é larga: rola dentro do cartão para que a página nunca
               role na horizontal. */
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <caption className="sr-only">
                  Histórico das importações mais recentes, com status, contagem de linhas, responsável e data.
                </caption>
                <thead>
                  <tr className="border-b border-linha text-left">
                    <th scope="col" className="rotulo px-5 py-3 font-medium">Arquivo</th>
                    <th scope="col" className="rotulo px-5 py-3 font-medium">Status</th>
                    <th scope="col" className="rotulo px-5 py-3 text-right font-medium">Linhas</th>
                    <th scope="col" className="rotulo px-5 py-3 text-right font-medium">Sucesso</th>
                    <th scope="col" className="rotulo px-5 py-3 text-right font-medium">Falhas</th>
                    <th scope="col" className="rotulo px-5 py-3 font-medium">Importado por</th>
                    <th scope="col" className="rotulo px-5 py-3 font-medium">Quando</th>
                    <th scope="col" className="rotulo px-5 py-3 font-medium">
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {historico.dados.map((imp, i) => {
                    const st = STATUS[imp.status] ?? {
                      rotulo: imp.status.replace(/_/g, ' ').toLowerCase(),
                      classe: 'border-linha-2 bg-superficie text-muted',
                    };
                    const aberta = erros?.id === imp.id;
                    return (
                      <motion.tr
                        key={imp.id}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 0.3 + i * 0.03, duration: 0.4 }}
                        className={cn(
                          'border-b border-linha/60 transition-colors last:border-0 hover:bg-superficie-2',
                          aberta && 'bg-superficie',
                        )}
                      >
                        <td className="px-5 py-3.5">
                          <span
                            className="block max-w-[18rem] truncate text-ink"
                            title={imp.arquivoNome}
                          >
                            {imp.arquivoNome}
                          </span>
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className={cn(
                              'inline-block whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium',
                              st.classe,
                            )}
                          >
                            {st.rotulo}
                          </span>
                        </td>
                        <td className="num px-5 py-3.5 text-right text-ink-2">
                          {/* Enquanto a carga roda, o total sozinho não diz
                              nada: mostra-se o quanto dele já andou. */}
                          {imp.status === 'PROCESSANDO' || imp.status === 'RECEBIDA'
                            ? `${inteiro(imp.processadas)} / ${inteiro(imp.totalLinhas)}`
                            : inteiro(imp.totalLinhas)}
                        </td>
                        <td className="num px-5 py-3.5 text-right text-ok">{inteiro(imp.sucesso)}</td>
                        <td
                          className={cn(
                            'num px-5 py-3.5 text-right',
                            imp.falhas > 0 ? 'text-erro' : 'text-muted',
                          )}
                        >
                          {inteiro(imp.falhas)}
                        </td>
                        <td className="px-5 py-3.5">
                          <span
                            className="flex max-w-[12rem] items-center gap-2 text-[13px] text-ink-2"
                            title={imp.user.email}
                          >
                            <Users aria-hidden className="h-3.5 w-3.5 shrink-0 text-muted" />
                            <span className="truncate">{imp.user.nome}</span>
                          </span>
                        </td>
                        <td className="num whitespace-nowrap px-5 py-3.5 text-[12px] text-muted">
                          {dataHora(imp.criadoEm)}
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          {imp.falhas > 0 && (
                            <button
                              onClick={() => {
                                if (aberta) setErros(null);
                                else void verErros(imp);
                              }}
                              aria-expanded={aberta}
                              aria-controls="painel-erros"
                              className="whitespace-nowrap rounded-sm px-2 py-1 text-[12px] text-marca-ciano transition-colors hover:bg-marca-ciano/10"
                            >
                              {aberta ? 'Ocultar erros' : 'Ver erros'}
                            </button>
                          )}
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </motion.section>

        {/* ── Erros linha a linha ── */}
        {erros && (
          <motion.section
            id="painel-erros"
            ref={painelErros}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="cartao mt-5 overflow-hidden"
          >
            <div className="flex items-start gap-3 border-b border-linha px-6 py-4">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-alerta" />
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-sm font-semibold text-ink">Linhas recusadas</h2>
                <p className="mt-0.5 truncate text-[12px] text-muted" title={erros.nome}>
                  {erros.nome}
                </p>
              </div>
              <button
                onClick={() => setErros(null)}
                aria-label="Fechar lista de erros"
                className="shrink-0 rounded-sm p-1 text-muted transition-colors hover:text-ink"
              >
                <X aria-hidden className="h-4 w-4" />
              </button>
            </div>

            {erros.estado.st === 'carregando' && (
              <div className="space-y-2.5 p-6">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Esqueleto key={i} className="h-9" />
                ))}
              </div>
            )}

            {erros.estado.st === 'erro' && (
              <div className="p-6">
                <BlocoErro msg={`Não foi possível carregar os erros desta importação: ${erros.estado.msg}`} />
              </div>
            )}

            {erros.estado.st === 'ok' && erros.estado.dados.length === 0 && (
              <Vazio
                titulo="Nenhum detalhe de erro registrado"
                descricao="A importação contabilizou falhas, mas não há linhas detalhadas armazenadas para ela."
              />
            )}

            {erros.estado.st === 'ok' && erros.estado.dados.length > 0 && (
              <>
                <div className="max-h-[26rem] overflow-auto">
                  <table className="w-full min-w-[40rem] text-sm">
                    <caption className="sr-only">Linhas recusadas com o motivo de cada recusa.</caption>
                    <thead className="sticky top-0 z-10 bg-bg-2/95 backdrop-blur-xl">
                      <tr className="border-b border-linha text-left">
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Linha</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">CPF</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Processo</th>
                        <th scope="col" className="rotulo px-5 py-3 font-medium">Motivo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {erros.estado.dados.map((l) => (
                        <tr key={l.numeroLinha} className="border-b border-linha/60 last:border-0">
                          <td className="num whitespace-nowrap px-5 py-2.5 text-muted">{l.numeroLinha}</td>
                          <td className="num whitespace-nowrap px-5 py-2.5 text-ink-2">{l.cpf ?? '—'}</td>
                          <td className="num px-5 py-2.5 text-ink-2">{l.numeroProcesso ?? '—'}</td>
                          <td className="px-5 py-2.5 text-[13px] leading-relaxed text-erro">
                            {l.mensagemErro}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="border-t border-linha px-6 py-3 text-[11px] text-muted">
                  Exibindo {erros.estado.dados.length} linha(s) — o detalhamento é limitado às 100 primeiras.
                </p>
              </>
            )}
          </motion.section>
        )}
      </div>
    </div>
  );
}
