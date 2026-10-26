import type { UseQueryResult } from '@tanstack/react-query';
import { CARREGANDO, type Estado } from '@/components/estado';

/**
 * Converte um resultado do React Query no `Estado<T>` que as telas já falam
 * (carregando | erro | ok).
 *
 * A regra do meio é o que torna o auto-refresh SEM PISCA: durante um refetch,
 * `isFetching` é true mas `data` continua presente — devolvemos 'ok' com o dado
 * atual, então a tela não volta ao esqueleto a cada atualização. Só cai em
 * 'carregando' na primeira carga, quando ainda não há dado nenhum.
 */
export function comoEstadoQuery<T>(q: UseQueryResult<T>): Estado<T> {
  if (q.data !== undefined) return { st: 'ok', dados: q.data };
  if (q.isError) return { st: 'erro', msg: (q.error as Error)?.message ?? 'Falha ao carregar' };
  return CARREGANDO;
}
