'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Estagio, Etiqueta, MembroEquipe, Prioridade } from '@/lib/api';
import { ESTAGIO, ORDEM_ESTAGIOS, PRIORIDADES, rotuloPrioridade } from './estagios';

/**
 * Some quando não há seleção — a barra só existe se houver o que fazer.
 *
 * As ações são aplicadas por BOTÃO, e não ao trocar o select: mudar 200
 * processos é a operação mais destrutiva desta tela, e um `onChange` que já
 * grava transforma um clique errado numa varrida irreversível.
 */
export function BarraDeLote({
  quantidade,
  equipe,
  etiquetas,
  aoAplicar,
  aoLimpar,
}: {
  quantidade: number;
  equipe: MembroEquipe[];
  etiquetas: Etiqueta[];
  aoAplicar: (dados: {
    estagio?: Estagio;
    motivoPerda?: string;
    prioridade?: Prioridade;
    responsavelId?: string | null;
    etiquetaIds?: string[];
  }) => Promise<void>;
  aoLimpar: () => void;
}) {
  const [estagio, setEstagio] = useState<string>('');
  const [motivo, setMotivo] = useState<string>('');
  const [prioridade, setPrioridade] = useState<string>('');
  const [responsavel, setResponsavel] = useState<string>('');
  const [etiqueta, setEtiqueta] = useState<string>('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const temAlgo = estagio || prioridade || responsavel || etiqueta;

  const selectClasse =
    'h-9 rounded-[11px] border border-linha bg-bg/60 px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40';

  async function aplicar() {
    setSalvando(true);
    setErro(null);
    try {
      await aoAplicar({
        estagio: (estagio || undefined) as Estagio,
        /* Só viaja com PERDIDO — o servidor aplica a mesma regra, e mandar o
           texto junto de "Proposta" seria pedir para gravar um motivo de perda
           num processo que não se perdeu. */
        motivoPerda: estagio === 'PERDIDO' && motivo.trim() ? motivo.trim() : undefined,
        prioridade: (prioridade || undefined) as Prioridade,
        /* `remover` vira null EXPLÍCITO: o backend distingue "tira o dono" de
           "não mexe", e mandar undefined nos dois casos perderia a diferença. */
        responsavelId: responsavel === '' ? undefined : responsavel === 'remover' ? null : responsavel,
        etiquetaIds: etiqueta ? [etiqueta] : undefined,
      });
      setEstagio('');
      setMotivo('');
      setPrioridade('');
      setResponsavel('');
      setEtiqueta('');
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section
      aria-label="Ação em massa"
      className="mt-4 rounded-[16px] border border-marca-ciano/30 bg-marca-ciano/[0.06] p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="num text-[13px] font-medium text-marca-ciano">
          {quantidade.toLocaleString('pt-BR')} selecionado(s)
        </span>

        <select aria-label="Mover no funil" value={estagio} onChange={(e) => setEstagio(e.target.value)} className={selectClasse}>
          <option value="">Mover no funil…</option>
          {ORDEM_ESTAGIOS.map((v) => (
            <option key={v} value={v}>
              {ESTAGIO[v].singular}
            </option>
          ))}
        </select>

        <select aria-label="Definir prioridade" value={prioridade} onChange={(e) => setPrioridade(e.target.value)} className={selectClasse}>
          <option value="">Prioridade…</option>
          {PRIORIDADES.map((p) => (
            <option key={p} value={p}>
              {rotuloPrioridade(p)}
            </option>
          ))}
        </select>

        <select aria-label="Definir responsável" value={responsavel} onChange={(e) => setResponsavel(e.target.value)} className={selectClasse}>
          <option value="">Responsável…</option>
          <option value="remover">Remover responsável</option>
          {equipe.map((m) => (
            <option key={m.id} value={m.id}>
              {m.nome}
            </option>
          ))}
        </select>

        {etiquetas.length > 0 && (
          <select aria-label="Acrescentar etiqueta" value={etiqueta} onChange={(e) => setEtiqueta(e.target.value)} className={selectClasse}>
            <option value="">Acrescentar etiqueta…</option>
            {etiquetas.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          disabled={!temAlgo || salvando}
          onClick={() => void aplicar()}
          className="flex h-9 items-center gap-2 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-superficie-2 disabled:text-muted"
        >
          {salvando && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
          Aplicar aos {quantidade}
        </button>

        <button
          type="button"
          onClick={aoLimpar}
          className="h-9 rounded-[11px] px-3 text-[13px] text-muted transition-colors hover:text-ink-2"
        >
          Limpar seleção
        </button>
      </div>

      {/* ── O MOTIVO DA PERDA ──
          Aparece SÓ quando o destino é Perdido: um campo de texto sempre
          visível numa barra de ação em massa convida a escrever ali qualquer
          coisa, e "por que perdemos" é a pergunta mais acionável do funil —
          merece um campo que só existe quando faz sentido.
          Opcional de propósito: obrigá-lo em 200 processos produziria carimbo
          genérico, que é pior que o vazio porque parece dado. */}
      {estagio === 'PERDIDO' && (
        <div className="mt-3">
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            maxLength={300}
            placeholder="Por que se perdeu? (opcional — ex.: lote sem telefone válido)"
            aria-label="Motivo da perda"
            className="h-9 w-full rounded-[11px] border border-linha bg-bg/60 px-3 text-[13px] text-ink-2 outline-none focus:border-marca-ciano/40"
          />
        </div>
      )}

      {/* A etiqueta ACRESCENTA. Dizer isso na tela evita a suposição oposta —
          que seria destrutiva sobre a triagem já feita. */}
      <p className="mt-2.5 text-[11px] text-muted">
        A etiqueta é acrescentada às que o processo já tem; as demais ações substituem o valor atual.
      </p>

      {erro && (
        <p role="alert" className="mt-2 text-[12px] text-erro">
          {erro}
        </p>
      )}
    </section>
  );
}
