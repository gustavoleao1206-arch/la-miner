import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Funil, ItemFila, PaginaFila } from '@/lib/api';

/**
 * A FILA DE TRABALHO — rede de segurança, escrita ANTES de mexer no arquivo.
 *
 * `app/(painel)/carteira/page.tsx` tem 700+ linhas e nenhum teste. As próximas
 * etapas (contagem nos chips, quadro arrastável) mexem justamente nele, em duas
 * frentes ao mesmo tempo. Refatorar assim, às cegas, é a receita da regressão
 * que só aparece no navegador — e no navegador ninguém repete os oito casos
 * abaixo a cada mudança.
 *
 * O que este arquivo tranca é o COMPORTAMENTO DE HOJE, não o desejado: se uma
 * etapa futura mudar de propósito algo daqui, o teste tem de ser reescrito com
 * a justificativa junto. É essa fricção que se está comprando.
 */

const { crm, filaDeTrabalho, useLote, parametros } = vi.hoisted(() => ({
  /* Todo método que a tela chama AO MONTAR precisa existir no dublê. Faltar um
     não dá erro de tipo: dá "crm.X is not a function" em runtime, no navegador
     — foi assim que a página do processo quebrou para todo cliente (B1). */
  crm: {
    equipe: vi.fn(),
    listarEtiquetas: vi.fn(),
    acaoEmLote: vi.fn(),
    funil: vi.fn(),
  },
  filaDeTrabalho: vi.fn(),
  parametros: new URLSearchParams(),
  useLote: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, crm, filaDeTrabalho };
});

/* `useSearchParams` devolve null fora do roteador do Next: sem este dublê a
   tela quebra logo na montagem, e não por culpa dela. */
vi.mock('next/navigation', () => ({ useSearchParams: () => parametros }));

vi.mock('@/lib/lote', async (original) => {
  const real = await original<typeof import('@/lib/lote')>();
  return { ...real, useLote };
});

import CarteiraPage from '@/app/(painel)/carteira/page';

const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

function item(over: Partial<ItemFila> = {}): ItemFila {
  return {
    id: 'p1',
    numeroPrecatorio: '0000123-45.2025.4.05.8300',
    entidadeDevedora: 'INSS',
    situacao: null,
    valor: '150000.00',
    /* O padrão da base inteira até 04/09/2026 — precatório na fila
       orçamentária. Os casos escritos antes da coluna de fase falam desse
       estágio sem nunca ter precisado dizer. */
    fase: 'PRECATORIO_EXPEDIDO' as const,
    valorIndicativo: null,
    tribunal: 'TRF5',
    titular: { id: 't1', nome: 'MARIA DE SOUZA', cpf: '39053344705' },
    estagio: 'NOVO',
    estagioEm: null,
    prioridade: 'NORMAL',
    responsavel: null,
    ultimoContatoEm: null,
    etiquetas: [],
    tarefasAbertas: 0,
    tarefasAtrasadas: 0,
    ...over,
  };
}

function pagina(over: Partial<PaginaFila> = {}): PaginaFila {
  return { total: 1, pagina: 1, porPagina: 25, totalPaginas: 1, itens: [item()], ...over };
}

/** O último conjunto de filtros com que a tela consultou o servidor. */
const ultimosFiltros = () => filaDeTrabalho.mock.calls.at(-1)?.[0] ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  useLote.mockReturnValue({ lote: LOTE, definir: vi.fn(), catalogo: [], carregando: false, query: '' });
  crm.equipe.mockResolvedValue([{ id: 'u1', nome: 'Ana', papel: 'CLIENTE' }]);
  crm.listarEtiquetas.mockResolvedValue([{ id: 'e1', nome: 'Sem retorno', cor: 'muted' }]);
  crm.acaoEmLote.mockResolvedValue({ pedidos: 1, aplicados: 1, alterados: 1, ignorados: 0 });
  crm.funil.mockResolvedValue(funil());
  filaDeTrabalho.mockResolvedValue(pagina());
});

function funil(over: Partial<Funil> = {}): Funil {
  return {
    total: 317,
    NOVO: 271,
    EM_CONTATO: 22,
    PROPOSTA: 10,
    FECHADO: 10,
    PERDIDO: 4,
    semContato: 274,
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

describe('Fila de trabalho', () => {
  it('lista o processo com o CPF PARCIAL, nunca inteiro', async () => {
    render(<CarteiraPage />);

    expect(await screen.findByText('0000123-45.2025.4.05.8300')).toBeInTheDocument();
    expect(screen.getByText('MARIA DE SOUZA')).toBeInTheDocument();

    /* O CPF completo não pode aparecer numa LISTA: a tela mostra dezenas de
       titulares de uma vez, e a rota da fila não grava trilha de acesso. */
    expect(document.body.textContent).not.toContain('39053344705');
    expect(screen.getByText(/\*\*\*\.533\.447-\*\*/)).toBeInTheDocument();
  });

  it('o lote em foco vai junto na consulta', async () => {
    render(<CarteiraPage />);
    await waitFor(() => expect(filaDeTrabalho).toHaveBeenCalled());

    /* Sem o lote, a lista mostraria um tribunal e os totais falariam de outro —
       é o defeito que já apareceu uma vez ("o funil dizia 500 e a fila, 183"). */
    expect(filaDeTrabalho.mock.calls.at(-1)?.[1]).toEqual(LOTE);
  });

  it('o chip de estágio filtra, e clicar de novo desliga', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getByRole('button', { name: /^Em contato/ }));
    await waitFor(() => expect(ultimosFiltros().estagio).toBe('EM_CONTATO'));

    await u.click(screen.getByRole('button', { name: /^Em contato/ }));
    await waitFor(() => expect(ultimosFiltros().estagio).toBeUndefined());
  });

  it('"sem contato" e "tarefa atrasada" são independentes e acumulam', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getByRole('button', { name: /Sem contato/ }));
    await waitFor(() => expect(ultimosFiltros().semContato).toBe(true));

    await u.click(screen.getByRole('button', { name: /Tarefa atrasada/ }));
    await waitFor(() => expect(ultimosFiltros().tarefaAtrasada).toBe(true));
    /* O segundo não pode apagar o primeiro: são perguntas diferentes sobre a
       mesma carteira, e quem liga os dois quer a interseção. */
    expect(ultimosFiltros().semContato).toBe(true);
  });

  it('filtrar volta para a página 1', async () => {
    const u = userEvent.setup();
    /* `pagina: 1` na RESPOSTA, e não no pedido: a paginação da tela conta a
       partir do que o servidor diz que devolveu, não do estado local. */
    filaDeTrabalho.mockResolvedValue(pagina({ total: 300, totalPaginas: 12, pagina: 1 }));
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(ultimosFiltros().pagina).toBe(2));

    /* Estreitar o filtro estando na página 4 costuma devolver lista vazia — a
       tela parece quebrada quando só acabou o resultado naquela página. */
    await u.click(screen.getByRole('button', { name: /^Proposta/ }));
    await waitFor(() => expect(ultimosFiltros().pagina).toBe(1));
  });

  it('a seleção morre quando a consulta muda', async () => {
    const u = userEvent.setup();
    filaDeTrabalho.mockResolvedValue(pagina({ itens: [item(), item({ id: 'p2' })], total: 2 }));
    render(<CarteiraPage />);
    await screen.findAllByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getAllByRole('checkbox')[1]);
    expect(await screen.findByText(/1 selecionado/)).toBeInTheDocument();

    /* Manter a seleção seria pior do que parece: os ids continuariam marcados
       FORA da tela, e a ação em massa atingiria o que ninguém está vendo. */
    await u.click(screen.getByRole('button', { name: /^Perdidos/ }));
    await waitFor(() => expect(screen.queryByText(/selecionado/)).not.toBeInTheDocument());
  });

  it('a ação em massa só dispara no BOTÃO, nunca ao escolher no seletor', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getAllByRole('checkbox')[1]);
    const barra = (await screen.findByText(/1 selecionado/)).closest('div')!;

    await u.selectOptions(within(barra).getByLabelText(/funil/i), 'PERDIDO');
    /* Mudar 200 processos é a operação mais destrutiva desta tela. Aplicar no
       `onChange` faria um clique errado no seletor gravar tudo. */
    expect(crm.acaoEmLote).not.toHaveBeenCalled();

    await u.click(screen.getByRole('button', { name: /Aplicar aos 1/ }));
    await waitFor(() => expect(crm.acaoEmLote).toHaveBeenCalledTimes(1));
    expect(crm.acaoEmLote.mock.calls[0][0]).toMatchObject({
      processoIds: ['p1'],
      estagio: 'PERDIDO',
    });
  });

  it('os chips mostram a contagem e continuam filtrando', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    /* O número vai DENTRO do chip: filtrar às cegas era clicar em "Proposta"
       só para descobrir se havia alguma. */
    const proposta = await screen.findByRole('button', { name: /^Proposta\s*10$/ });
    expect(await screen.findByRole('button', { name: /^Novos\s*271$/ })).toBeInTheDocument();

    await u.click(proposta);
    await waitFor(() => expect(ultimosFiltros().estagio).toBe('PROPOSTA'));
  });

  it('o estágio clicado NÃO vai para a contagem', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getByRole('button', { name: /^Perdidos/ }));
    await waitFor(() => expect(ultimosFiltros().estagio).toBe('PERDIDO'));

    /* Se o estágio fosse junto, os outros quatro chips iriam a zero no instante
       do clique e o operador perderia a referência de onde está. */
    const enviados = crm.funil.mock.calls.at(-1)?.[1] ?? {};
    expect(enviados.estagio).toBeUndefined();
  });

  it('sem lote resolvido, nenhuma contagem é pedida nem mostrada', async () => {
    /**
     * A trava contra o defeito histórico: sem lote, o funil contaria a carteira
     * inteira enquanto a fila cai no lote padrão — "o funil dizia 500 e a fila,
     * 183". Ausência de número é honesta; um número errado, não.
     */
    useLote.mockReturnValue({ lote: null, definir: vi.fn(), catalogo: [], carregando: true, query: '' });
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    expect(crm.funil).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Novos/ })).toBeInTheDocument();
    expect(screen.queryByText(/contagens do lote em foco/)).not.toBeInTheDocument();
  });

  it('falha na contagem NÃO derruba a fila', async () => {
    crm.funil.mockRejectedValue(new Error('timeout no agregado'));
    render(<CarteiraPage />);

    /* A contagem é acessório; a fila é o trabalho. */
    expect(await screen.findByText('0000123-45.2025.4.05.8300')).toBeInTheDocument();
    expect(screen.queryByText(/timeout no agregado/)).not.toBeInTheDocument();
  });

  it('a faixa de contagens mostra só números — nenhum nome, nenhum CPF', async () => {
    render(<CarteiraPage />);
    const faixa = (await screen.findByLabelText('Filtros da fila')).textContent ?? '';

    expect(faixa).toMatch(/Movimentaram nos últimos 30 dias/);
    /* A fila devolve CPF completo e NÃO grava trilha de acesso: qualquer nome ou
       documento nesta faixa seria exposição sem registro. */
    expect(faixa).not.toContain('MARIA DE SOUZA');
    expect(faixa).not.toContain('39053344705');
  });

  it('a linha de movimento some quando nada se moveu', async () => {
    /* "0 · 0 · 0" parece defeito, não informação. */
    crm.funil.mockResolvedValue(
      funil({ movimento: { dias: 30, desde: '2026-07-12T00:00:00.000Z', NOVO: 0, EM_CONTATO: 0, PROPOSTA: 0, FECHADO: 0, PERDIDO: 0 } }),
    );
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    expect(screen.queryByText(/Movimentaram/)).not.toBeInTheDocument();
  });

  it('o campo de motivo só aparece quando o destino é Perdido', async () => {
    const u = userEvent.setup();
    render(<CarteiraPage />);
    await screen.findByText('0000123-45.2025.4.05.8300');

    await u.click(screen.getAllByRole('checkbox')[1]);
    await screen.findByText(/1 selecionado/);

    /* Re-consulta a cada passo: o elemento é recriado no re-render, e guardar a
       referência faz o segundo `selectOptions` agir sobre um nó fora da tela. */
    await u.selectOptions(screen.getByLabelText('Mover no funil'), 'PROPOSTA');
    expect(screen.queryByLabelText('Motivo da perda')).not.toBeInTheDocument();

    await u.selectOptions(screen.getByLabelText('Mover no funil'), 'PERDIDO');
    const motivo = await screen.findByLabelText('Motivo da perda');
    await u.type(motivo, 'lote sem telefone válido');

    await u.click(screen.getByRole('button', { name: /Aplicar aos 1/ }));
    await waitFor(() => expect(crm.acaoEmLote).toHaveBeenCalled());
    expect(crm.acaoEmLote.mock.calls[0][0]).toMatchObject({
      estagio: 'PERDIDO',
      motivoPerda: 'lote sem telefone válido',
    });
  });

  it('o estágio pedido na URL já entra filtrado', async () => {
    /* É o que faz o clique na tela do sócio ("Proposta: 16") cair na lista
       certa. Sem isto o link levaria à fila inteira, e a pessoa refaria à mão o
       filtro que acabou de clicar. */
    parametros.set('estagio', 'PROPOSTA');
    try {
      render(<CarteiraPage />);
      await waitFor(() => expect(ultimosFiltros().estagio).toBe('PROPOSTA'));
      expect(await screen.findByRole('button', { name: /^Proposta/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      parametros.delete('estagio');
    }
  });

  it('estágio inventado na URL é ignorado, não quebra a tela', async () => {
    /* A URL é escrita por qualquer um. `?estagio=xpto` chegaria ao servidor e
       voltaria 400, deixando a fila em erro por causa de um endereço colado
       errado. */
    parametros.set('estagio', 'XPTO');
    try {
      render(<CarteiraPage />);
      expect(await screen.findByText('0000123-45.2025.4.05.8300')).toBeInTheDocument();
      expect(ultimosFiltros().estagio).toBeUndefined();
    } finally {
      parametros.delete('estagio');
    }
  });

  it('erro na fila é explicado, e não vira esqueleto eterno', async () => {
    filaDeTrabalho.mockRejectedValue(new Error('assinatura suspensa'));
    render(<CarteiraPage />);

    expect(await screen.findByText(/assinatura suspensa/)).toBeInTheDocument();
  });

  it('carteira vazia diz por quê: sem filtro é uma coisa, com filtro é outra', async () => {
    const u = userEvent.setup();
    filaDeTrabalho.mockResolvedValue(pagina({ itens: [], total: 0, totalPaginas: 0 }));
    render(<CarteiraPage />);

    expect(await screen.findByText(/Carteira vazia/)).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: /^Novos/ }));
    /* "Nada aqui" sobre uma carteira cheia manda o operador procurar defeito
       onde só há filtro ligado. */
    expect(await screen.findByText(/Nada com esses filtros/)).toBeInTheDocument();
  });
});
