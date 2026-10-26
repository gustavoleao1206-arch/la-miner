import type { Estagio, Prioridade } from '@/lib/api';

/**
 * O VOCABULÁRIO DO FUNIL — um lugar só.
 *
 * Estava em duas cópias que já divergiam: a fila (`carteira/page.tsx`) dizia
 * "Novos/Fechados" e o bloco do processo (`crm/funil-processo.tsx`) dizia
 * "Novo/Fechado", com as mesmas classes de cor escritas duas vezes. A tela do
 * sócio e o quadro seriam a terceira e a quarta — e a hora de unificar é ANTES
 * de multiplicar, não depois.
 *
 * ── POR QUE PLURAL E SINGULAR CONVIVEM, DE PROPÓSITO ──
 *
 * Um chip de filtro é um GRUPO ("Novos" = mostre-me os novos). Um selo numa
 * linha é um ESTADO ("Novo" = este processo é novo). Unificar os dois num só
 * texto deixaria uma das duas telas lendo errado em português. São duas
 * palavras porque são duas coisas — e é isso que este comentário protege da
 * próxima "simplificação".
 */

export const ORDEM_ESTAGIOS: Estagio[] = [
  'NOVO',
  'EM_CONTATO',
  'PROPOSTA',
  'FECHADO',
  'PERDIDO',
];

/** Como o estágio se chama num FILTRO (grupo) e num SELO (estado). */
export const ESTAGIO: Record<
  Estagio,
  { plural: string; singular: string; ativo: string; texto: string }
> = {
  NOVO: {
    plural: 'Novos',
    singular: 'Novo',
    ativo: 'border-linha-2 bg-superficie-2 text-ink',
    texto: 'text-muted',
  },
  EM_CONTATO: {
    plural: 'Em contato',
    singular: 'Em contato',
    ativo: 'border-marca-ciano/40 bg-marca-ciano/10 text-marca-ciano',
    texto: 'text-marca-ciano',
  },
  PROPOSTA: {
    plural: 'Proposta',
    singular: 'Proposta',
    ativo: 'border-alerta/40 bg-alerta/10 text-alerta',
    texto: 'text-alerta',
  },
  FECHADO: {
    plural: 'Fechados',
    singular: 'Fechado',
    ativo: 'border-ok/40 bg-ok/10 text-ok',
    texto: 'text-ok',
  },
  PERDIDO: {
    plural: 'Perdidos',
    singular: 'Perdido',
    ativo: 'border-erro/40 bg-erro/10 text-erro',
    texto: 'text-erro',
  },
};

export const PRIORIDADES: Prioridade[] = ['URGENTE', 'ALTA', 'NORMAL', 'BAIXA'];

export const COR_PRIORIDADE: Record<Prioridade, string> = {
  URGENTE: 'text-erro',
  ALTA: 'text-alerta',
  NORMAL: 'text-muted',
  BAIXA: 'text-muted-2',
};

/** `URGENTE` → `Urgente`. O enum é do banco; a tela é de gente. */
export const rotuloPrioridade = (p: Prioridade) => p.charAt(0) + p.slice(1).toLowerCase();

/**
 * Como se DIZ que N processos se moveram para um estágio.
 *
 * Nem o plural nem o singular do selo servem aqui: "4 proposta" e "4 perdido"
 * é o que sai ao reaproveitar o rótulo de estado, e foi o que apareceu na
 * primeira conferência na tela. Dois estágios pedem preposição ("em contato",
 * "em proposta", invariáveis) e dois pedem concordância de número.
 */
export function rotuloDeMovimento(e: Estagio, n: number): string {
  switch (e) {
    case 'EM_CONTATO':
      return 'em contato';
    case 'PROPOSTA':
      return 'em proposta';
    case 'FECHADO':
      return n === 1 ? 'fechado' : 'fechados';
    case 'PERDIDO':
      return n === 1 ? 'perdido' : 'perdidos';
    default:
      return n === 1 ? 'novo' : 'novos';
  }
}
