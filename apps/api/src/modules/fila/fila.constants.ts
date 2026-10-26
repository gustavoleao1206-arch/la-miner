/**
 * Constantes da fila em arquivo próprio, sem imports.
 * Evita ciclo: module → service → module (que faz a constante virar
 * undefined em tempo de resolução e o token cair para BullQueue_default).
 */
export const FILA_ENRIQUECIMENTO = 'enriquecimento';

/**
 * A fila da importação de planilhas. SEPARADA da de enriquecimento, e não é
 * organização: é para os dois trabalhos não se estrangularem.
 *
 * Uma importação de 100 mil linhas ocupa um worker por ~14 minutos (8,5 ms por
 * linha, medido). Na fila de enriquecimento, que roda com concorrência 5, duas
 * dessas comeriam quase metade dos slots — e o que ficaria esperando são as
 * consultas pagas da Contactra, que é justamente o trabalho com custo por
 * minuto de atraso.
 *
 * As políticas também divergem: consulta de CPF é curta e paralelizável;
 * importação é longa e roda uma de cada vez, porque duas cargas simultâneas
 * disputariam as mesmas linhas de `processos` no banco.
 */
export const FILA_IMPORTACAO = 'importacao';

/**
 * Uma importação por vez.
 *
 * Não é limitação de recurso — é correção. Duas importações concorrentes tocam
 * as mesmas linhas de `processos` (o `reconciliarProcesso` faz read-modify-write
 * sobre a chave tribunal+número), e o `P2002` que o código trata cobre a corrida
 * na CRIAÇÃO, não o intercalamento de dois diffs sobre o mesmo processo.
 */
export const CONCORRENCIA_IMPORTACAO = 1;

/**
 * Quem ainda vale consultar no provedor.
 *
 * PENDENTE nunca foi consultado. ERRO falhou por causa transitória (timeout,
 * 5xx, teto do dia) e merece nova tentativa. Ficam DE FORA: SEM_DADOS, porque
 * o provedor já respondeu que não tem nada sobre aquele CPF, e SINCRONIZADO,
 * porque já temos o dado — insistir em qualquer um dos dois só queima crédito.
 *
 * Mora aqui, e não em cada chamador, porque JÁ divergiu. Havia três respostas
 * para esta mesma pergunta: a importação enfileirava só PENDENTE, a simulação
 * contava tudo que não fosse SINCRONIZADO, e o cron usava PENDENTE+ERRO. O
 * resultado aparecia na tela — a simulação prometia 3.866 e o relatório dizia
 * 4.033, para a mesma planilha, sem nenhum dos dois estar "errado" isolado.
 *
 * NÃO unificar com `sincronizacao.agendada.ts`: lá a pergunta é outra — "quem
 * o cron deve REatualizar" —, e inclui SINCRONIZADO cuja última sincronização
 * envelheceu. É um superconjunto com regra de tempo, de propósito.
 */
export const STATUS_A_ENRIQUECER = ['PENDENTE', 'ERRO'] as const;

/** O mesmo critério de `STATUS_A_ENRIQUECER`, para quem já tem a pessoa em mãos. */
export function precisaEnriquecer(status?: string | null): boolean {
  /* Sem status é pessoa que ainda vai ser criada: nasce PENDENTE. */
  return (STATUS_A_ENRIQUECER as readonly string[]).includes(status ?? 'PENDENTE');
}
