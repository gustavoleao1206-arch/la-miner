import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Funil, PerdaEscrita, Safra } from '@/lib/api';

/**
 * A TELA DO SÓCIO.
 *
 * Metade destes casos verifica o que a tela NÃO mostra. Não é zelo excessivo:
 * um painel comercial é lido em reunião, e um número errado ali vira decisão de
 * contratar gente ou de cancelar assinatura. Os dois proibidos têm nome —
 * "taxa de conversão da carteira" e qualquer soma em reais — e cada um tem o
 * seu teste.
 */

const { crm, useLote, navegacao } = vi.hoisted(() => ({
  crm: { funil: vi.fn(), safras: vi.fn(), perdas: vi.fn() },
  useLote: vi.fn(),
  /* Mutável de propósito: cada teste escolhe em que VISTA a página abre. O
     padrão da suíte é a tela do sócio — é ela que estes casos fixam — e o
     teste do padrão do produto zera a busca para provar que /funil abre no
     quadro. */
  navegacao: { busca: 'vista=metricas' },
}));

/* O funil passou a ler `?vista=` (quadro é o padrão do produto desde
   21/08/2026; as métricas continuam em ?vista=metricas). O hook precisa de um
   dublê fora do App Router. */
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navegacao.busca),
}));

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return {
    ...real,
    crm,
    /* Nunca resolve: no teste da vista padrão o Quadro fica no esqueleto, sem
       tentar rede — o comportamento do quadro em si tem a própria suíte. */
    filaDeTrabalho: vi.fn(() => new Promise(() => {})),
  };
});

vi.mock('@/lib/lote', async (original) => {
  const real = await original<typeof import('@/lib/lote')>();
  return { ...real, useLote };
});

import FunilPage from '@/app/(painel)/funil/page';

const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

function funil(over: Partial<Funil> = {}): Funil {
  return {
    total: 500,
    NOVO: 430,
    EM_CONTATO: 40,
    PROPOSTA: 16,
    FECHADO: 9,
    PERDIDO: 5,
    semContato: 445,
    movimento: {
      dias: 30,
      desde: '2026-07-12T00:00:00.000Z',
      NOVO: 0,
      EM_CONTATO: 12,
      PROPOSTA: 4,
      FECHADO: 1,
      PERDIDO: 2,
    },
    ...over,
  };
}

function safra(over: Partial<Safra> = {}): Safra {
  return {
    competencia: '2026-03-01T00:00:00.000Z',
    parcial: false,
    alvo: 250,
    liberados: 250,
    noRecorte: 168,
    NOVO: 180,
    EM_CONTATO: 40,
    PROPOSTA: 12,
    FECHADO: 13,
    PERDIDO: 5,
    ...over,
  };
}

beforeEach(() => {
  navegacao.busca = 'vista=metricas';
  vi.clearAllMocks();
  useLote.mockReturnValue({ lote: LOTE, definir: vi.fn(), catalogo: [], carregando: false, query: '' });
  crm.funil.mockResolvedValue(funil());
  crm.safras.mockResolvedValue([safra()]);
  crm.perdas.mockResolvedValue([] as PerdaEscrita[]);
});

describe('Tela do sócio', () => {
  it('mostra o funil de hoje e o que se moveu', async () => {
    render(<FunilPage />);

    expect(await screen.findByText('500')).toBeInTheDocument();
    /* "Em negociação" = em contato + proposta: é a pergunta do sócio, e nenhum
       dos dois números sozinho a responde. */
    expect(screen.getByText('56')).toBeInTheDocument();
    expect(screen.getByText('445')).toBeInTheDocument();
    /* Movimento = tudo que mudou de estágio, menos os novos. */
    expect(screen.getByText('19')).toBeInTheDocument();
  });

  it('a conversão da safra é "13 de 250", nunca um percentual solto', async () => {
    /**
     * Percentual sozinho esconde o tamanho da amostra: numa safra de 12
     * processos ele oscila 8 pontos com um único fechamento, e quem lê a tela
     * não tem como saber disso.
     */
    render(<FunilPage />);

    expect(await screen.findByText('13 de 250')).toBeInTheDocument();
    const tela = document.body.textContent ?? '';
    expect(tela).not.toMatch(/\d+[,.]\d%/);
  });

  it('NÃO existe "taxa de conversão da carteira"', async () => {
    /**
     * O número proibido. Entram 250 por mês e os fechados se acumulam para
     * sempre: fechados ÷ carteira CAI todo mês por construção, sem ninguém ter
     * trabalhado pior. Mostrá-lo a um cliente seria entregar o argumento de
     * cancelamento pronto.
     */
    render(<FunilPage />);
    await screen.findByText('500');

    const tela = (document.body.textContent ?? '').toLowerCase();
    expect(tela).not.toContain('taxa de conversão');
    expect(tela).not.toContain('conversão da carteira');
  });

  it('não mostra dinheiro nenhum', async () => {
    /* `Processo.valor` é o valor de FACE — o que o ente público deve ao titular,
       não o que o escritório ganha. Somá-lo por estágio daria "R$ 42 milhões em
       negociação" numa reunião. */
    render(<FunilPage />);
    await screen.findByText('500');

    expect(document.body.textContent).not.toContain('R$');
  });

  it('o mês corrente é marcado como em curso', async () => {
    /* Sem a marca, o último ponto da série sempre pareceria uma queda — ele está
       incompleto por definição, não por desempenho. */
    crm.safras.mockResolvedValue([safra({ parcial: true, liberados: 90, FECHADO: 1 })]);
    render(<FunilPage />);

    expect(await screen.findByText('em curso')).toBeInTheDocument();
  });

  it('a safra diz quantos dela estão no lote em foco', async () => {
    /* O sorteio do ciclo não filtra por tribunal: sem este número, "250" ao lado
       de uma fila de 168 pareceria 82 processos sumidos. */
    render(<FunilPage />);

    expect(await screen.findByText(/168 neste lote/)).toBeInTheDocument();
  });

  it('sem safra, explica por quê em vez de mostrar um bloco vazio', async () => {
    /* A organização INTERNA cai aqui sempre: é ela quem libera os lotes. */
    crm.safras.mockResolvedValue([]);
    render(<FunilPage />);

    expect(await screen.findByText(/não tem safra própria/)).toBeInTheDocument();
  });

  it('cada estágio leva à fila já filtrada', async () => {
    render(<FunilPage />);
    await screen.findByText('500');

    /* Um painel que só informa obriga o sócio a pedir a alguém que abra a
       lista. O link é o que transforma o número em ação. */
    const proposta = screen.getByRole('link', { name: /Proposta/ });
    expect(proposta).toHaveAttribute('href', '/carteira?estagio=PROPOSTA');
  });

  it('falha nas safras não derruba o funil', async () => {
    crm.safras.mockRejectedValue(new Error('timeout'));
    render(<FunilPage />);

    expect(await screen.findByText('500')).toBeInTheDocument();
    expect(screen.queryByText(/timeout/)).not.toBeInTheDocument();
  });

  it('falha no funil é dita, e não vira tela vazia', async () => {
    crm.funil.mockRejectedValue(new Error('assinatura suspensa'));
    render(<FunilPage />);

    expect(await screen.findByText(/assinatura suspensa/)).toBeInTheDocument();
  });

  it('enquanto o lote NÃO RESOLVEU, nada é pedido', async () => {
    /* O caso mocka `carregando: true` — e é ISSO que a guarda lê. Antes ele
       também mockava `lote: null` junto, então passava com as duas
       implementações e não distinguia uma da outra. */
    useLote.mockReturnValue({ lote: LOTE, definir: vi.fn(), catalogo: [], carregando: true, query: '' });
    render(<FunilPage />);

    await waitFor(() => expect(crm.funil).not.toHaveBeenCalled());
    expect(crm.safras).not.toHaveBeenCalled();
  });

  it('⚠ resolvido SEM lote — o estado permanente do cliente — o funil É pedido', async () => {
    /**
     * O caso que faltava, e o defeito que ele tranca.
     *
     * `lote === null` significa duas coisas opostas: "ainda não resolveu" e
     * "resolveu para SEM RECORTE". A segunda é o estado FINAL de todo
     * assinante — `lib/lote.tsx` só define padrão no ramo `!ehCliente`, e o
     * comentário de lá chama isso de conserto.
     *
     * Com a guarda antiga (`if (!lote) return`), `carregar` voltava na primeira
     * linha PARA SEMPRE: o cliente clicava em Funil, via cinco esqueletos e
     * nunca mais nada. E /funil está no menu de "todos".
     *
     * As três rotas já aceitavam lote opcional — a API estava pronta desde
     * sempre; o front é que nunca perguntava.
     */
    useLote.mockReturnValue({ lote: null, definir: vi.fn(), catalogo: [], carregando: false, query: '' });
    render(<FunilPage />);

    await waitFor(() => expect(crm.funil).toHaveBeenCalledWith(undefined));
    expect(crm.safras).toHaveBeenCalledWith(undefined);
    /* E o conteúdo aparece, em vez do esqueleto eterno. */
    expect(await screen.findByText('500')).toBeInTheDocument();
  });

  it('sem parâmetro na URL, a vista padrão é o QUADRO — o pedido do dono', () => {
    navegacao.busca = '';
    render(<FunilPage />);

    /* O seletor existe e o quadro está apertado; as métricas continuam a um
       clique. Não se afirma nada sobre o conteúdo do quadro aqui — ele tem
       suíte própria e, neste teste, a fila fica em carregamento eterno. */
    expect(screen.getByRole('button', { name: 'Quadro' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Métricas' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByText('Na carteira')).not.toBeInTheDocument();
  });

  it('os motivos de perda aparecem escritos, com o processo', async () => {
    crm.perdas.mockResolvedValue([
      {
        processoId: 'p1',
        numeroPrecatorio: '0000123-45.2025.4.05.8300',
        motivo: 'titular já cedeu a outro escritório',
        quando: '2026-08-01T00:00:00.000Z',
      },
    ]);
    render(<FunilPage />);

    expect(await screen.findByText('titular já cedeu a outro escritório')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '0000123-45.2025.4.05.8300' })).toHaveAttribute(
      'href',
      '/processo/p1',
    );
  });
});
