import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';

/* Mocka o cliente da API ANTES de importar lote.tsx: o provider chama
   `api('/carteira/tribunais')` na montagem, e o teste controla o que ele recebe
   sem subir back nenhum.

   `vi.hoisted` porque `vi.mock` é içado para o topo do arquivo — uma const
   comum não existiria ainda quando a fábrica do mock roda. */
const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: apiMock }));

/* O provider passou a perguntar QUEM está olhando: o padrão do assinante é
   diferente do padrão do operador. Mockado aqui pelo mesmo motivo da api —
   o teste controla a resposta sem montar a árvore inteira do painel. */
const { usuarioMock } = vi.hoisted(() => ({
  usuarioMock: vi.fn(() => ({ ehCliente: false, carregado: true })),
}));
vi.mock('@/lib/usuario', () => ({ useUsuario: usuarioMock }));

import { ProvedorLote, useLote, useUfsDoLote, TODAS_UFS } from '@/lib/lote';

const CATALOGO = [
  {
    sigla: 'TRF1',
    nome: 'TRF1',
    esfera: 'FEDERAL',
    ufsJurisdicao: ['AC', 'AM', 'AP', 'BA', 'DF', 'GO', 'MA', 'MT', 'PA', 'PI', 'RO', 'RR', 'TO'],
    exercicios: [],
    processos: 0,
  },
  {
    sigla: 'TRF5',
    nome: 'TRF5',
    esfera: 'FEDERAL',
    ufsJurisdicao: ['AL', 'CE', 'PB', 'PE', 'RN', 'SE'],
    exercicios: [{ exercicio: 2027, processos: 4188 }],
    processos: 4188,
  },
];

const wrapper = ({ children }: { children: ReactNode }) => <ProvedorLote>{children}</ProvedorLote>;

beforeEach(() => {
  sessionStorage.clear();
  apiMock.mockReset();
  apiMock.mockResolvedValue(CATALOGO);
  usuarioMock.mockReturnValue({ ehCliente: false, carregado: true });
});

describe('ProvedorLote — lote padrão', () => {
  it('abre no lote com MAIS processos da organização', async () => {
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.carregando).toBe(false));

    // TRF5/2027 tem 4188; é o palpite certo para quase todo escritório.
    expect(result.current.lote).toEqual({ tribunal: 'TRF5', exercicio: 2027 });
  });

  it('a query sai pronta para anexar na URL', async () => {
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.lote).not.toBeNull());
    expect(result.current.query).toBe('tribunal=TRF5&exercicio=2027');
  });

  it('definir() persiste no sessionStorage e sobrevive ao reload', async () => {
    const primeiro = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(primeiro.result.current.lote).not.toBeNull());

    act(() => primeiro.result.current.definir({ tribunal: 'TRF5', exercicio: 2027 }));
    expect(sessionStorage.getItem('miner.lote')).toContain('TRF5');
  });

  /**
   * Um lote guardado que NÃO existe mais na carteira (perdeu os processos) não
   * pode ser aceito: deixaria a tela permanentemente vazia, e o operador não
   * saberia que o culpado é a sessão anterior. Cai no padrão.
   */
  it('lote guardado inexistente no catálogo cai no padrão', async () => {
    sessionStorage.setItem('miner.lote', JSON.stringify({ tribunal: 'TRF3', exercicio: 2099 }));
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.carregando).toBe(false));

    expect(result.current.lote).toEqual({ tribunal: 'TRF5', exercicio: 2027 });
  });

  it('catálogo que falha não trava o painel (lote fica nulo, telas usam o padrão da API)', async () => {
    apiMock.mockRejectedValueOnce(new Error('rede caiu'));
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.carregando).toBe(false));

    expect(result.current.lote).toBeNull();
    expect(result.current.query).toBe('');
  });
});

describe('useUfsDoLote — UFs derivadas do tribunal', () => {
  it('põe a jurisdição do tribunal em foco PRIMEIRO, depois as demais', async () => {
    const { result } = renderHook(
      () => ({ ufs: useUfsDoLote(), lote: useLote() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.lote.lote).not.toBeNull());

    const ufs = result.current.ufs;
    // As 6 do TRF5 vêm primeiro, na ordem da jurisdição.
    expect(ufs.slice(0, 6)).toEqual(['AL', 'CE', 'PB', 'PE', 'RN', 'SE']);
    // E o total é 27, sem repetição — requerente pode morar em qualquer estado.
    expect(ufs).toHaveLength(27);
    expect(new Set(ufs).size).toBe(27);
  });

  it('sem lote resolvido, devolve as 27 — melhor demais que esconder', async () => {
    apiMock.mockRejectedValueOnce(new Error('sem catálogo'));
    const { result } = renderHook(
      () => ({ ufs: useUfsDoLote(), lote: useLote() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.lote.carregando).toBe(false));

    expect(result.current.ufs).toEqual(TODAS_UFS);
    expect(result.current.ufs).toHaveLength(27);
  });

  it('a lista antiga do Nordeste NÃO é mais a fonte (inclui BA e PI, que são do TRF1)', async () => {
    const { result } = renderHook(
      () => ({ ufs: useUfsDoLote(), lote: useLote() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.lote.lote).not.toBeNull());

    // BA e PI existem na lista (são UFs válidas), mas NÃO entre as 6 primeiras
    // do TRF5 — que era o bug da lista fixa antiga.
    const primeirasSeis = result.current.ufs.slice(0, 6);
    expect(primeirasSeis).not.toContain('BA');
    expect(primeirasSeis).not.toContain('PI');
  });
});

/**
 * O cliente NÃO recebe recorte que não pediu.
 *
 * Aconteceu de verdade: o assinante pagou por 250 precatórios, recebeu os 250
 * (158 no TRF1, 92 no TRF5) e a tela abriu no TRF1 — o "maior" lote —
 * mostrando 158. O back já tinha sido consertado para não recortar cliente; era
 * o FRONT que continuava pedindo o recorte, e pedido explícito manda.
 */
describe('ProvedorLote — o cliente abre sem recorte', () => {
  const comoCliente = () => usuarioMock.mockReturnValue({ ehCliente: true, carregado: true });

  it('não escolhe lote sozinho: a query sai VAZIA', async () => {
    comoCliente();
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.carregando).toBe(false));

    expect(result.current.lote).toBeNull();
    /* Query vazia = a API não recebe tribunal nem exercício, e devolve a
       carteira inteira. É o conserto, medido no ponto em que ele age. */
    expect(result.current.query).toBe('');
  });

  it('o operador CONTINUA abrindo no maior lote', async () => {
    /* A metade que não podia mudar junto. */
    const { result } = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(result.current.carregando).toBe(false));

    expect(result.current.lote).toEqual({ tribunal: 'TRF5', exercicio: 2027 });
  });

  it('escolha do próprio cliente é respeitada e sobrevive ao reload', async () => {
    comoCliente();
    const primeiro = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(primeiro.result.current.carregando).toBe(false));

    act(() => primeiro.result.current.definir({ tribunal: 'TRF5', exercicio: 2027 }));
    expect(primeiro.result.current.query).toBe('tribunal=TRF5&exercicio=2027');

    const segundo = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(segundo.result.current.lote).not.toBeNull());
    expect(segundo.result.current.lote).toEqual({ tribunal: 'TRF5', exercicio: 2027 });
  });

  it('definir(null) LIMPA o recorte e não ressuscita no reload', async () => {
    /* Sem apagar o guardado, o cliente que voltasse para "todos" veria a
       carteira encolher sozinha no próximo F5, sem ter mexido em nada. */
    comoCliente();
    const primeiro = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(primeiro.result.current.carregando).toBe(false));

    act(() => primeiro.result.current.definir({ tribunal: 'TRF5', exercicio: 2027 }));
    act(() => primeiro.result.current.definir(null));

    expect(primeiro.result.current.lote).toBeNull();
    expect(sessionStorage.getItem('miner.lote')).toBeNull();

    const segundo = renderHook(() => useLote(), { wrapper });
    await waitFor(() => expect(segundo.result.current.carregando).toBe(false));
    expect(segundo.result.current.lote).toBeNull();
  });

  it('enquanto não se sabe QUEM olha, nada é decidido', async () => {
    /* A ordem importa: com o efeito rodando antes de `carregado`, todo cliente
       cairia no ramo do operador — que é exatamente o defeito de origem. */
    usuarioMock.mockReturnValue({ ehCliente: true, carregado: false });
    const { result } = renderHook(() => useLote(), { wrapper });

    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
    expect(result.current.lote).toBeNull();
  });
});
