'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Provedor do React Query para o painel.
 *
 * `staleTime` curto + `refetchInterval` nas telas fazem o dashboard se atualizar
 * sozinho — os números se movem quando o dado muda (a fila enchendo, uma
 * importação entrando), sem o usuário recarregar. `refetchOnWindowFocus` traz o
 * painel de volta ao presente quando ele reabre a aba.
 *
 * O QueryClient nasce dentro de um `useState` para ser criado UMA vez por
 * montagem do cliente — um `new QueryClient()` solto no corpo recriaria o cache
 * a cada render.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
