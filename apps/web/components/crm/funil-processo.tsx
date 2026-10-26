'use client';

import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  MessageSquare,
  Phone,
  PhoneOff,
  Trophy,
  XCircle,
} from 'lucide-react';
import {
  crm,
  type CanalContato,
  type Contato,
  type Estagio,
  type ResultadoContato,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { ESTAGIO, ORDEM_ESTAGIOS } from '@/components/carteira/estagios';

/**
 * O funil comercial de UM processo, com o registro de contato.
 *
 * ── POR QUE ESTE BLOCO EXISTE ──
 *
 * Antes dele, "em que pé está este processo" vivia em anotação de texto livre e
 * em etiqueta. A informação existia e não SOMAVA — "quantos dos 250 deste mês
 * viraram proposta?" não tinha resposta possível. Aqui o estágio é um valor de
 * uma lista fechada, e a tentativa de contato é registro estruturado.
 *
 * ── COMPONENTE PRÓPRIO, E NÃO MAIS UM PEDAÇO DA PÁGINA ──
 *
 * A tela do processo já passa de 1.600 linhas. O que decide o recorte não é o
 * tamanho, e sim o estado: este bloco tem o seu (formulário de contato, lista,
 * salvamento), e mantê-lo fora evita que ele se misture ao estado de anotações,
 * tarefas e etiquetas — que é o caminho conhecido para um componente que
 * ninguém mais consegue mudar com segurança.
 */

const CANAL: Record<CanalContato, string> = {
  TELEFONE: 'Telefone',
  WHATSAPP: 'WhatsApp',
  EMAIL: 'E-mail',
  PRESENCIAL: 'Presencial',
  OUTRO: 'Outro',
};

/**
 * Os cinco desfechos de uma tentativa.
 *
 * `NUMERO_ERRADO` tem valor próprio, e não é "não atendeu": ele denuncia base
 * de contato velha, que é problema do enriquecimento e não do vendedor. Somados,
 * os dois esconderiam exatamente essa distinção.
 */
const RESULTADO: Record<ResultadoContato, { rotulo: string; classe: string; Icone: typeof Phone }> = {
  ATENDEU: { rotulo: 'Atendeu', classe: 'text-ok', Icone: CheckCircle2 },
  NAO_ATENDEU: { rotulo: 'Não atendeu', classe: 'text-muted', Icone: PhoneOff },
  RECADO: { rotulo: 'Deixou recado', classe: 'text-marca-ciano', Icone: MessageSquare },
  NUMERO_ERRADO: { rotulo: 'Número errado', classe: 'text-alerta', Icone: XCircle },
  RECUSOU: { rotulo: 'Recusou', classe: 'text-erro', Icone: XCircle },
};

const dias = (iso: string) =>
  Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));

const dataHora = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function FunilProcesso({
  processoId,
  estagio,
  estagioEm,
  motivoPerda,
  ultimoContatoEm,
  aoAtualizar,
}: {
  processoId: string;
  estagio: Estagio;
  estagioEm: string | null;
  motivoPerda: string | null;
  ultimoContatoEm: string | null;
  /**
   * Aplica o resultado SEM reler o processo do servidor.
   *
   * Um refetch gravaria outra linha de auditoria de acesso a dado pessoal, e
   * mover no funil não é consultar o titular de novo. É a mesma regra que a
   * `BarraCrm` segue — o registro da LGPD conta ACESSOS, não cliques.
   */
  aoAtualizar: (patch: {
    estagio?: Estagio;
    estagioEm?: string | null;
    motivoPerda?: string | null;
    ultimoContatoEm?: string | null;
  }) => void;
}) {
  const [salvando, setSalvando] = useState<'estagio' | 'contato' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [motivo, setMotivo] = useState(motivoPerda ?? '');
  const [contatos, setContatos] = useState<Contato[] | null>(null);

  const [canal, setCanal] = useState<CanalContato>('TELEFONE');
  const [resultado, setResultado] = useState<ResultadoContato | null>(null);
  const [observacao, setObservacao] = useState('');

  useEffect(() => setMotivo(motivoPerda ?? ''), [motivoPerda]);

  useEffect(() => {
    let vivo = true;
    crm
      .contatos(processoId)
      .then((c) => vivo && setContatos(c))
      /* Lista de contatos que não carrega não pode impedir de REGISTRAR um
         contato novo — que é a ação que o operador veio fazer. */
      .catch(() => vivo && setContatos([]));
    return () => {
      vivo = false;
    };
  }, [processoId]);

  async function mudarEstagio(novo: Estagio) {
    if (novo === estagio) return;
    setSalvando('estagio');
    setErro(null);
    try {
      await crm.definirEstagio(processoId, novo, novo === 'PERDIDO' ? motivo : undefined);
      aoAtualizar({ estagio: novo, estagioEm: new Date().toISOString(), motivoPerda: novo === 'PERDIDO' ? motivo : null });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(null);
    }
  }

  async function registrar() {
    if (!resultado) return;
    setSalvando('contato');
    setErro(null);
    try {
      const r = await crm.registrarContato(processoId, {
        canal,
        resultado,
        observacao: observacao.trim() || undefined,
      });
      setContatos((c) => [r.contato, ...(c ?? [])]);
      setResultado(null);
      setObservacao('');
      /* O estágio pode ter saído de NOVO SOZINHO — quem diz qual ficou é a
         resposta do servidor, não um palpite daqui. */
      aoAtualizar({
        estagio: r.estagio,
        ultimoContatoEm: r.contato.criadoEm,
        ...(r.estagio !== estagio ? { estagioEm: r.contato.criadoEm } : {}),
      });
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(null);
    }
  }

  return (
    <section aria-labelledby="titulo-funil" className="cartao mt-5 p-6">
      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id="titulo-funil" className="font-display text-sm font-semibold text-ink">
          Funil comercial
        </h2>
        {/* "Parado há N dias" é a pergunta que separa um funil vivo de uma lista
            de intenções — e só aparece quando há de fato um marco. */}
        {estagioEm && estagio !== 'NOVO' && (
          <span className="num text-[12px] text-muted">
            neste estágio há {dias(estagioEm)} dia(s)
          </span>
        )}
        <span className="ml-auto text-[12px] text-muted">
          {ultimoContatoEm ? (
            <>último contato há {dias(ultimoContatoEm)} dia(s)</>
          ) : (
            <span className="text-alerta">ninguém contatou ainda</span>
          )}
        </span>
      </div>

      <div role="group" aria-label="Estágio no funil" className="flex flex-wrap gap-1.5">
        {ORDEM_ESTAGIOS.map((e) => {
          const ativo = estagio === e;
          return (
            <button
              key={e}
              type="button"
              aria-pressed={ativo}
              disabled={salvando === 'estagio'}
              onClick={() => void mudarEstagio(e)}
              className={cn(
                'rounded-[10px] border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                ativo ? ESTAGIO[e].ativo : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
              )}
            >
              {ESTAGIO[e].singular}
            </button>
          );
        })}
      </div>

      {estagio === 'PERDIDO' && (
        <div className="mt-4">
          <label htmlFor="motivo-perda" className="rotulo mb-1.5 block">
            Por que se perdeu
          </label>
          {/* Campo livre, e não lista: o motivo real varia mais do que qualquer
              enum aguenta ("titular faleceu", "já cedeu", "achou pouco"), e
              engessá-lo faria todo mundo escolher "Outro". */}
          <div className="flex flex-wrap gap-2">
            <input
              id="motivo-perda"
              value={motivo}
              maxLength={300}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="Titular já cedeu para outro escritório"
              className="h-9 min-w-[18rem] flex-1 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
            />
            <button
              type="button"
              disabled={salvando === 'estagio' || motivo === (motivoPerda ?? '')}
              onClick={() => void crm.definirEstagio(processoId, 'PERDIDO', motivo).then(() => aoAtualizar({ motivoPerda: motivo }))}
              className="h-9 rounded-[11px] border border-linha px-4 text-[13px] text-ink-2 transition-colors hover:border-linha-2 disabled:opacity-40"
            >
              Salvar motivo
            </button>
          </div>
        </div>
      )}

      {/* ── Registrar contato ── */}
      <div className="mt-6 border-t border-linha pt-5">
        <p className="rotulo mb-3 flex items-center gap-1.5">
          <Phone aria-hidden className="h-3 w-3" />
          Registrar tentativa de contato
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="canal" className="rotulo mb-1.5 block">
              Canal
            </label>
            <select
              id="canal"
              value={canal}
              onChange={(e) => setCanal(e.target.value as CanalContato)}
              className="h-9 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
            >
              {(Object.keys(CANAL) as CanalContato[]).map((c) => (
                <option key={c} value={c}>
                  {CANAL[c]}
                </option>
              ))}
            </select>
          </div>

          <div className="min-w-0 flex-1">
            <p className="rotulo mb-1.5">No que deu</p>
            {/* Obrigatório: registrar que se ligou sem dizer no que deu produz
                exatamente o dado que não responde nada. */}
            <div role="group" aria-label="Resultado do contato" className="flex flex-wrap gap-1.5">
              {(Object.keys(RESULTADO) as ResultadoContato[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-pressed={resultado === r}
                  onClick={() => setResultado(r)}
                  className={cn(
                    'rounded-[10px] border px-3 py-1.5 text-[12px] transition-colors',
                    resultado === r
                      ? 'border-marca-ciano/40 bg-marca-ciano/10 text-marca-ciano'
                      : 'border-linha text-muted hover:border-linha-2 hover:bg-superficie',
                  )}
                >
                  {RESULTADO[r].rotulo}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={observacao}
            maxLength={2000}
            onChange={(e) => setObservacao(e.target.value)}
            placeholder="O que ficou combinado (opcional)"
            aria-label="Observação do contato"
            className="h-9 min-w-[18rem] flex-1 rounded-[11px] border border-linha bg-superficie px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
          />
          <button
            type="button"
            disabled={!resultado || salvando === 'contato'}
            onClick={() => void registrar()}
            className="flex h-9 items-center gap-2 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-superficie-2 disabled:text-muted"
          >
            {salvando === 'contato' ? (
              <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Phone aria-hidden className="h-3.5 w-3.5" />
            )}
            Registrar
          </button>
        </div>

        {erro && (
          <p role="alert" className="mt-3 text-[12px] text-erro">
            {erro}
          </p>
        )}

        {/* ── Histórico ── */}
        {contatos && contatos.length > 0 && (
          <ul className="mt-5 space-y-2">
            {contatos.slice(0, 8).map((c) => {
              const r = RESULTADO[c.resultado];
              return (
                <li
                  key={c.id}
                  className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-[11px] border border-linha bg-superficie px-3.5 py-2.5 text-[12px]"
                >
                  <r.Icone aria-hidden className={cn('h-3.5 w-3.5 shrink-0 self-center', r.classe)} />
                  <span className={cn('font-medium', r.classe)}>{r.rotulo}</span>
                  <span className="text-muted">· {CANAL[c.canal]}</span>
                  <span className="num text-muted">· {dataHora(c.criadoEm)}</span>
                  <span className="text-muted">· {c.autor.nome}</span>
                  {c.observacao && (
                    <span className="w-full text-[12px] leading-relaxed text-ink-2">
                      {c.observacao}
                    </span>
                  )}
                </li>
              );
            })}
            {contatos.length > 8 && (
              <li className="px-1 text-[11px] text-muted">
                e mais {contatos.length - 8} tentativa(s) anteriores
              </li>
            )}
          </ul>
        )}

        {contatos?.length === 0 && (
          <p className="mt-4 flex items-center gap-2 text-[12px] text-muted">
            <Trophy aria-hidden className="h-3.5 w-3.5" />
            Nenhuma tentativa registrada. A primeira ligação tira este processo de “novo”.
          </p>
        )}
      </div>
    </section>
  );
}
