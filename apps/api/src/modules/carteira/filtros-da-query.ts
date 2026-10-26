import { BadRequestException } from '@nestjs/common';
import type { FiltrosDaFila } from './condicoes-da-fila';
import type { LoteCarteira } from './carteira.service';

/**
 * A LEITURA DA QUERY — um lugar só, para a fila e para o funil.
 *
 * Pelo mesmo motivo de `condicoesDaFila`: se cada rota lesse os parâmetros do
 * seu jeito, bastaria uma aceitar `estagio=proposta` em minúscula e a outra não
 * para o chip contar uma coisa e a lista mostrar outra. E há um caso pior, que
 * já existia: `?exercicio=abc` virava `NaN` e entrava na consulta em silêncio.
 */

const ESTAGIOS = ['NOVO', 'EM_CONTATO', 'PROPOSTA', 'FECHADO', 'PERDIDO'] as const;
const PRIORIDADES = ['BAIXA', 'NORMAL', 'ALTA', 'URGENTE'] as const;

/* ── OS TRÊS RECORTES DO MÓDULO DE PRÉ-PRECATÓRIOS ──
   Listas fechadas, escritas aqui e não lidas do enum do Prisma, pela mesma
   razão de `ESTAGIOS`: o que a tela oferece é decisão de produto, e um valor
   novo no banco não deve virar filtro aceito sem ninguém ter decidido. */
const FASES = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
  'PRECATORIO_EXPEDIDO',
] as const;
const ESFERAS = ['FEDERAL', 'ESTADUAL', 'TRABALHISTA', 'SUPERIOR'] as const;
const CONFERENCIAS = ['NAO_CONFERIDO', 'CONFERE', 'DIVERGE'] as const;

/** As únicas janelas de "esfriou" que a tela oferece. */
const FRIOS = [7, 15, 30];

/* Teto do termo de busca. Um nome, um CPF ou um número de processo cabem de
   sobra em 120 — a caixa da tela nunca leva mais que isso. Sem o teto, um termo
   patológico entraria num `contains` (LIKE) sobre TRÊS colunas (número, nome
   normalizado, CPF): varredura disfarçada de busca, e o único parâmetro de texto
   livre do módulo. Recusar, e não truncar, pela mesma razão das listas fechadas
   — buscar por um pedaço do que se digitou devolveria "resultado" que ninguém
   pediu. */
const TERMO_MAX = 120;

export interface QueryDaFila {
  termo?: string;
  estagio?: string;
  prioridade?: string;
  responsavelId?: string;
  etiquetaId?: string;
  semContato?: string;
  frioDias?: string;
  tarefaAtrasada?: string;
  /** Uma fase só — o chip. O recorte do MÓDULO (quatro fases) é `fases`, e vem da rota. */
  fase?: string;
  esfera?: string;
  conferencia?: string;
}

function umDe<T extends readonly string[]>(
  valor: string | undefined,
  lista: T,
  rotulo: string,
): T[number] | undefined {
  if (valor === undefined || valor === '') return undefined;
  if (!lista.includes(valor)) {
    throw new BadRequestException(`${rotulo} inválido. Use um de: ${lista.join(', ')}.`);
  }
  return valor as T[number];
}

export function filtrosDaQuery(q: QueryDaFila): FiltrosDaFila {
  /* Valor fora da lista é RECUSADO, e não ignorado em silêncio: um filtro que
     o servidor descarta devolve a carteira inteira, e a tela mostraria
     "todos" achando que mostra "urgentes". */
  if (q.estagio && !ESTAGIOS.includes(q.estagio as (typeof ESTAGIOS)[number])) {
    throw new BadRequestException(`Estágio inválido. Use um de: ${ESTAGIOS.join(', ')}.`);
  }
  if (q.prioridade && !PRIORIDADES.includes(q.prioridade as (typeof PRIORIDADES)[number])) {
    throw new BadRequestException(`Prioridade inválida. Use uma de: ${PRIORIDADES.join(', ')}.`);
  }

  if (q.termo && q.termo.length > TERMO_MAX) {
    throw new BadRequestException(`O termo de busca é muito longo (máx. ${TERMO_MAX} caracteres).`);
  }

  let frioDias: number | undefined;
  if (q.frioDias !== undefined) {
    frioDias = Number(q.frioDias);
    /* Lista fechada em vez de faixa: cada valor novo é uma consulta a mais no
       cache do banco, e a tela só oferece três. Um `frioDias=1` aceito daria a
       impressão de um recurso que ninguém desenhou. */
    if (!FRIOS.includes(frioDias)) {
      throw new BadRequestException(`"frioDias" deve ser um de: ${FRIOS.join(', ')}.`);
    }
  }

  return {
    termo: q.termo,
    estagio: q.estagio as FiltrosDaFila['estagio'],
    prioridade: q.prioridade as FiltrosDaFila['prioridade'],
    responsavelId: q.responsavelId,
    etiquetaId: q.etiquetaId,
    semContato: q.semContato === 'true',
    frioDias,
    tarefaAtrasada: q.tarefaAtrasada === 'true',
    fase: umDe(q.fase, FASES, 'Estágio do crédito'),
    esfera: umDe(q.esfera, ESFERAS, 'Esfera'),
    conferencia: umDe(q.conferencia, CONFERENCIAS, 'Veredito do CPF'),
  };
}

/**
 * Lote pedido na query, ou `undefined` para o serviço cair no padrão.
 *
 * Os dois parâmetros andam JUNTOS de propósito. Aceitar só `tribunal` faria a
 * tela pedir "TRF1" e receber o exercício do padrão (2027), devolvendo em
 * silêncio um lote que ninguém escolheu — e o número na tela não bateria com
 * o rótulo ao lado dele, que é exatamente o defeito que criou o conceito de
 * lote. Ou vêm os dois, ou nenhum.
 */
export function loteDaQuery(tribunal?: string, exercicio?: string): LoteCarteira | undefined {
  if (tribunal === undefined && exercicio === undefined) return undefined;
  if (tribunal === undefined || exercicio === undefined) {
    throw new BadRequestException('Informe "tribunal" e "exercicio" juntos, ou nenhum dos dois.');
  }
  const ano = Number(exercicio);
  if (!Number.isInteger(ano) || ano < 1988 || ano > 2100) {
    throw new BadRequestException('O "exercicio" deve ser um ano válido.');
  }
  /* Caixa alta e sem hífen: a sigla é @unique nesse formato ("trf-1" e "TRF1"
     são o mesmo tribunal, e sem normalizar o primeiro não acha nada). */
  return { tribunal: tribunal.toUpperCase().replace(/-/g, ''), exercicio: ano };
}

/**
 * Janela do movimento, em dias.
 *
 * Teto de 90 porque a janela existe para responder "o que andou ULTIMAMENTE".
 * Sem teto, `dias=100000` viraria uma varredura da tabela inteira disfarçada de
 * filtro — e devolveria "movimento" que é, na prática, o estoque.
 */
export function diasDaQuery(dias?: string): number {
  if (dias === undefined) return 30;
  const n = Number(dias);
  if (!Number.isInteger(n) || n < 1 || n > 90) {
    throw new BadRequestException('"dias" deve ser um inteiro entre 1 e 90.');
  }
  return n;
}
