'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react';

import { api } from '@/lib/api';

/**
 * ── EXCLUIR CONTA DE CLIENTE ──
 *
 * A tela SONDA antes de oferecer o botão. Exclusão é o tipo de ação em que a
 * surpresa não tem conserto: o administrador que acredita estar apagando, e na
 * verdade vai anonimizar (ou o contrário), decide certo sobre um fato errado.
 * Por isso o diálogo mostra primeiro O QUE VAI ACONTECER e POR QUÊ, direto do
 * servidor — a tela repete o motivo, nunca o interpreta. Regra duplicada aqui
 * seria regra que um dia diverge da do banco, e o dia da divergência é o dia em
 * que alguém apaga o que não queria.
 *
 * A confirmação por digitação é atrito de propósito. Clicar na linha errada de
 * uma lista é fácil; digitar o CNPJ de outra empresa, não.
 */

interface Sondagem {
  organizationId: string;
  nome: string;
  cnpj: string | null;
  modo: 'EXCLUIDA' | 'ANONIMIZADA';
  motivo: string;
  faturasPagas: number;
  usuarios: number;
  processosNaCarteira: number;
  processosProprios: number;
  importacoes: number;
  /** Buscas na trilha de acesso. É o número que costuma decidir o modo: basta
      o cliente ter usado a busca uma vez para a conta deixar de ser apagável. */
  consultas: number;
}

export function ExcluirCliente({
  organizationId,
  nome,
  desabilitado,
  aoConcluir,
}: {
  organizationId: string;
  nome: string;
  desabilitado?: boolean;
  aoConcluir: (modo: 'EXCLUIDA' | 'ANONIMIZADA', nome: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [sondagem, setSondagem] = useState<Sondagem | null>(null);
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  async function abrir() {
    setAberto(true);
    setErro(null);
    setConfirmacao('');
    setSondagem(null);
    setOcupado(true);
    try {
      setSondagem(await api<Sondagem>(`/clientes/${organizationId}/exclusao`));
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível analisar esta conta.');
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar() {
    setOcupado(true);
    setErro(null);
    try {
      const r = await api<{ modo: 'EXCLUIDA' | 'ANONIMIZADA'; nome: string }>(
        `/clientes/${organizationId}`,
        { method: 'DELETE', body: JSON.stringify({ confirmacao }) },
      );
      setAberto(false);
      aoConcluir(r.modo, r.nome);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  }

  /* O que se digita: o documento quando existe, o nome quando não. O mesmo
     critério do servidor — e ele é quem decide de verdade. */
  const esperado = sondagem?.cnpj ?? sondagem?.nome ?? '';
  const soDigitos = (v: string) => v.replace(/\D+/g, '');
  const confere = sondagem?.cnpj
    ? soDigitos(confirmacao) === soDigitos(sondagem.cnpj)
    : confirmacao.trim() === (sondagem?.nome ?? '').trim();

  return (
    <>
      <button
        type="button"
        onClick={() => void abrir()}
        disabled={desabilitado}
        className="flex h-9 items-center gap-2 rounded-full border border-erro/30 px-4 text-[12px] text-erro transition-colors hover:border-erro/60 disabled:opacity-45"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Excluir conta
      </button>

      {aberto && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Excluir a conta ${nome}`}
        >
          <div className="w-full max-w-lg rounded-lg border border-linha bg-superficie p-6 shadow-cartao">
            <div className="flex items-start justify-between gap-4">
              <h2 className="font-display text-[17px] font-medium text-ink">
                Excluir <span className="text-muted">{nome}</span>
              </h2>
              <button
                type="button"
                onClick={() => setAberto(false)}
                aria-label="Fechar"
                className="text-muted transition-colors hover:text-ink"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>

            {ocupado && !sondagem && (
              <p className="mt-6 flex items-center gap-2 text-[13px] text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Analisando o histórico desta conta…
              </p>
            )}

            {sondagem && (
              <>
                <div
                  className={
                    sondagem.modo === 'EXCLUIDA'
                      ? 'mt-5 flex items-start gap-2.5 rounded-[14px] border border-erro/25 bg-erro/[0.07] px-4 py-3 text-[13px] text-erro'
                      : 'mt-5 flex items-start gap-2.5 rounded-[14px] border border-alerta/25 bg-alerta/[0.07] px-4 py-3 text-[13px] text-alerta'
                  }
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    <strong className="font-semibold">
                      {sondagem.modo === 'EXCLUIDA'
                        ? 'Esta conta será apagada por completo.'
                        : 'Esta conta será anonimizada, não apagada.'}
                    </strong>{' '}
                    {sondagem.motivo}
                  </span>
                </div>

                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-2 text-[13px] sm:grid-cols-5">
                  {[
                    ['Usuários', sondagem.usuarios],
                    ['Na carteira', sondagem.processosNaCarteira],
                    ['Faturas pagas', sondagem.faturasPagas],
                    ['Importações', sondagem.importacoes],
                    ['Consultas', sondagem.consultas],
                  ].map(([rotulo, valor]) => (
                    <div key={String(rotulo)}>
                      <dt className="rotulo">{rotulo}</dt>
                      <dd className="num text-[17px] font-semibold text-ink">
                        {Number(valor).toLocaleString('pt-BR')}
                      </dd>
                    </div>
                  ))}
                </dl>

                <label className="mt-6 block text-[13px] text-ink-2">
                  Para confirmar, digite{' '}
                  <strong className="font-semibold text-ink">
                    {sondagem.cnpj ? 'o CNPJ' : 'o nome'}
                  </strong>{' '}
                  desta conta: <span className="num text-muted">{esperado}</span>
                  <input
                    value={confirmacao}
                    onChange={(e) => setConfirmacao(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-2 h-10 w-full rounded-sm border border-linha bg-bg-2 px-3 text-[14px] text-ink outline-none focus:border-marca-ciano"
                  />
                </label>
              </>
            )}

            {erro && <p className="mt-4 text-[13px] text-erro">{erro}</p>}

            <div className="mt-6 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setAberto(false)}
                className="h-9 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:text-ink"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void confirmar()}
                /* Só habilita quando o que foi digitado bate. O servidor confere
                   de novo — isto aqui é conforto, não segurança. */
                disabled={!sondagem || !confere || ocupado}
                className="flex h-9 items-center gap-2 rounded-full bg-erro px-4 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {ocupado && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {sondagem?.modo === 'ANONIMIZADA' ? 'Anonimizar conta' : 'Excluir conta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
