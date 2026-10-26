import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Negociacao, Proposta } from '@/lib/api';

/**
 * A ABA DE NEGOCIAÇÃO — o único bloco da tela que fala de dinheiro do NEGÓCIO.
 *
 * Metade destes casos verifica o que ela NÃO faz: não mostra deságio sem base,
 * não deixa mandar quantia e percentual juntos, não confunde valor de face com
 * proposta. Um número errado aqui vira contrato assinado.
 */

const { negociacao } = vi.hoisted(() => ({
  negociacao: {
    resumo: vi.fn(),
    criar: vi.fn(),
    ajustar: vi.fn(),
    enviar: vi.fn(),
    decidir: vi.fn(),
    remover: vi.fn(),
    /* O cartão em destaque monta o cronograma junto. Sem estes, a aba inteira
       quebraria por chamar undefined — e o teste acusaria a tela errada. */
    cronograma: vi.fn(),
    gerarCronograma: vi.fn(),
    baixar: vi.fn(),
    desfazerBaixa: vi.fn(),
  },
}));

/* A calculadora do CNJ e chamada DIRETO do navegador (o gateway bloqueia IP
   estrangeiro e libera CORS — ver lib/calculadora-cnj.ts). Aqui ela vira duble:
   o contrato com o gateway real tem teste proprio, com o fetch dublado. */
const { calcularSaldoOficial } = vi.hoisted(() => ({ calcularSaldoOficial: vi.fn() }));
vi.mock('@/lib/calculadora-cnj', async (original) => {
  const real = await original<typeof import('@/lib/calculadora-cnj')>();
  return { ...real, calcularSaldoOficial };
});

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, negociacao };
});

import { NegociacaoProcesso } from '@/components/crm/negociacao-processo';

function proposta(over: Partial<Proposta> = {}): Proposta {
  return {
    id: 'p1',
    rodada: 1,
    origem: 'ESCRITORIO',
    modalidade: 'CESSAO',
    status: 'RASCUNHO',
    baseValor: '1000000.00',
    baseOrigem: 'PARTE_UNICA',
    valorProposto: '300000.00',
    honorarioPercentual: null,
    custasEstimadas: null,
    custasPorContaDe: 'ESCRITORIO',
    validaAte: null,
    observacao: null,
    enviadaEm: null,
    respondidaEm: null,
    encerradaEm: null,
    criadoEm: '2026-08-11T12:00:00.000Z',
    autor: { id: 'u1', nome: 'Ana' },
    desagioPercentual: '70',
    liquidoAoTitular: '300000.00',
    ...over,
  };
}

function resumo(over: Partial<Negociacao> = {}): Negociacao {
  return {
    baseAtual: '1000000.00',
    baseOrigemAtual: 'PARTE_UNICA',
    viva: null,
    aceita: null,
    rodadas: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  negociacao.resumo.mockResolvedValue(resumo());
  negociacao.criar.mockResolvedValue(proposta());
  negociacao.enviar.mockResolvedValue(proposta({ status: 'ENVIADA' }));
  negociacao.decidir.mockResolvedValue(proposta({ status: 'ACEITA' }));
  negociacao.remover.mockResolvedValue({ removida: true });
  negociacao.cronograma.mockResolvedValue({ total: '0.00', parcelas: [] });
});

describe('Negociação do processo', () => {
  it('sem proposta, explica que o valor mostrado NÃO é o do negócio', async () => {
    /* É a confusão mais cara possível nesta tela: valor de face é o que o ente
       público deve ao titular, não o que o escritório paga nem o que ganha. */
    render(<NegociacaoProcesso processoId="proc-1" />);

    expect(await screen.findByText(/Nenhuma proposta registrada/)).toBeInTheDocument();
    expect(screen.getByText(/não\s*o que o escritório paga nem o que ganha/)).toBeInTheDocument();
  });

  it('cessão manda quantia; honorários mandam percentual — nunca os dois', async () => {
    const u = userEvent.setup();
    render(<NegociacaoProcesso processoId="proc-1" />);
    await u.click(await screen.findByRole('button', { name: /Registrar proposta/ }));

    /* Na cessão o campo de percentual nem existe: mostrá-lo convidaria a
       preencher, e o servidor recusaria — depois de a pessoa ter digitado. */
    await u.type(screen.getByLabelText('Valor proposto'), '300000.00');
    expect(screen.queryByLabelText('Honorário percentual')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: /Salvar rascunho/ }));

    await waitFor(() => expect(negociacao.criar).toHaveBeenCalled());
    const enviado = negociacao.criar.mock.calls[0][1];
    expect(enviado).toMatchObject({ modalidade: 'CESSAO', valorProposto: '300000.00' });
    expect(enviado.honorarioPercentual).toBeUndefined();
  });

  it('trocar para honorários troca o campo, e o que viaja', async () => {
    const u = userEvent.setup();
    render(<NegociacaoProcesso processoId="proc-1" />);
    await u.click(await screen.findByRole('button', { name: /Registrar proposta/ }));

    await u.selectOptions(screen.getByLabelText('Modalidade'), 'HONORARIOS');
    expect(screen.queryByLabelText('Valor proposto')).not.toBeInTheDocument();

    await u.type(screen.getByLabelText('Honorário percentual'), '20.00');
    await u.click(screen.getByRole('button', { name: /Salvar rascunho/ }));

    await waitFor(() => expect(negociacao.criar).toHaveBeenCalled());
    const enviado = negociacao.criar.mock.calls[0][1];
    expect(enviado).toMatchObject({ modalidade: 'HONORARIOS', honorarioPercentual: '20.00' });
    expect(enviado.valorProposto).toBeUndefined();
  });

  it('a contraproposta do titular viaja como ORIGEM, não como observação', async () => {
    /* É o que faz o número do titular existir como DADO: numa observação, ele
       não soma em relatório nenhum. */
    const u = userEvent.setup();
    render(<NegociacaoProcesso processoId="proc-1" />);
    await u.click(await screen.findByRole('button', { name: /Registrar proposta/ }));

    await u.type(screen.getByLabelText('Valor proposto'), '400000.00');
    await u.click(screen.getByText(/Este número veio do titular/));
    await u.click(screen.getByRole('button', { name: /Salvar rascunho/ }));

    await waitFor(() => expect(negociacao.criar).toHaveBeenCalled());
    expect(negociacao.criar.mock.calls[0][1]).toMatchObject({ origem: 'TITULAR' });
  });

  it('deságio sem base vira travessão, e não 0%', async () => {
    /**
     * A diferença entre "não sei a margem" e "a margem é zero" muda a decisão de
     * quem lê. Um zero ali seria uma afirmação que o dado não sustenta.
     */
    negociacao.resumo.mockResolvedValue(
      resumo({
        viva: proposta({ baseValor: null, desagioPercentual: null }),
        rodadas: [proposta({ baseValor: null, desagioPercentual: null })],
      }),
    );
    render(<NegociacaoProcesso processoId="proc-1" />);

    const desagio = (await screen.findByText('Deságio')).parentElement!;
    expect(desagio.textContent).toContain('—');
    expect(desagio.textContent).not.toContain('0%');
  });

  it('o rascunho oferece APRESENTAR; a apresentada oferece aceitou/recusou', async () => {
    negociacao.resumo.mockResolvedValue(
      resumo({ viva: proposta(), rodadas: [proposta()] }),
    );
    const { rerender } = render(<NegociacaoProcesso processoId="proc-1" />);

    expect(await screen.findByRole('button', { name: /Apresentar ao titular/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Titular aceitou/ })).not.toBeInTheDocument();

    negociacao.resumo.mockResolvedValue(
      resumo({
        viva: proposta({ status: 'ENVIADA' }),
        rodadas: [proposta({ status: 'ENVIADA' })],
      }),
    );
    rerender(<NegociacaoProcesso processoId="proc-2" />);

    expect(await screen.findByRole('button', { name: /Titular aceitou/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apresentar ao titular/ })).not.toBeInTheDocument();
  });

  it('as rodadas anteriores continuam na tela, com o número de onde se saiu', async () => {
    /* É a razão de o modelo guardar rodadas: a contraproposta anterior é o que
       explica onde se chegou. */
    negociacao.resumo.mockResolvedValue(
      resumo({
        viva: proposta({ id: 'p2', rodada: 2, valorProposto: '400000.00', origem: 'TITULAR' }),
        rodadas: [
          proposta({ id: 'p2', rodada: 2, valorProposto: '400000.00', origem: 'TITULAR' }),
          proposta({ id: 'p1', rodada: 1, status: 'SUBSTITUIDA', valorProposto: '300000.00' }),
        ],
      }),
    );
    render(<NegociacaoProcesso processoId="proc-1" />);

    expect(await screen.findByText('Rodadas anteriores')).toBeInTheDocument();
    expect(screen.getByText('Substituída')).toBeInTheDocument();
    expect(screen.getByText(/contraproposta do titular/)).toBeInTheDocument();
  });

  it('a proposta ACEITA continua na tela — com os botões de imprimir', async () => {
    /**
     * ── O DEFEITO QUE ESTE CASO EXISTE PARA TRANCAR ──
     *
     * "Viva" é só RASCUNHO ou ENVIADA. Uma ACEITA não é viva, e num processo com
     * uma rodada só ela caía num vão: o bloco da viva não desenhava (não há
     * viva) e o do histórico também não (só aparecia com MAIS de uma rodada).
     *
     * Assim que o titular aceitava, o negócio FECHADO sumia da tela — e com ele
     * os botões de imprimir a folha, que moram no cartão. A folha da Etapa 7
     * existia e não tinha porta, justamente no caso que mais importa.
     *
     * Os oito casos anteriores passavam com o defeito no ar: todos montavam ou
     * uma viva, ou duas rodadas. Nenhum montava o cenário mais comum de todos —
     * uma proposta, aceita.
     */
    const aceita = proposta({ status: 'ACEITA', valorProposto: '300000.00' });
    negociacao.resumo.mockResolvedValue(resumo({ viva: null, aceita, rodadas: [aceita] }));
    render(<NegociacaoProcesso processoId="proc-1" />);

    expect(await screen.findByText('Aceita')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Folha do titular/ })).toHaveAttribute(
      'href',
      '/processo/proc-1/proposta?proposta=p1&destino=TITULAR',
    );
    expect(screen.getByRole('link', { name: /versão interna/ })).toBeInTheDocument();

    /* E os botões que NÃO cabem num negócio fechado continuam fora. */
    expect(screen.queryByRole('button', { name: /Apresentar ao titular/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Titular aceitou/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Descartar/ })).not.toBeInTheDocument();
  });

  it('a aceita NÃO aparece duas vezes quando há histórico', async () => {
    /* Ela é o cartão do topo; repeti-la em "rodadas anteriores" faria a tela
       mostrar o mesmo contrato duas vezes, com dois pares de botões de imprimir. */
    const aceita = proposta({ id: 'p2', rodada: 2, status: 'ACEITA' });
    const antiga = proposta({ id: 'p1', rodada: 1, status: 'SUBSTITUIDA' });
    negociacao.resumo.mockResolvedValue(
      resumo({ viva: null, aceita, rodadas: [aceita, antiga] }),
    );
    render(<NegociacaoProcesso processoId="proc-1" />);

    await screen.findByText('Aceita');
    expect(screen.getAllByText('Aceita')).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /Folha do titular/ })).toHaveLength(1);
    expect(screen.getByText('Substituída')).toBeInTheDocument();
  });

  it('erro do servidor aparece na tela, em vez de sumir', async () => {
    negociacao.resumo.mockResolvedValue(resumo({ viva: proposta(), rodadas: [proposta()] }));
    negociacao.enviar.mockRejectedValue(new Error('assinatura suspensa'));
    const u = userEvent.setup();
    render(<NegociacaoProcesso processoId="proc-1" />);

    await u.click(await screen.findByRole('button', { name: /Apresentar ao titular/ }));
    expect(await screen.findByText(/assinatura suspensa/)).toBeInTheDocument();
  });
});
describe('Calculadora oficial (CNJ)', () => {
  /**
   * O painel NÃO chama o gateway sozinho — cada cálculo é um POST em
   * infraestrutura do CNJ, e o clique é o consentimento. Montar a aba não pode
   * custar uma requisição ao governo.
   */
  it('não calcula nada ao montar — só no clique', async () => {
    negociacao.resumo.mockResolvedValue(resumo());
    render(<NegociacaoProcesso processoId="p1" esferaTribunal="FEDERAL" exercicio={2027} />);
    await screen.findByText(/calculadora oficial/i);

    expect(calcularSaldoOficial).not.toHaveBeenCalled();
  });

  it('usa a base do processo, deriva a esfera do tribunal e mostra o memorial', async () => {
    negociacao.resumo.mockResolvedValue(resumo());
    calcularSaldoOficial.mockResolvedValue({
      fonte: 'SISPREQ',
      valorBase: 1000000,
      dataBase: '2024-07-01',
      dataFinal: '2026-08-19',
      saldoAtualizado: 1209973.11,
      correcao: 45580.05,
      juros: 19168.74,
      selic: 145224.31,
      indices: [
        { nome: 'Selic', dataInicio: '2024-07-01', dataFinal: '2025-08-29', percentual: 13.89 },
        { nome: '2% a.a + IPCA', dataInicio: '2025-09-01', dataFinal: '2026-07-31', percentual: 6.3 },
      ],
      legislacoes: ['RESOLUCAO_303', 'EC_136_25'],
      serieAtualizadaAte: '2026-07-31',
    });

    const user = userEvent.setup();
    const { container } = render(
      <NegociacaoProcesso processoId="p1" esferaTribunal="FEDERAL" exercicio={2027} />,
    );
    await screen.findByText(/calculadora oficial/i);

    /* Tribunal FEDERAL: a esfera deriva sozinha e o seletor NÃO aparece. */
    expect(screen.queryByText(/esfera do devedor/i)).toBeNull();

    const datas = container.querySelectorAll('input[type="date"]');
    await user.type(datas[0] as HTMLElement, '2024-07-01');
    await user.type(datas[1] as HTMLElement, '2024-08-15');
    await user.click(screen.getByRole('button', { name: /^calcular$/i }));

    /* O que viaja: a base ATUAL do processo (mesma régua da proposta), as duas
       datas, a esfera derivada e o exercício — e NADA de dado pessoal. */
    await waitFor(() =>
      expect(calcularSaldoOficial).toHaveBeenCalledWith({
        valorPrincipal: 1000000,
        dataBase: '2024-07-01',
        dataProtocolo: '2024-08-15',
        exercicio: '2027',
        esfera: 'FEDERAL',
      }),
    );

    expect(await screen.findByText(/1\.209\.973/)).toBeTruthy();
    expect(screen.getByText(/2% a.a \+ IPCA/)).toBeTruthy();
    expect(screen.getByText(/Calculadora oficial do CNJ \(SISPREQ\)/)).toBeTruthy();
    expect(screen.getByText(/EC_136_25/)).toBeTruthy();
  });

  /* TRABALHISTA não converte sozinho: o devedor pode ser de qualquer esfera,
     então quem escolhe é o operador — e sem escolher, o botão nem arma. */
  it('tribunal TRABALHISTA exige escolher a esfera do devedor', async () => {
    negociacao.resumo.mockResolvedValue(resumo());
    const user = userEvent.setup();
    const { container } = render(
      <NegociacaoProcesso processoId="p1" esferaTribunal="TRABALHISTA" exercicio={2027} />,
    );
    await screen.findByText(/calculadora oficial/i);

    expect(screen.getByText(/esfera do devedor/i)).toBeTruthy();

    const datas = container.querySelectorAll('input[type="date"]');
    await user.type(datas[0] as HTMLElement, '2024-07-01');
    await user.type(datas[1] as HTMLElement, '2024-08-15');
    /* Datas preenchidas e esfera NÃO: desabilitado. */
    expect(screen.getByRole('button', { name: /^calcular$/i })).toBeDisabled();

    await user.selectOptions(screen.getByRole('combobox'), 'ESTADUAL');
    expect(screen.getByRole('button', { name: /^calcular$/i })).toBeEnabled();
  });

  /* O gateway do CNJ fora do ar não pode derrubar a aba: o erro aparece no
     painel e o resto da negociação continua utilizável. */
  it('erro da calculadora fica no painel, sem derrubar a aba', async () => {
    negociacao.resumo.mockResolvedValue(resumo());
    calcularSaldoOficial.mockRejectedValue(
      new Error('A calculadora oficial do CNJ não respondeu. Tente novamente em instantes.'),
    );

    const user = userEvent.setup();
    const { container } = render(
      <NegociacaoProcesso processoId="p1" esferaTribunal="FEDERAL" exercicio={null} />,
    );
    await screen.findByText(/calculadora oficial/i);

    const datas = container.querySelectorAll('input[type="date"]');
    await user.type(datas[0] as HTMLElement, '2024-07-01');
    await user.type(datas[1] as HTMLElement, '2024-08-15');
    await user.click(screen.getByRole('button', { name: /^calcular$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/não respondeu/i);
    expect(screen.getByText('Negociação')).toBeTruthy();
  });
});
