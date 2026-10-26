'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { negociacao, type FolhaDaProposta } from '@/lib/api';
import { brl } from '@/lib/utils';
import { BlocoErro } from '@/components/estado';
import { descricaoDaFase } from '@/components/fase-processo';

/**
 * A FOLHA DA PROPOSTA — para imprimir e entregar.
 *
 * ── NENHUM ARQUIVO É GERADO NEM GUARDADO ──
 *
 * É uma página do próprio sistema que sai pela impressão do navegador. Não há
 * PDF no banco nem arquivo em disco — decisão de produto: o banco não pode
 * crescer com arquivos. Se o escritório imprimir em PDF, o arquivo é dele, na
 * máquina dele, fora do nosso banco. É intencional.
 *
 * Gerar PDF no servidor arrastaria um navegador inteiro (~300 MB) para dentro do
 * deploy, para produzir algo que a decisão de produto proíbe guardar.
 *
 * ── NA MESMA ABA, NUNCA NUMA NOVA ──
 *
 * O token de acesso vive em `sessionStorage`, que NÃO atravessa abas. Uma aba
 * nova tomaria 401, renovaria em paralelo com a original, e a trava que protege
 * dessa corrida (`renovacaoEmVoo`, em lib/api.ts) não cruza abas: as duas
 * renovações simultâneas caem na detecção de reuso do servidor e derrubam a
 * sessão inteira — com um alarme falso no log de segurança. Esta página é
 * navegação normal, e o botão que leva até ela também.
 */
export default function PropostaPage() {
  return (
    <Suspense fallback={null}>
      <Folha />
    </Suspense>
  );
}

function Folha() {
  const { id } = useParams<{ id: string }>();
  const parametros = useSearchParams();
  const propostaId = parametros.get('proposta');
  /* Padrão TITULAR também aqui, e não só no servidor: as duas pontas caem no
     lado seguro se o parâmetro faltar. */
  const destino = parametros.get('destino') === 'INTERNO' ? 'INTERNO' : 'TITULAR';

  const [folha, setFolha] = useState<FolhaDaProposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    if (!propostaId) {
      setErro('Falta indicar qual proposta imprimir.');
      return;
    }
    try {
      setFolha(await negociacao.relatorio(id, propostaId, destino));
    } catch (e) {
      setErro((e as Error).message);
    }
  }, [id, propostaId, destino]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (erro) return <BlocoErro msg={erro} className="m-6" />;
  if (!folha) return <p className="p-6 text-sm text-muted">Preparando a folha…</p>;

  const p = folha.proposta;
  const cessao = p.modalidade === 'CESSAO';
  /* `undefined` quando a fase não é conhecida: o documento então imprime o valor
     cru do enum, feio e honesto, em vez de um rótulo inventado. */
  const estagio = descricaoDaFase(folha.precatorio.fase);

  return (
    <div className="folha mx-auto max-w-[820px] p-8">
      {/* Só na tela: some na impressão. */}
      <div className="sem-impressao mb-6 flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {destino === 'TITULAR'
            ? 'Folha do titular — sem a margem do escritório.'
            : 'Folha INTERNA — contém a margem. Não entregue esta versão ao titular.'}
        </p>
        <button
          type="button"
          onClick={() => window.print()}
          className="h-9 rounded-[11px] bg-marca px-4 text-[13px] font-medium text-[#05070f]"
        >
          Imprimir
        </button>
      </div>

      {/* ── TIMBRE ──
          Do ESCRITÓRIO, nunca nosso: a marca do produto não pode aparecer no
          papel que ele entrega ao titular dele. */}
      <header className="border-b border-linha pb-4">
        <h1 className="font-display text-[20px] font-semibold text-ink">{folha.escritorio.nome}</h1>
        {folha.escritorio.cnpj && (
          <p className="num text-[12px] text-muted">CNPJ {folha.escritorio.cnpj}</p>
        )}
      </header>

      <h2 className="mt-6 text-[16px] font-medium text-ink">
        {cessao ? 'Proposta de cessão de crédito' : 'Proposta de honorários'}
      </h2>
      <p className="mt-1 text-[12px] text-muted">
        Emitida em {new Date(p.emitidaEm).toLocaleDateString('pt-BR')} · rodada {p.rodada}
      </p>

      {/* ── "O crédito", e não "O precatório" ──
          Esta folha é ASSINADA pelo titular. Enquanto a base era 100% precatório
          expedido, o título era simplesmente verdadeiro. Com os pré-precatórios
          na carteira, ele passou a afirmar exigibilidade formada sobre crédito
          que pode estar em trânsito em julgado — e o escritório entregava o papel
          de boa-fé, porque a tela não lhe dizia a diferença.

          O título vale para as cinco fases; quem dá a precisão é a linha
          "Estágio" logo abaixo, que nomeia o que o crédito É. Um título
          condicional continuaria afirmando — e afirmaria errado no dia em que
          entrasse uma fase que ninguém previu. */}
      <Bloco titulo="O crédito">
        {/* PRIMEIRA linha do bloco, antes até do número: é o qualificador que
            muda o significado de todas as outras. */}
        <Linha
          rotulo="Estágio"
          valor={estagio?.curto ?? folha.precatorio.fase}
          nota={estagio?.explica}
        />
        <Linha rotulo="Número" valor={folha.precatorio.numero} />
        {folha.precatorio.numeroOriginario && (
          <Linha rotulo="Processo originário" valor={folha.precatorio.numeroOriginario} />
        )}
        <Linha rotulo="Tribunal" valor={folha.precatorio.tribunal} />
        <Linha rotulo="Entidade devedora" valor={folha.precatorio.entidadeDevedora ?? '—'} />
        {/* O travessão sozinho lia-se como "dado faltando". O exercício não
            falta: ele ainda NÃO EXISTE antes de o precatório entrar na fila
            orçamentária, e a nota diz isso em vez de deixar o leitor supor. */}
        <Linha
          rotulo="Exercício"
          valor={String(folha.precatorio.exercicio ?? '—')}
          nota={
            folha.precatorio.exercicio === null
              ? 'definido quando o precatório entra na fila orçamentária'
              : undefined
          }
        />
      </Bloco>

      <Bloco titulo={folha.titulares.length > 1 ? 'Titulares' : 'Titular'}>
        {/* CPF COMPLETO: é um documento que identifica quem assina — e é por
            isso que abri-lo deixa trilha, ao contrário da fila. */}
        {folha.titulares.map((t) => (
          <Linha key={t.cpf} rotulo={t.nome} valor={`CPF ${t.cpf}`} />
        ))}
      </Bloco>

      <Bloco titulo="A proposta">
        {p.baseValor && (
          <Linha
            rotulo="Valor do crédito"
            valor={brl(p.baseValor)}
            /* A ORIGEM da base sai IMPRESSA: é o que impede alguém de negociar
               sobre o número errado sem perceber. */
            nota={
              p.baseOrigem === 'SOMA_DAS_PARTES'
                ? 'soma dos valores individuais das partes'
                : 'valor individual da parte'
            }
          />
        )}

        {cessao ? (
          <>
            <Linha rotulo="Valor oferecido ao titular" valor={p.valorProposto ? brl(p.valorProposto) : '—'} destaque />
            {p.custasEstimadas && (
              <Linha
                rotulo="Custas estimadas"
                valor={brl(p.custasEstimadas)}
                nota={
                  p.custasPorContaDe === 'TITULAR'
                    ? 'por conta do titular'
                    : 'por conta do escritório'
                }
              />
            )}
            <Linha
              rotulo="Líquido a receber"
              valor={p.liquidoAoTitular ? brl(p.liquidoAoTitular) : '—'}
              destaque
            />
          </>
        ) : (
          <Linha
            rotulo="Honorários do escritório"
            valor={p.honorarioPercentual ? `${p.honorarioPercentual}%` : '—'}
            nota="sobre o valor que o titular vier a receber"
            destaque
          />
        )}

        {p.validaAte && (
          <Linha
            rotulo="Proposta válida até"
            valor={new Date(p.validaAte).toLocaleDateString('pt-BR')}
          />
        )}
      </Bloco>

      {/* O bloco interno só existe na folha interna — e o `?.` aqui não é
          defensivo: é o tipo obrigando a checagem. */}
      {folha.interno && (
        <Bloco titulo="Uso interno — não entregar">
          <Linha
            rotulo="Deságio"
            valor={folha.interno.desagioPercentual ? `${folha.interno.desagioPercentual}%` : '—'}
          />
          {folha.interno.observacao && (
            <Linha rotulo="Observação" valor={folha.interno.observacao} />
          )}
          {folha.interno.historico.map((h) => (
            <Linha
              key={h.rodada}
              rotulo={`Rodada ${h.rodada} (${h.origem === 'TITULAR' ? 'titular' : 'escritório'})`}
              valor={`${h.valorProposto ? brl(h.valorProposto) : '—'} · ${h.status.toLowerCase()}`}
            />
          ))}
        </Bloco>
      )}

      {destino === 'TITULAR' && (
        <>
          <p className="mt-8 text-[12px] leading-relaxed text-muted">
            Esta é uma proposta comercial, não vinculante, sujeita à conferência da documentação e
            à confirmação dos dados do processo junto ao tribunal.
          </p>

          <div className="mt-12 grid gap-10 sm:grid-cols-2">
            <Assinatura rotulo={folha.titulares[0]?.nome ?? 'Titular'} />
            <Assinatura rotulo={folha.escritorio.nome} />
          </div>
        </>
      )}
    </div>
  );
}

/** `break-inside: avoid` para o bloco não rachar entre duas páginas. */
function Bloco({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="bloco-folha mt-6">
      <h3 className="rotulo border-b border-linha pb-1.5">{titulo}</h3>
      <div className="mt-2.5 space-y-1.5">{children}</div>
    </section>
  );
}

function Linha({
  rotulo,
  valor,
  nota,
  destaque,
}: {
  rotulo: string;
  valor: string;
  nota?: string;
  destaque?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[13px] text-muted">{rotulo}</span>
      <span className={destaque ? 'num text-[15px] font-medium text-ink' : 'num text-[13px] text-ink-2'}>
        {valor}
        {nota && <span className="ml-1.5 text-[11px] font-normal text-muted-2">({nota})</span>}
      </span>
    </div>
  );
}

function Assinatura({ rotulo }: { rotulo: string }) {
  return (
    <div className="bloco-folha">
      <div className="h-12 border-b border-ink-2" />
      <p className="mt-1.5 text-[12px] text-muted">{rotulo}</p>
    </div>
  );
}
