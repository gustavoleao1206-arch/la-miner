import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ItemFila, PaginaFila, ResumoPrePrecatorios } from '@/lib/api';

/**
 * O MÓDULO DE PRÉ-PRECATÓRIOS — a tela redesenhada em 18/09/2026.
 *
 * Até então era uma tabela sem resumo e sem recorte. O que este arquivo tranca
 * é o contrato novo: a faixa de resumo em cima, os chips com contagem, a busca
 * com debounce, e a regra de que os CHIPS recortam a lista sem recortar a
 * contagem — o mesmo "chip e lista nascem do mesmo código" da carteira.
 */

const { prePrecatorios, resumoPrePrecatorios, useLote, useUsuario } = vi.hoisted(() => ({
  prePrecatorios: vi.fn(),
  resumoPrePrecatorios: vi.fn(),
  useLote: vi.fn(),
  useUsuario: vi.fn(),
}));

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, prePrecatorios, resumoPrePrecatorios };
});

vi.mock('@/lib/lote', async (original) => {
  const real = await original<typeof import('@/lib/lote')>();
  return { ...real, useLote };
});

vi.mock('@/lib/usuario', () => ({ useUsuario }));

import PrePrecatoriosPage from '@/app/(painel)/pre-precatorios/page';

const INTERNO = { usuario: null, ehCliente: false, podeGerirEquipe: true, podeDarBaixa: true, carregado: true };
const ASSINANTE = { ...INTERNO, ehCliente: true, podeGerirEquipe: false, podeDarBaixa: false };

function item(over: Partial<ItemFila> = {}): ItemFila {
  return {
    id: 'p1',
    numeroPrecatorio: '5001111-11.2026.8.13.0024',
    entidadeDevedora: 'ESTADO DE MINAS GERAIS',
    situacao: null,
    valor: null,
    fase: 'CALCULOS_HOMOLOGADOS',
    valorIndicativo: '1234567.00',
    tribunal: 'TJMG',
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
  return { total: 1, pagina: 1, porPagina: 50, totalPaginas: 1, itens: [item()], ...over };
}

function resumo(over: Partial<ResumoPrePrecatorios> = {}): ResumoPrePrecatorios {
  return {
    total: 3204,
    valorIndicativo: '16400000000',
    comValorIndicativo: 2900,
    tribunais: 42,
    porFase: [
      { fase: 'CALCULOS_HOMOLOGADOS', quantidade: 1900 },
      { fase: 'TRANSITO_EM_JULGADO', quantidade: 1000 },
      { fase: 'REQUISITORIO_EXPEDIDO', quantidade: 304 },
    ],
    porEsfera: [
      { esfera: 'ESTADUAL', quantidade: 2000 },
      { esfera: 'TRABALHISTA', quantidade: 1204 },
    ],
    porConferencia: [
      { conferencia: 'CONFERE', quantidade: 2500 },
      { conferencia: 'DIVERGE', quantidade: 392 },
      { conferencia: 'NAO_CONFERIDO', quantidade: 312 },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  /* O `Contador` consulta `prefers-reduced-motion`, que o jsdom não implementa.
     Com "reduzir movimento" ligado ele vai DIRETO ao valor final — o que o
     teste quer, e o que um leitor de tela também prefere. */
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    /* O framer-motion (do cartão `Kpi`) registra ouvinte na mesma media query. */
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  useLote.mockReturnValue({
    lote: null,
    definir: vi.fn(),
    catalogo: [
      {
        sigla: 'TJMG',
        nome: 'Tribunal de Justiça de Minas Gerais',
        esfera: 'ESTADUAL',
        ufsJurisdicao: ['MG'],
        exercicios: [],
        processos: 1,
      },
    ],
    carregando: false,
    query: '',
  });
  useUsuario.mockReturnValue(INTERNO);
  prePrecatorios.mockResolvedValue(pagina());
  resumoPrePrecatorios.mockResolvedValue(resumo());
});

describe('Pré-precatórios — o que a tela mostra', () => {
  it('a faixa de resumo responde "o que chegou" antes da lista', async () => {
    render(<PrePrecatoriosPage />);

    expect(await screen.findByText('3.204')).toBeInTheDocument();
    expect(screen.getByText('em 42 tribunais')).toBeInTheDocument();
    /* Soma indicativa compacta, com o til: a dúvida viaja junto do número. */
    expect(screen.getByText('~R$ 16,4 bi')).toBeInTheDocument();
  });

  it('⚠ não há cartão de CPF no topo — nem para a operação interna', async () => {
    /* O dono tirou em 18/09/2026: "719 a conferir" em destaque lê-se como
       defeito do produto. O agregado de CPF sobrevive só como FILTRO interno. */
    render(<PrePrecatoriosPage />);
    await screen.findByText('3.204');

    expect(screen.queryByText(/divergem/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sem conferência/)).not.toBeInTheDocument();
    /* O que ocupa o lugar são as duas quebras, que também filtram. */
    expect(screen.getByRole('region', { name: 'Por estágio' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Por justiça' })).toBeInTheDocument();
  });

  it('⚠ o ASSINANTE não vê o filtro de CPF; a operação interna vê', async () => {
    useUsuario.mockReturnValue(ASSINANTE);
    /* É o que o servidor manda a ele: sem a chave `porConferencia`. */
    const { porConferencia: _semIsto, ...doCliente } = resumo();
    resumoPrePrecatorios.mockResolvedValue(doCliente);
    const { unmount } = render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    expect(screen.queryByRole('button', { name: /CPF confere/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CPF a conferir/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /CPF não conferido/ })).not.toBeInTheDocument();
    /* O resto do topo é igual para os dois. */
    expect(screen.getByRole('button', { name: /Estadual/ })).toBeInTheDocument();
    unmount();

    useUsuario.mockReturnValue(INTERNO);
    resumoPrePrecatorios.mockResolvedValue(resumo());
    render(<PrePrecatoriosPage />);
    expect(await screen.findByRole('button', { name: /CPF a conferir/ })).toBeInTheDocument();
  });

  it('antes de saber QUEM é o usuário, o filtro de CPF não aparece', async () => {
    /* O padrão do contexto é "não é cliente"; sem olhar `carregado`, o filtro
       piscaria na tela do assinante até o usuário resolver. */
    useUsuario.mockReturnValue({ ...INTERNO, carregado: false });
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    expect(screen.queryByRole('button', { name: /CPF confere/ })).not.toBeInTheDocument();
  });

  it('a linha tem número, tribunal resolvido pelo catálogo, titular, selo e valor compacto', async () => {
    render(<PrePrecatoriosPage />);

    const numero = await screen.findByText('5001111-11.2026.8.13.0024');
    const linha = numero.closest('a')!;
    expect(linha).toHaveAttribute('href', '/processo/p1');

    /* A sigla é o texto; o nome inteiro e a esfera vão no title — a cor do
       ponto nunca é o único canal. */
    const tribunal = within(linha).getByText('TJMG');
    expect(tribunal).toHaveAttribute(
      'title',
      'Tribunal de Justiça de Minas Gerais · Justiça Estadual',
    );
    expect(within(linha).getByText('ESTADO DE MINAS GERAIS')).toBeInTheDocument();
    expect(within(linha).getByText('MARIA DE SOUZA')).toBeInTheDocument();
    /* ⚠ O veredito do CPF NÃO aparece mais na linha — removido em 20/09/2026 de
       todas as telas, inclusive as internas. Este titular é DIVERGE na fixture,
       então é o caso que pegaria uma volta acidental do selo. */
    expect(within(linha).queryByText('CPF a conferir')).not.toBeInTheDocument();
    expect(within(linha).queryByText('CPF não conferido')).not.toBeInTheDocument();
    expect(within(linha).getByText('Cálculos homologados')).toBeInTheDocument();
    expect(within(linha).getByText(/~R\$ 1,2 mi/)).toBeInTheDocument();
    expect(within(linha).getByText('Novo')).toBeInTheDocument();
  });

  it('sem valor no texto, a linha DIZ isso em vez de deixar a célula vazia', async () => {
    prePrecatorios.mockResolvedValue(pagina({ itens: [item({ valorIndicativo: null })] }));
    render(<PrePrecatoriosPage />);

    await screen.findByText('5001111-11.2026.8.13.0024');
    expect(screen.getByText('sem valor no texto')).toBeInTheDocument();
  });

  it('os chips trazem a contagem do resumo — inclusive zero para a fase que não veio', async () => {
    render(<PrePrecatoriosPage />);

    const homologados = await screen.findByRole('button', { name: /Cálculos homologados/ });
    expect(within(homologados).getByText('1.900')).toBeInTheDocument();
    /* PRECATORIO_AUTUADO não está no agrupamento: depois de o resumo chegar,
       isso é zero de verdade, não "não sei". */
    const autuados = screen.getByRole('button', { name: /Precatório autuado/ });
    expect(within(autuados).getByText('0')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /Estadual/ })).getByText('2.000')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: /CPF não conferido/ })).getByText('312')).toBeInTheDocument();
  });
});

describe('Pré-precatórios — os chips recortam a lista, não a contagem', () => {
  it('clicar num estágio filtra a lista, volta à página 1 e desliga no segundo clique', async () => {
    const usuario = userEvent.setup();
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    const chip = screen.getByRole('button', { name: /Cálculos homologados/ });
    await usuario.click(chip);

    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith(
        expect.objectContaining({ fase: 'CALCULOS_HOMOLOGADOS', pagina: 1 }),
      ),
    );
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    await usuario.click(chip);
    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith(expect.objectContaining({ fase: undefined })),
    );
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('esfera e veredito do CPF vão para a lista como `esfera` e `conferencia`', async () => {
    const usuario = userEvent.setup();
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    await usuario.click(screen.getByRole('button', { name: /Trabalhista/ }));
    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith(
        expect.objectContaining({ esfera: 'TRABALHISTA' }),
      ),
    );

    await usuario.click(screen.getByRole('button', { name: /CPF a conferir/ }));
    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith(
        expect.objectContaining({ esfera: 'TRABALHISTA', conferencia: 'DIVERGE' }),
      ),
    );
  });

  it('⚠ nenhum chip chega ao resumo — clicar em um não pode zerar os outros', async () => {
    const usuario = userEvent.setup();
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    await usuario.click(screen.getByRole('button', { name: /Trabalhista/ }));
    await usuario.click(screen.getByRole('button', { name: /Cálculos homologados/ }));
    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith(
        expect.objectContaining({ esfera: 'TRABALHISTA', fase: 'CALCULOS_HOMOLOGADOS' }),
      ),
    );

    /* O resumo foi pedido UMA vez (na montagem) e sem nenhum dos três chips. */
    expect(resumoPrePrecatorios).toHaveBeenCalledTimes(1);
    const enviado = resumoPrePrecatorios.mock.calls[0][0] as Record<string, unknown>;
    expect(enviado).not.toHaveProperty('fase');
    expect(enviado).not.toHaveProperty('esfera');
    expect(enviado).not.toHaveProperty('conferencia');
  });

  it('a busca vai para a lista E para o resumo, depois do debounce', async () => {
    const usuario = userEvent.setup();
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    await usuario.type(screen.getByLabelText('Buscar pré-precatório'), 'MARIA');

    await waitFor(
      () =>
        expect(prePrecatorios).toHaveBeenLastCalledWith(
          expect.objectContaining({ termo: 'MARIA', pagina: 1 }),
        ),
      { timeout: 2000 },
    );
    /* O resumo segue a busca: os chips passam a contar o universo do termo. */
    await waitFor(() =>
      expect(resumoPrePrecatorios).toHaveBeenLastCalledWith({ termo: 'MARIA' }),
    );
  });

  it('"Limpar" aparece com filtro ligado e volta ao estado inicial', async () => {
    const usuario = userEvent.setup();
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');
    expect(screen.queryByRole('button', { name: /Limpar/ })).not.toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: /Estadual/ }));
    await usuario.click(await screen.findByRole('button', { name: /Limpar/ }));

    await waitFor(() =>
      expect(prePrecatorios).toHaveBeenLastCalledWith({ pagina: 1, porPagina: 50 }),
    );
  });
});

describe('Pré-precatórios — estados', () => {
  it('o resumo falhando NÃO derruba a lista: os chips ficam sem número', async () => {
    resumoPrePrecatorios.mockRejectedValue(new Error('agregado indisponível'));
    render(<PrePrecatoriosPage />);

    expect(await screen.findByText('5001111-11.2026.8.13.0024')).toBeInTheDocument();
    expect(screen.getByText(/agregado indisponível/)).toBeInTheDocument();
    const chip = screen.getByRole('button', { name: /Cálculos homologados/ });
    expect(within(chip).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('vazio com filtro ligado explica e oferece limpar', async () => {
    const usuario = userEvent.setup();
    prePrecatorios.mockResolvedValueOnce(pagina());
    render(<PrePrecatoriosPage />);
    await screen.findByText('5001111-11.2026.8.13.0024');

    prePrecatorios.mockResolvedValue(pagina({ total: 0, totalPaginas: 1, itens: [] }));
    await usuario.click(screen.getByRole('button', { name: /Federal/ }));

    expect(await screen.findByText('Nenhum pré-precatório')).toBeInTheDocument();
    expect(screen.getByText(/limpe os filtros/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeInTheDocument();
  });

  it('a lista falhando mostra o erro, e não uma lista vazia', async () => {
    prePrecatorios.mockRejectedValue(new Error('500 do servidor'));
    render(<PrePrecatoriosPage />);

    expect(await screen.findByText(/500 do servidor/)).toBeInTheDocument();
    expect(screen.queryByText('Nenhum pré-precatório')).not.toBeInTheDocument();
  });
});
