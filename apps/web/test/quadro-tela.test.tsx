import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Funil, ItemFila, PaginaFila } from '@/lib/api';

/**
 * O QUADRO, pelo MENU.
 *
 * O arraste da etapa seguinte chama exatamente o mesmo caminho — `aoMover` →
 * `decidirMovimento` → `mover`. Testar pelo menu cobre TODA a lógica do arraste
 * menos a física do ponteiro, que é justamente o que o ambiente de teste não
 * sabe simular e o que a conferência no navegador consegue ver.
 */

const { crm, filaDeTrabalho } = vi.hoisted(() => ({
  crm: { definirEstagio: vi.fn() },
  filaDeTrabalho: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, crm, filaDeTrabalho };
});

import { Quadro } from '@/components/carteira/quadro';

const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

function item(id: string, over: Partial<ItemFila> = {}): ItemFila {
  return {
    id,
    numeroPrecatorio: `000${id}-45.2025.4.05.8300`,
    entidadeDevedora: 'INSS',
    situacao: null,
    valor: '150000.00',
    /* O padrão da base inteira até 04/09/2026 — precatório na fila
       orçamentária. Os casos escritos antes da coluna de fase falam desse
       estágio sem nunca ter precisado dizer. */
    fase: 'PRECATORIO_EXPEDIDO' as const,
    valorIndicativo: null,
    tribunal: 'TRF5',
    titular: { id: `t${id}`, nome: 'MARIA DE SOUZA', cpf: '39053344705' },
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

/** O servidor devolve UMA página por coluna — cinco chamadas, uma por estágio. */
function respostaPorEstagio(porEstagio: Partial<Record<string, PaginaFila>>) {
  filaDeTrabalho.mockImplementation((f: { estagio?: string }) =>
    Promise.resolve(
      porEstagio[f.estagio ?? ''] ?? {
        total: 0,
        pagina: 1,
        porPagina: 50,
        totalPaginas: 0,
        itens: [],
      },
    ),
  );
}

const funil: Funil = {
  total: 3050,
  NOVO: 3000,
  EM_CONTATO: 30,
  PROPOSTA: 12,
  FECHADO: 5,
  PERDIDO: 3,
  semContato: 3000,
  movimento: { dias: 30, desde: '2026-07-12T00:00:00.000Z', NOVO: 0, EM_CONTATO: 4, PROPOSTA: 2, FECHADO: 1, PERDIDO: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  crm.definirEstagio.mockResolvedValue({ estagio: 'EM_CONTATO', alterado: true });
  respostaPorEstagio({
    NOVO: { total: 3000, pagina: 1, porPagina: 50, totalPaginas: 60, itens: [item('1'), item('2')] },
  });
});

/* `carregando: false` é o estado sob teste: a resolução TERMINOU. Com `true`
   o quadro nem pede — e é justamente essa distinção que o conserto introduziu. */
const props = {
  filtros: { pagina: 1, porPagina: 25 },
  lote: LOTE,
  carregando: false,
  funil,
  aoMudarFunil: vi.fn(),
};

describe('Quadro', () => {
  it('o cabeçalho da coluna mostra o total do SERVIDOR, não os cartões carregados', async () => {
    /**
     * A coluna "Novos" de um cliente grande tem 3.000 processos e a tela carrega
     * 50. Um cabeçalho que contasse os cartões diria "50", e o escritório
     * concluiria que perdeu 2.950.
     */
    render(<Quadro {...props} />);

    const coluna = await screen.findByLabelText('Novos');
    expect(within(coluna).getByText('3.000')).toBeInTheDocument();
    /* E a coluna DIZ que está mostrando uma parte. */
    expect(within(coluna).getByText(/mostrando 2 de 3.000/)).toBeInTheDocument();
  });

  it('mover para um estágio não terminal grava direto, sem perguntar', async () => {
    const u = userEvent.setup();
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'EM_CONTATO');

    await waitFor(() => expect(crm.definirEstagio).toHaveBeenCalledTimes(1));
    expect(crm.definirEstagio.mock.calls[0]).toEqual(['1', 'EM_CONTATO', undefined]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('o cartão muda de coluna na hora, antes da resposta do servidor', async () => {
    const u = userEvent.setup();
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'PROPOSTA');

    await waitFor(() => {
      const proposta = screen.getByLabelText('Proposta');
      expect(within(proposta).getByText('0001-45.2025.4.05.8300')).toBeInTheDocument();
    });
    const novos = screen.getByLabelText('Novos');
    expect(within(novos).queryByText('0001-45.2025.4.05.8300')).not.toBeInTheDocument();
  });

  it('FECHADO e PERDIDO pedem confirmação ANTES de gravar', async () => {
    /* O servidor aceita qualquer pulo sem validar, e escreve uma linha
       permanente na timeline. */
    const u = userEvent.setup();
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'FECHADO');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(crm.definirEstagio).not.toHaveBeenCalled();
  });

  it('cancelar a confirmação não move nem grava', async () => {
    const u = userEvent.setup();
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'PERDIDO');
    await u.click(await screen.findByRole('button', { name: 'Cancelar' }));

    expect(crm.definirEstagio).not.toHaveBeenCalled();
    const novos = screen.getByLabelText('Novos');
    expect(within(novos).getByText('0001-45.2025.4.05.8300')).toBeInTheDocument();
  });

  it('só PERDIDO pede o motivo, e ele viaja junto', async () => {
    const u = userEvent.setup();
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'FECHADO');
    expect(screen.queryByLabelText('Motivo da perda')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Cancelar' }));

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'PERDIDO');
    await u.type(await screen.findByLabelText('Motivo da perda'), 'já cedeu a outro');
    await u.click(screen.getByRole('button', { name: /Confirmar/ }));

    await waitFor(() => expect(crm.definirEstagio).toHaveBeenCalled());
    expect(crm.definirEstagio.mock.calls[0]).toEqual(['1', 'PERDIDO', 'já cedeu a outro']);
  });

  it('erro do servidor devolve o cartão para a coluna de origem', async () => {
    const u = userEvent.setup();
    crm.definirEstagio.mockRejectedValue(new Error('assinatura suspensa'));
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'EM_CONTATO');

    /* O cartão volta E o motivo aparece: some sem explicação seria pior que não
       ter movido. */
    expect(await screen.findByText(/assinatura suspensa/)).toBeInTheDocument();
    const novos = screen.getByLabelText('Novos');
    expect(within(novos).getByText('0001-45.2025.4.05.8300')).toBeInTheDocument();
  });

  it('404 REMOVE o cartão em vez de devolvê-lo', async () => {
    /**
     * 404 significa que o processo não está mais na carteira desta organização.
     * Devolvê-lo à coluna de origem reafirmaria na tela o que o servidor acabou
     * de negar — e o próximo clique daria 404 de novo.
     */
    const u = userEvent.setup();
    crm.definirEstagio.mockRejectedValue(Object.assign(new Error('Processo não encontrado'), { status: 404 }));
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    await u.selectOptions(screen.getByLabelText(/Mover 0001-45/), 'EM_CONTATO');

    expect(await screen.findByText(/não está mais na sua carteira/)).toBeInTheDocument();
    expect(screen.queryByText('0001-45.2025.4.05.8300')).not.toBeInTheDocument();
  });

  it('enquanto o lote NÃO RESOLVEU, nenhuma coluna é pedida', async () => {
    /* As cinco colunas cairiam no lote padrão enquanto o cabeçalho contaria a
       carteira inteira — o "chip diz 500 sobre uma lista de 183". É transitório,
       e só para a operação interna. */
    render(<Quadro {...props} carregando />);
    await waitFor(() => expect(filaDeTrabalho).not.toHaveBeenCalled());
  });

  it('⚠ resolvido SEM lote — o cliente — as colunas SÃO pedidas, sem recorte', async () => {
    /**
     * O par que separa os dois significados de `lote === null`.
     *
     * Para o CLIENTE ele é o estado FINAL: `lib/lote.tsx` só define padrão no
     * ramo `!ehCliente`. Com a guarda antiga (`if (!lote) return`), o quadro —
     * que é a vista PADRÃO do Funil e da Carteira — pintava cinco esqueletos
     * para sempre, e /funil está no menu de "todos".
     *
     * E o recorte tem de sair `undefined`, não `null`: é assim que a fila da
     * lista já pede (`lote ?? undefined`), e é o que faz as duas contarem o
     * MESMO universo.
     */
    render(<Quadro {...props} lote={null} />);

    await waitFor(() => expect(filaDeTrabalho).toHaveBeenCalled());
    expect(filaDeTrabalho.mock.calls).toHaveLength(5);
    for (const chamada of filaDeTrabalho.mock.calls) {
      expect(chamada[1]).toBeUndefined();
    }
  });

  it('cada coluna pede o SEU estágio, e 50 cartões', async () => {
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    const pedidos = filaDeTrabalho.mock.calls.map((c) => c[0]);
    expect(pedidos).toHaveLength(5);
    expect(pedidos.map((p) => p.estagio)).toEqual([
      'NOVO',
      'EM_CONTATO',
      'PROPOSTA',
      'FECHADO',
      'PERDIDO',
    ]);
    expect(pedidos.every((p) => p.porPagina === 50)).toBe(true);
    /* O lote vai em todas: sem ele as colunas cairiam no padrão enquanto o
       cabeçalho conta outro recorte. */
    expect(filaDeTrabalho.mock.calls.every((c) => c[1] === LOTE)).toBe(true);
  });

  it('o cartão mostra o CPF? Não — nem parcial', async () => {
    /* O quadro mostra dezenas de cartões de uma vez e é feito para ficar aberto
       na tela o dia inteiro. Número de processo e nome bastam para reconhecer;
       quem precisa do documento abre o processo, e esse acesso fica na trilha. */
    render(<Quadro {...props} />);
    await screen.findByLabelText('Novos');

    expect(document.body.textContent).not.toContain('39053344705');
    expect(document.body.textContent).not.toContain('***.533.447-**');
  });
});
