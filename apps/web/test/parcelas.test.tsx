import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Cronograma, Proposta } from '@/lib/api';

/**
 * O CRONOGRAMA DE PAGAMENTO ao titular.
 *
 * O que estes casos protegem é quase todo NEGATIVO: quem não é gestor não vê o
 * botão de baixa, o cronograma não aparece em honorários, a folha não vira
 * régua de cobrança. A parte positiva — a conta fechar — mora nos 15 testes de
 * `cronograma.spec.ts`, onde é aritmética pura e não precisa de DOM.
 */

const { negociacao } = vi.hoisted(() => ({
  negociacao: {
    cronograma: vi.fn(),
    gerarCronograma: vi.fn(),
    baixar: vi.fn(),
    desfazerBaixa: vi.fn(),
  },
}));

vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, negociacao };
});

import { ParcelasProcesso } from '@/components/crm/parcelas-processo';

function proposta(over: Partial<Proposta> = {}): Proposta {
  return {
    id: 'p1',
    rodada: 1,
    origem: 'ESCRITORIO',
    modalidade: 'CESSAO',
    status: 'ACEITA',
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

/** Três parcelas de 100 mil que fecham nos 300 mil da proposta acima. */
function cronograma(over: Partial<Cronograma> = {}): Cronograma {
  return {
    total: '300000.00',
    parcelas: [
      {
        id: 'x1',
        numero: 1,
        entrada: false,
        valor: '100000.00',
        vencimento: '2026-09-10T00:00:00.000Z',
        pagoEm: null,
        pagoPor: null,
        vencida: false,
      },
      {
        id: 'x2',
        numero: 2,
        entrada: false,
        valor: '100000.00',
        vencimento: '2026-10-10T00:00:00.000Z',
        pagoEm: null,
        pagoPor: null,
        vencida: false,
      },
      {
        id: 'x3',
        numero: 3,
        entrada: false,
        valor: '100000.00',
        vencimento: '2026-11-10T00:00:00.000Z',
        pagoEm: null,
        pagoPor: null,
        vencida: false,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  negociacao.cronograma.mockResolvedValue(cronograma());
  negociacao.gerarCronograma.mockResolvedValue(cronograma());
  negociacao.baixar.mockImplementation(async () => {
    const c = cronograma();
    c.parcelas[0].pagoEm = '2026-09-11T00:00:00.000Z';
    return { ...c, alterado: true };
  });
  negociacao.desfazerBaixa.mockResolvedValue({ ...cronograma(), alterado: true });
});

describe('Cronograma de pagamento ao titular', () => {
  it('em honorários não existe cronograma — nem a seção', async () => {
    /* Honorário é percentual sobre o que o precatório pagar: a quantia só
       existe no dia do pagamento, e não há o que parcelar antes disso. */
    render(
      <ParcelasProcesso
        processoId="proc-1"
        proposta={proposta({ modalidade: 'HONORARIOS', valorProposto: null })}
        podeDarBaixa
      />,
    );

    await waitFor(() => expect(negociacao.cronograma).not.toHaveBeenCalled());
    expect(screen.queryByText(/Pagamento ao titular/)).not.toBeInTheDocument();
  });

  it('quem não é gestor vê as parcelas mas não o botão de baixa', async () => {
    /* A trava real está no servidor. Esta é só a cortesia de não oferecer um
       botão que responderia 403 — e de dizer por quê, para o operador não achar
       que a tela está quebrada. */
    render(
      <ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa={false} />,
    );

    expect(await screen.findByText(/Parcela 1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Registrar pagamento/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Só o gestor da organização/)).toBeInTheDocument();
  });

  it('gestor dá baixa e a parcela passa a mostrar a data', async () => {
    const u = userEvent.setup();
    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa />);

    const botoes = await screen.findAllByRole('button', { name: /Registrar pagamento/ });
    await u.click(botoes[0]);

    expect(negociacao.baixar).toHaveBeenCalledWith('proc-1', 'p1', 1);
    expect(await screen.findByText(/pago em/)).toBeInTheDocument();
    /* A que foi paga troca de botão; as outras duas continuam esperando. */
    expect(screen.getAllByRole('button', { name: /Registrar pagamento/ })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Desfazer/ })).toBeInTheDocument();
  });

  it('em rascunho oferece parcelar, e manda o que foi digitado', async () => {
    /* O cronograma nasce ANTES da assinatura de propósito: o titular assina
       sabendo em quantas vezes recebe. Combinar depois seria mudar o contrato. */
    const u = userEvent.setup();
    negociacao.cronograma.mockResolvedValue({ total: '0.00', parcelas: [] });
    render(
      <ParcelasProcesso
        processoId="proc-1"
        proposta={proposta({ status: 'RASCUNHO' })}
        podeDarBaixa
      />,
    );

    await u.click(await screen.findByRole('button', { name: 'Parcelar' }));
    await u.type(screen.getByLabelText('Entrada'), '60000.00');
    await u.clear(screen.getByLabelText('Número de parcelas'));
    await u.type(screen.getByLabelText('Número de parcelas'), '3');
    await u.type(screen.getByLabelText('Primeiro vencimento'), '2026-09-10');
    await u.click(screen.getByRole('button', { name: /Gerar parcelas/ }));

    await waitFor(() =>
      expect(negociacao.gerarCronograma).toHaveBeenCalledWith('proc-1', 'p1', {
        entrada: '60000.00',
        parcelas: 3,
        primeiroVencimento: '2026-09-10',
      }),
    );
    /* `intervaloMeses` ausente quando é 1: o padrão do servidor é mensal, e
       mandar o valor padrão só o obrigaria a existir em dois lugares. */
  });

  it('o valor total NÃO é digitado — sai do que já foi acordado', async () => {
    const u = userEvent.setup();
    negociacao.cronograma.mockResolvedValue({ total: '0.00', parcelas: [] });
    render(
      <ParcelasProcesso
        processoId="proc-1"
        proposta={proposta({ status: 'RASCUNHO' })}
        podeDarBaixa
      />,
    );

    await u.click(await screen.findByRole('button', { name: 'Parcelar' }));
    /* Um campo de total aqui criaria duas verdades sobre quanto o titular
       recebe — a da proposta e a do cronograma —, e nada garantiria que
       coincidissem. O formulário mostra o acordado e divide ELE. */
    expect(screen.queryByLabelText(/Valor total/)).not.toBeInTheDocument();
    expect(screen.getByText(/Dividindo/)).toHaveTextContent('R$ 300.000,00');
  });

  it('depois que uma parcela foi paga, o cronograma não pode ser refeito', async () => {
    /* Refazer apaga e regrava as linhas. Se uma já foi paga, a baixa iria junto
       — e o registro de que o dinheiro saiu é a última coisa que se apaga. */
    const c = cronograma();
    c.parcelas[0].pagoEm = '2026-09-11T00:00:00.000Z';
    negociacao.cronograma.mockResolvedValue(c);

    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa />);

    expect(await screen.findByText(/pago em/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refazer cronograma/ })).not.toBeInTheDocument();
  });

  it('parcela vencida é informação, não cobrança', async () => {
    /* Nenhum vermelho, nenhum "em atraso", nenhum aviso: o escritório atrasar o
       pagamento ao titular DELE não é assunto do sistema. Pintar de alarme aqui
       seria o primeiro passo de uma régua de cobrança que ninguém pediu. */
    const c = cronograma();
    c.parcelas[0].vencida = true;
    negociacao.cronograma.mockResolvedValue(c);

    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa={false} />);

    expect(await screen.findByText('vencida')).toBeInTheDocument();
    expect(screen.queryByText(/atraso|inadimpl|pendência|regularize/i)).not.toBeInTheDocument();
  });

  it('soma diferente do acordado aparece na cara de quem abre o processo', async () => {
    /* Hoje isso é impossível — não existe rota que edite uma parcela isolada.
       O aviso é para o dia em que existir: a divergência tem de ser vista na
       primeira abertura, não meses depois na conferência do contrato. */
    negociacao.cronograma.mockResolvedValue(cronograma({ total: '250000.00' }));

    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa={false} />);

    expect(await screen.findByText(/diferente do valor acordado/)).toBeInTheDocument();
  });

  it('sem cronograma, diz que é à vista — não finge um vazio', async () => {
    negociacao.cronograma.mockResolvedValue({ total: '0.00', parcelas: [] });

    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa />);

    expect(await screen.findByText(/À vista/)).toBeInTheDocument();
  });

  it('erro do servidor aparece na tela, sem sumir com o cronograma', async () => {
    /* Se a baixa falha, o operador precisa ver POR QUÊ e continuar vendo as
       parcelas — sumir com a lista o faria recarregar sem saber o que houve. */
    const u = userEvent.setup();
    negociacao.baixar.mockRejectedValue(new Error('Só o gestor da organização registra pagamento.'));

    render(<ParcelasProcesso processoId="proc-1" proposta={proposta()} podeDarBaixa />);
    await u.click((await screen.findAllByRole('button', { name: /Registrar pagamento/ }))[0]);

    expect(await screen.findByText(/Só o gestor da organização registra pagamento/)).toBeInTheDocument();
    expect(screen.getByText(/Parcela 1/)).toBeInTheDocument();
  });
});
