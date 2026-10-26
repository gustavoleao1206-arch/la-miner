'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Check, Clock, Loader2, Plus, ShieldCheck } from 'lucide-react';

import {
  anotarSolicitacao,
  atenderSolicitacao,
  registrarSolicitacao,
  solicitacoesTitular,
  type SolicitacaoTitular,
  type StatusSolicitacao,
  type TipoSolicitacao,
} from '@/lib/api';
import { cpfFormatado } from '@/lib/utils';

/**
 * CENTRAL DE PRIVACIDADE — a fila de pedidos do art. 18.
 *
 * ── POR QUE ESTA TELA EXISTE ──
 *
 * A tabela de pedidos vivia no banco desde a primeira etapa e nenhum código a
 * usava. O efeito da exclusão existia; o PROCESSO não — sem protocolo, sem
 * prazo, sem prova de tempestividade, que é o que se apresenta à ANPD.
 *
 * Uma Central acessível só por API repetiria o mesmo erro numa camada acima:
 * existe, e ninguém usa. É por isso que a tela veio junto.
 *
 * ── O QUE ELA NÃO É ──
 *
 * Não é autoatendimento do titular. Ele não tem login, e não há como autenticar
 * quem não é usuário — uma página pública onde se digita o próprio CPF seria
 * oráculo de enumeração. O canal continua sendo o e-mail publicado na Política;
 * o que muda é que agora ele deixa rastro.
 */

const TIPOS: { valor: TipoSolicitacao; rotulo: string; automatico: boolean }[] = [
  { valor: 'ACESSO', rotulo: 'Acesso aos dados', automatico: true },
  { valor: 'PORTABILIDADE', rotulo: 'Portabilidade', automatico: true },
  { valor: 'EXCLUSAO', rotulo: 'Exclusão', automatico: true },
  { valor: 'CORRECAO', rotulo: 'Correção', automatico: false },
  { valor: 'OPOSICAO', rotulo: 'Oposição ao tratamento', automatico: false },
  { valor: 'REVISAO_AUTOMATIZADA', rotulo: 'Revisão de decisão automatizada', automatico: false },
];

const ROTULO_TIPO = Object.fromEntries(TIPOS.map((t) => [t.valor, t.rotulo])) as Record<
  TipoSolicitacao,
  string
>;

const ROTULO_STATUS: Record<StatusSolicitacao, string> = {
  RECEBIDA: 'Recebida',
  EM_ANALISE: 'Em análise',
  ATENDIDA: 'Atendida',
  RECUSADA: 'Recusada',
};

/**
 * Data COM segundos, como na trilha de auditoria.
 *
 * Cópia local e não import: `dataHora` já existe assim na tela de auditoria,
 * também local. Promovê-la a `lib/utils` é limpeza legítima, mas mexer numa
 * função que a tela de auditoria usa em dois pontos não é assunto de uma
 * entrega de LGPD — vira mudança sem rede num arquivo que não é o desta tarefa.
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

/**
 * O prazo em palavras.
 *
 * Vencido primeiro e em vermelho: um pedido fora do prazo é o único item desta
 * tela que precisa interromper quem passa o olho.
 */
function Prazo({ p }: { p: SolicitacaoTitular }) {
  if (p.status === 'ATENDIDA' || p.status === 'RECUSADA') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <Check aria-hidden className="h-3.5 w-3.5" />
        {p.respondidoEm ? `respondido em ${dataHora(p.respondidoEm)}` : 'encerrado'}
      </span>
    );
  }
  if (p.vencido) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-erro">
        <AlertTriangle aria-hidden className="h-3.5 w-3.5" />
        vencido há {Math.abs(p.diasParaVencer ?? 0)} dia(s)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2">
      <Clock aria-hidden className="h-3.5 w-3.5" />
      {p.diasParaVencer} dia(s) para responder
    </span>
  );
}

export default function PrivacidadePage() {
  const [pedidos, setPedidos] = useState<SolicitacaoTitular[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [abrindo, setAbrindo] = useState(false);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const [cpf, setCpf] = useState('');
  const [tipo, setTipo] = useState<TipoSolicitacao>('EXCLUSAO');
  const [email, setEmail] = useState('');
  const [descricao, setDescricao] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setPedidos(await solicitacoesTitular());
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível carregar os pedidos.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function registrar(evento: React.FormEvent) {
    evento.preventDefault();
    setOcupado('novo');
    try {
      await registrarSolicitacao({
        cpf: cpf.replace(/\D/g, ''),
        tipo,
        email: email || undefined,
        descricao: descricao || undefined,
      });
      setCpf('');
      setEmail('');
      setDescricao('');
      setAbrindo(false);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível registrar o pedido.');
    } finally {
      setOcupado(null);
    }
  }

  async function atender(p: SolicitacaoTitular) {
    /* Confirmação em texto, não em ícone: a exclusão é IRREVERSÍVEL e alcança
       todos os escritórios, não só um. Quem clica precisa ler o que acontece. */
    const aviso =
      p.tipo === 'EXCLUSAO'
        ? `Atender o pedido ${p.protocolo} apaga telefones, e-mails, endereços e o texto livre do CRM ` +
          `do titular ${cpfFormatado(p.cpf)}, e retira o processo de circulação em TODOS os escritórios. ` +
          'É irreversível. Confirma?'
        : `Gerar o relatório de dados do pedido ${p.protocolo}?`;
    if (!window.confirm(aviso)) return;

    setOcupado(p.id);
    try {
      await atenderSolicitacao(p.id);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível atender o pedido.');
    } finally {
      setOcupado(null);
    }
  }

  async function marcarEmAnalise(p: SolicitacaoTitular) {
    setOcupado(p.id);
    try {
      await anotarSolicitacao(p.id, { status: 'EM_ANALISE' });
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível anotar o andamento.');
    } finally {
      setOcupado(null);
    }
  }

  const emAberto = pedidos.filter((p) => p.status === 'RECEBIDA' || p.status === 'EM_ANALISE');
  const vencidos = emAberto.filter((p) => p.vencido).length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight text-ink">
            <ShieldCheck aria-hidden className="h-5 w-5 text-marca-ciano" />
            Central de Privacidade
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
            Pedidos de titulares (LGPD, art. 18) recebidos pelo canal publicado na Política. Registrar
            aqui é o que faz o protocolo existir e o prazo começar a correr.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setAbrindo((v) => !v)}
          className="inline-flex cursor-pointer items-center gap-2 rounded-sm bg-marca px-4 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Plus aria-hidden className="h-4 w-4" />
          Registrar pedido
        </button>
      </header>

      {vencidos > 0 && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-erro/40 bg-erro/5 px-4 py-3 text-[13px] text-erro">
          <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
          {vencidos} pedido(s) fora do prazo de resposta.
        </p>
      )}

      {erro && (
        <p role="alert" className="mb-4 rounded-lg border border-linha bg-superficie px-4 py-3 text-[13px] text-erro">
          {erro}
        </p>
      )}

      {abrindo && (
        <form
          method="post"
          onSubmit={registrar}
          className="mb-6 grid gap-4 rounded-lg border border-linha bg-superficie p-5"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">CPF do titular</span>
              <input
                value={cpf}
                onChange={(e) => setCpf(e.target.value)}
                required
                inputMode="numeric"
                placeholder="000.000.000-00"
                className="rounded-sm border border-linha bg-fundo px-3 py-2 text-[14px] text-ink"
              />
            </label>
            <label className="grid gap-1.5">
              <span className="text-[12px] font-medium text-ink-2">Tipo do pedido</span>
              <select
                value={tipo}
                onChange={(e) => setTipo(e.target.value as TipoSolicitacao)}
                className="rounded-sm border border-linha bg-fundo px-3 py-2 text-[14px] text-ink"
              >
                {TIPOS.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.rotulo}
                    {t.automatico ? '' : ' (atendimento manual)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">
              E-mail de onde veio o pedido <span className="text-muted">(opcional)</span>
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-sm border border-linha bg-fundo px-3 py-2 text-[14px] text-ink"
            />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[12px] font-medium text-ink-2">
              Resumo do pedido <span className="text-muted">(opcional)</span>
            </span>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={2}
              maxLength={1000}
              className="rounded-sm border border-linha bg-fundo px-3 py-2 text-[14px] text-ink"
            />
            {/* O aviso mora AQUI, no ponto de digitação, porque é aqui que o
                dado sensível entra: é o campo onde caberia "estou em tratamento
                e não quero ser contatado". */}
            <span className="text-[12px] leading-relaxed text-muted">
              Resuma o que foi pedido. Evite transcrever informações de saúde ou outros dados sensíveis
              que o titular tenha mencionado.
            </span>
          </label>
          <div>
            <button
              type="submit"
              disabled={ocupado === 'novo'}
              className="inline-flex cursor-pointer items-center gap-2 rounded-sm bg-marca px-5 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
            >
              {ocupado === 'novo' && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
              Registrar e iniciar o prazo
            </button>
          </div>
        </form>
      )}

      {carregando ? (
        <p className="text-[13px] text-muted">Carregando pedidos…</p>
      ) : pedidos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-linha px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-ink">Nenhum pedido registrado</p>
          <p className="mt-1 text-[13px] text-muted">
            Quando um titular escrever para o canal de privacidade, registre o pedido aqui.
          </p>
        </div>
      ) : (
        <ul className="grid gap-3">
          {pedidos.map((p) => {
            const automatico = TIPOS.find((t) => t.valor === p.tipo)?.automatico ?? false;
            const aberto = p.status === 'RECEBIDA' || p.status === 'EM_ANALISE';
            return (
              <li key={p.id} className="rounded-lg border border-linha bg-superficie p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[12px] text-muted">{p.protocolo}</p>
                    <p className="mt-0.5 text-[15px] font-semibold text-ink">
                      {ROTULO_TIPO[p.tipo]} · {cpfFormatado(p.cpf)}
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      recebido em {dataHora(p.recebidoEm)}
                      {p.email ? ` · ${p.email}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="rounded-full border border-linha px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
                      {ROTULO_STATUS[p.status]}
                    </span>
                    <Prazo p={p} />
                  </div>
                </div>

                {p.descricao && (
                  <p className="mt-3 rounded-sm bg-fundo px-3 py-2 text-[13px] leading-relaxed text-ink-2">
                    {p.descricao}
                  </p>
                )}
                {p.resposta && (
                  <p className="mt-3 text-[13px] leading-relaxed text-muted">{p.resposta}</p>
                )}

                {aberto && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void atender(p)}
                      disabled={!automatico || ocupado === p.id}
                      title={
                        automatico
                          ? undefined
                          : 'Este tipo é atendido manualmente: escreva a resposta e encerre o pedido.'
                      }
                      className="inline-flex cursor-pointer items-center gap-2 rounded-sm bg-marca px-4 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {ocupado === p.id && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}
                      {p.tipo === 'EXCLUSAO' ? 'Atender e apagar' : 'Atender e gerar relatório'}
                    </button>
                    {p.status === 'RECEBIDA' && (
                      <button
                        type="button"
                        onClick={() => void marcarEmAnalise(p)}
                        disabled={ocupado === p.id}
                        className="cursor-pointer rounded-sm border border-linha px-4 py-2 text-[13px] text-ink-2 transition-colors hover:text-ink disabled:opacity-50"
                      >
                        Marcar em análise
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
