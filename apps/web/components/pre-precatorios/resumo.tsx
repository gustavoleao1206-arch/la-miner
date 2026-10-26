'use client';

import { motion } from 'framer-motion';
import { Coins, Hourglass } from 'lucide-react';

import type { FiltrosFila, ResumoPrePrecatorios as Dados } from '@/lib/api';
import { cn, compacto } from '@/lib/utils';
import { descricaoDaFase } from '@/components/fase-processo';
import { Kpi } from '@/components/kpi';
import { Contador, Esqueleto } from '@/components/metricas';
import { BlocoErro, type Estado } from '@/components/estado';
import { ESFERA, ESFERA_CURTA, FASES_PRE, ORDEM_ESFERAS } from './vocabulario';

/**
 * O TOPO DO MÓDULO — "o que chegou" e "por onde começo", na mesma faixa.
 *
 * Quatro cartões. Os dois primeiros são número puro: quantos processos e quanto
 * valem (com a ressalva de que é palpite). Os dois últimos são a carteira
 * QUEBRADA — por estágio do crédito e por justiça — e são também o filtro:
 * cada linha da legenda é um botão. Antes havia a quebra em chips E ela de novo
 * em números soltos; duas vezes o mesmo dado é ruído, não organização.
 *
 * ── SEM CARTÃO DE CPF, DE PROPÓSITO ──
 *
 * A primeira versão tinha "CPF confere" e "CPF a conferir" aqui. O dono tirou
 * em 18/09/2026: o assinante lê "719 a conferir" como defeito do que comprou.
 * O agregado de CPF ficou só como filtro da operação interna (ver `filtros.tsx`),
 * e o servidor nem o manda ao cliente.
 *
 * ── AS CORES ──
 *
 * Estágio é ORDEM (o crédito anda da esquerda para a direita): uma tinta só, do
 * claro ao escuro. Justiça é IDENTIDADE: uma cor fixa por esfera, a mesma do
 * ponto ao lado da sigla na lista. Em nenhum dos dois a cor trabalha sozinha —
 * o nome e o número estão escritos na legenda.
 */
const NUMERO = 'num font-display text-[27px] font-semibold leading-none text-ink';
const inteiro = (n: number) => Math.round(n).toLocaleString('pt-BR');

/** Do mais distante ao mais próximo de virar precatório: tinta cada vez mais cheia. */
const TINTA_DA_FASE = ['bg-ink/25', 'bg-ink/45', 'bg-ink/65', 'bg-ink/90'];

export function ResumoPrePrecatorios({
  resumo,
  filtros,
  aoMudar,
}: {
  resumo: Estado<Dados>;
  filtros: FiltrosFila;
  aoMudar: (m: Partial<FiltrosFila>) => void;
}) {
  const d = resumo.st === 'ok' ? resumo.dados : null;

  const numero = (valor: number, formatar: (n: number) => string) =>
    d ? (
      <Contador valor={valor} formatar={formatar} className={NUMERO} />
    ) : (
      <Esqueleto className="h-7 w-2/3" />
    );

  /* `undefined` antes do resumo chegar (não se sabe nada); depois dele, o que o
     agrupamento não devolveu é zero de verdade. */
  const porFase = FASES_PRE.map((fase, i) => ({
    chave: fase,
    rotulo: descricaoDaFase(fase)?.curto ?? fase,
    cor: TINTA_DA_FASE[i],
    quantidade: d ? (d.porFase.find((x) => x.fase === fase)?.quantidade ?? 0) : undefined,
  }));
  const porEsfera = ORDEM_ESFERAS.map((esfera) => ({
    chave: esfera,
    rotulo: ESFERA_CURTA[esfera],
    cor: ESFERA[esfera].ponto,
    quantidade: d ? (d.porEsfera.find((x) => x.esfera === esfera)?.quantidade ?? 0) : undefined,
  }));

  return (
    <div className="space-y-3">
      {resumo.st === 'erro' && (
        /* A lista é o trabalho; o resumo é acessório. Ele falha sozinho, com
           motivo — e os filtros abaixo continuam de pé, só que sem número. */
        <BlocoErro msg={`Não foi possível carregar o resumo: ${resumo.msg}`} />
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {resumo.st !== 'erro' && (
          <>
            <Kpi
              Icone={Hourglass}
              rotulo="Processos"
              destaque
              indice={0}
              valor={numero(d?.total ?? 0, inteiro)}
              sub={
                d
                  ? `em ${inteiro(d.tribunais)} ${d.tribunais === 1 ? 'tribunal' : 'tribunais'}`
                  : undefined
              }
            />
            <Kpi
              Icone={Coins}
              rotulo="Valor estimado"
              indice={1}
              valor={numero(Number(d?.valorIndicativo ?? 0), (n) => `~R$ ${compacto(n)}`)}
              /* O "de quantos" vai junto da soma, e a ressalva também: sem eles a
                 soma passa por dinheiro apurado — e não é, é texto de publicação. */
              sub={
                d ? (
                  <span>
                    soma do valor extraído do texto de{' '}
                    <span className="num">{inteiro(d.comValorIndicativo)}</span> processos ·
                    indicativo, não apurado
                  </span>
                ) : undefined
              }
            />
          </>
        )}

        <Quebra
          titulo="Por estágio"
          indice={2}
          itens={porFase}
          ativo={filtros.fase}
          aoAlternar={(fase) => aoMudar({ fase: filtros.fase === fase ? undefined : fase })}
        />
        <Quebra
          titulo="Por justiça"
          indice={3}
          itens={porEsfera}
          ativo={filtros.esfera}
          aoAlternar={(esfera) =>
            aoMudar({ esfera: filtros.esfera === esfera ? undefined : esfera })
          }
        />
      </div>
    </div>
  );
}

/**
 * Um cartão de QUEBRA: a barra proporcional em cima, a legenda clicável embaixo.
 *
 * A barra é só leitura — alvo pequeno demais para clicar com precisão. O filtro
 * é a linha da legenda, que tem altura de botão, o nome por extenso e o número.
 * Com um filtro aceso, os outros segmentos da barra esmaecem: dá para ver de
 * relance que fatia da carteira a lista abaixo está mostrando.
 */
function Quebra<T extends string>({
  titulo,
  indice,
  itens,
  ativo,
  aoAlternar,
}: {
  titulo: string;
  indice: number;
  itens: { chave: T; rotulo: string; cor: string; quantidade: number | undefined }[];
  ativo: T | undefined;
  aoAlternar: (chave: T) => void;
}) {
  const comNumero = itens.every((i) => i.quantidade !== undefined);
  const total = itens.reduce((s, i) => s + (i.quantidade ?? 0), 0);

  return (
    <motion.section
      aria-label={titulo}
      initial={{ opacity: 0, y: 16, filter: 'blur(6px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ delay: 0.05 * indice, duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-full flex-col rounded-[18px] border border-linha bg-vidro p-5 shadow-cartao backdrop-blur-xl"
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="rotulo">{titulo}</p>
        <span className="text-[10px] text-muted-2">clique para filtrar</span>
      </div>

      {/* 2px de fundo entre as fatias: sem o respiro, duas tintas vizinhas viram
          uma mancha só. Fatia zerada não entra — largura mínima a inventaria. */}
      <div className="mt-3 flex h-2 gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {comNumero && total > 0 ? (
          itens
            .filter((i) => (i.quantidade ?? 0) > 0)
            .map((i) => (
              <span
                key={i.chave}
                style={{ flexGrow: i.quantidade, flexBasis: 0 }}
                className={cn(
                  'min-w-[3px] transition-opacity',
                  i.cor,
                  ativo && ativo !== i.chave && 'opacity-25',
                )}
              />
            ))
        ) : (
          <span className="grow bg-superficie-2" />
        )}
      </div>

      <ul className="-mx-2 mt-3 space-y-0.5">
        {itens.map((i) => {
          const aceso = ativo === i.chave;
          return (
            <li key={i.chave}>
              <button
                type="button"
                aria-pressed={aceso}
                onClick={() => aoAlternar(i.chave)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-[8px] border px-2 text-[12px] transition-colors',
                  aceso
                    ? 'border-linha-2 bg-superficie-2 font-medium text-ink'
                    : 'border-transparent text-ink-2 hover:bg-superficie',
                )}
              >
                <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-[3px]', i.cor)} />
                <span className="truncate">{i.rotulo}</span>
                {i.quantidade !== undefined && (
                  <span className={cn('num ml-auto', aceso ? 'text-ink' : 'text-muted')}>
                    {i.quantidade.toLocaleString('pt-BR')}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </motion.section>
  );
}
