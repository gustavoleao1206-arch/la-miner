'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Hourglass } from 'lucide-react';

import {
  prePrecatorios,
  resumoPrePrecatorios,
  type FiltrosFila,
  type PaginaFila,
  type ResumoPrePrecatorios as Resumo,
} from '@/lib/api';
import { useLote } from '@/lib/lote';
import { useUsuario } from '@/lib/usuario';
import { cn } from '@/lib/utils';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';
import { Esqueleto } from '@/components/metricas';
import { Paginacao } from '@/components/paginacao';
import { ResumoPrePrecatorios } from '@/components/pre-precatorios/resumo';
import { FiltrosPrePrecatorios } from '@/components/pre-precatorios/filtros';
import { CabecalhoDaLista, LinhaPrePrecatorio } from '@/components/pre-precatorios/linha';

/**
 * O MÓDULO DE PRÉ-PRECATÓRIOS.
 *
 * ── POR QUE TELA PRÓPRIA, E NÃO UMA ABA DA CARTEIRA ──
 *
 * Duas coisas mudam juntas, e uma delas não é filtro. O RECORTE: a carteira é
 * recortada por lote (tribunal + exercício), e pré-precatório não tem exercício
 * — nenhum lote o alcança, e o seletor só oferece pares que existem na base. E o
 * SENTIDO: a carteira é sobre precatórios; estes são o estágio anterior, de dezenas de
 * tribunais, com valor indicativo e sem exigibilidade formada.
 *
 * ── O QUE A TELA RESPONDE, E EM QUE ORDEM ──
 *
 * Até 18/09/2026 ela era só uma tabela: respondia "quais são". Agora responde,
 * de cima para baixo, "o que chegou" e "por onde começo" (o topo: dois números
 * e duas quebras que também filtram), a busca, e só então "quais são" (a lista,
 * com hierarquia). É a ordem em que o operador pensa.
 *
 * ── O QUE ELA AINDA NÃO TEM, DE PROPÓSITO ──
 *
 * Nem quadro nem ações em lote. A carteira os tem porque lá a rotina é mover
 * dezenas por dia; aqui a primeira pergunta é "o que chegou e vale abordar". O
 * CRM completo de cada processo continua a um clique, na página dele — é o mesmo
 * `Processo`, com a mesma timeline, as mesmas anotações e a mesma negociação.
 */
const INICIAL: FiltrosFila = { pagina: 1, porPagina: 50 };

export default function PrePrecatoriosPage() {
  /* O catálogo já está no ar para o painel inteiro — é dele que a linha tira o
     nome do tribunal e a esfera, sem requisição própria. */
  const { catalogo } = useLote();
  /* O filtro por veredito do CPF é só da operação interna. `carregado` entra na
     conta porque o padrão do contexto é "não é cliente": sem ele, o filtro
     piscaria na tela do assinante até o usuário resolver. */
  const { ehCliente, carregado } = useUsuario();
  const mostrarCpf = carregado && !ehCliente;
  const [filtros, setFiltros] = useState<FiltrosFila>(INICIAL);
  const [pagina, setPagina] = useState<Estado<PaginaFila>>(CARREGANDO);
  const [resumo, setResumo] = useState<Estado<Resumo>>(CARREGANDO);
  const [atualizando, setAtualizando] = useState(false);

  /* Dois cliques rápidos em chips diferentes disparam duas consultas; se a
     primeira chegar por último, a lista mostraria o recorte errado sob o chip
     certo. Só a resposta do ÚLTIMO pedido entra. */
  const pedido = useRef(0);

  const carregar = useCallback(async () => {
    const meu = ++pedido.current;
    setAtualizando(true);
    try {
      const dados = await prePrecatorios(filtros);
      if (meu !== pedido.current) return;
      setPagina({ st: 'ok', dados });
    } catch (e) {
      if (meu !== pedido.current) return;
      setPagina({ st: 'erro', msg: (e as Error).message });
    } finally {
      if (meu === pedido.current) setAtualizando(false);
    }
  }, [filtros]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /* O resumo depende só da BUSCA: os três chips ficam de fora (ver
     `resumoPrePrecatorios`), e a paginação não muda contagem nenhuma. Amarrar
     ao `termo` e não a `filtros` é o que evita refazer os agregados a cada
     clique de chip ou troca de página. */
  const termo = filtros.termo;
  const recarregarResumo = useCallback(async () => {
    try {
      setResumo({ st: 'ok', dados: await resumoPrePrecatorios({ termo }) });
    } catch (e) {
      setResumo({ st: 'erro', msg: (e as Error).message });
    }
  }, [termo]);

  useEffect(() => {
    void recarregarResumo();
  }, [recarregarResumo]);

  /* Volta para a página 1 a cada mudança de filtro: manter a paginação
     mostraria a página 3 de um resultado que talvez só tenha uma. */
  const mexer = (m: Partial<FiltrosFila>) => setFiltros((f) => ({ ...f, ...m, pagina: 1 }));
  const filtrando = Boolean(
    filtros.termo || filtros.fase || filtros.esfera || filtros.conferencia,
  );

  return (
    /* A MESMA moldura da Carteira e do Funil. A versão anterior usava
       `espaco-pagina` e `titulo-pagina`, classes que nunca existiram no CSS —
       a tela nascia sem margem e com o título em texto corrido, e boa parte do
       "parece Excel" vinha daí. */
    <div className="space-y-5 p-6 lg:p-9">
      <header className="mb-1">
        <p className="rotulo flex items-center gap-1.5">
          <Hourglass aria-hidden className="h-3.5 w-3.5" />
          Estágio anterior ao precatório
        </p>
        {/* ── SEM PARÁGRAFO DE APRESENTAÇÃO ──
            O dono o retirou em 20/09/2026: era um bloco de texto que todo mundo
            pulava e empurrava a lista para baixo. A ressalva que ele carregava
            ("o valor é indicativo, extraído do texto") NÃO se perdeu — ela viaja
            com cada número, no til e no "estimado" de `ValorIndicativo`, e a
            frase inteira está no `title` de cada valor da lista. É o lugar onde
            ela de fato é lida: ao lado do número que decide a abordagem. */}
        <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
          Pré-precatórios
        </h1>
      </header>

      <ResumoPrePrecatorios resumo={resumo} filtros={filtros} aoMudar={mexer} />

      <FiltrosPrePrecatorios
        filtros={filtros}
        resumo={resumo.st === 'ok' ? resumo.dados : null}
        mostrarCpf={mostrarCpf}
        aoMudar={mexer}
        aoLimpar={() => setFiltros(INICIAL)}
        filtrando={filtrando}
      />

      {pagina.st === 'carregando' && (
        <div className="cartao space-y-2 p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <Esqueleto key={i} className="h-12 w-full" />
          ))}
        </div>
      )}

      {pagina.st === 'erro' && (
        <div className="cartao p-5">
          <BlocoErro msg={pagina.msg} />
        </div>
      )}

      {pagina.st === 'ok' && pagina.dados.itens.length === 0 && (
        <div className="cartao">
          <Vazio
            Icone={Hourglass}
            titulo="Nenhum pré-precatório"
            descricao={
              filtrando
                ? 'Nada encontrado para este recorte. Confira a busca ou limpe os filtros.'
                : 'Quando uma carga de pré-precatórios for importada, os processos aparecem aqui.'
            }
            acao={
              filtrando ? (
                <button
                  type="button"
                  className="flex h-9 items-center rounded-[11px] border border-linha px-3 text-[13px] text-ink-2 transition-colors hover:border-linha-2"
                  onClick={() => setFiltros(INICIAL)}
                >
                  Limpar filtros
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {pagina.st === 'ok' && pagina.dados.itens.length > 0 && (
        <section
          aria-label="Lista de pré-precatórios"
          aria-busy={atualizando}
          className={cn('cartao overflow-hidden p-0 transition-opacity', atualizando && 'opacity-60')}
        >
          <CabecalhoDaLista />
          <ul>
            {pagina.dados.itens.map((i) => (
              <LinhaPrePrecatorio key={i.id} item={i} catalogo={catalogo} />
            ))}
          </ul>
          <Paginacao
            pagina={pagina.dados}
            aoIr={(p) => setFiltros((f) => ({ ...f, pagina: p }))}
          />
        </section>
      )}
    </div>
  );
}
