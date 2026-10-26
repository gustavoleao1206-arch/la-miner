import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ProcessoDetalhe } from '@/lib/api';

/**
 * A página do processo vista por um CLIENTE.
 *
 * O backend não devolve ao cliente o mesmo objeto que devolve ao time interno:
 * a projeção em `carteira.service.ts` REMONTA a resposta e deixa de fora
 * `statusEnriquecimento`, `ultimaSincronizacao`, `camposAlterados`, `detalhe` e
 * `importacaoId` — o cliente vê o contato, não a maquinaria que o obteve.
 *
 * Os tipos do front declaravam esses campos como obrigatórios. O `tsc` passava,
 * e a página quebrava em RUNTIME para todo cliente, em todo processo:
 *
 *   STATUS[undefined].cor        → Cannot read properties of undefined
 *   evento.camposAlterados.length → Cannot read properties of undefined
 *
 * O segundo pegava sempre, porque todo processo tem ao menos o evento
 * IMPORTADO. Este teste monta a resposta EXATAMENTE como o cliente a recebe —
 * campos ausentes, não nulos — e por isso é ele, e não o compilador, quem
 * segura a regressão.
 */

/* `vi.mock` é içado para o topo do arquivo — antes de qualquer `const`. Os
   dublês precisam nascer dentro de `vi.hoisted`, senão a fábrica roda com as
   variáveis ainda não inicializadas. */
const { api, crm, negociacao } = vi.hoisted(() => ({
  api: vi.fn(),
    /* `contatos` entrou com o funil comercial: a tela do processo passou a
     pedir o histórico de tentativas ao montar. Sem ele no dublê, a página
     quebrava com "crm.contatos is not a function" — que é exatamente a
     classe de defeito que estes testes existem para pegar (ver B1). */
  crm: { equipe: vi.fn(), listarEtiquetas: vi.fn(), contatos: vi.fn() },
  /* Mesma razão do  acima, um degrau adiante: a aba de Negociação
     também consulta ao montar. Sem o dublê o bloco cai no  e a página
     passa no teste com um erro escondido dentro — que é pior que falhar. */
  negociacao: { resumo: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'proc-1' }) }));

vi.mock('@/lib/api', async (original) => {
  /* Só `api` e `crm` são dublados; ErroApi e os tipos continuam os de verdade,
     senão o teste validaria um módulo que não é o que roda em produção. */
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, api, crm, negociacao };
});

import ProcessoPage from '@/app/(painel)/processo/[id]/page';

/**
 * Resposta do cliente. Note o que NÃO está aqui — é esse o ponto do teste.
 * `as unknown as ProcessoDetalhe` é deliberado: o tipo descreve a resposta
 * completa, e o cliente recebe menos que isso.
 */
function processoDoCliente(): ProcessoDetalhe {
  return {
    id: 'proc-1',
    numeroPrecatorio: '0000123-45.2020.4.01.3400',
    numeroOriginario: null,
    numeroRequisitorio: null,
    tribunal: { sigla: 'TRF1', nome: 'Tribunal Regional Federal da 1ª Região' },
    vara: null,
    entidadeDevedora: 'União',
    natureza: 'COMUM',
    exercicio: 2027,
    dataAutuacao: null,
    valor: '150000.00',
    situacao: null,
    fonte: null,
    prioridade: 'NORMAL',
    responsavel: null,
    etiquetas: [],
    tarefas: [],
    anotacoes: [],
    editadoEm: '2026-08-09T12:00:00.000Z',
    totalEventos: 1,
    eventosTruncados: false,
    partes: [
      {
        papel: 'REQUERENTE',
        valorIndividual: '150000.00',
        observacoes: null,
        pessoa: {
          id: 'pes-1',
          cpf: '39053344705',
          nome: 'MARIA DE SOUZA',
          dataNascimento: null,
          obito: false,
          // sem statusEnriquecimento, sem ultimaSincronizacao
          telefones: [{ ddd: '61', numero: '999998888', tipo: 'MOVEL', whatsapp: true }],
          emails: [],
          enderecos: [],
        },
      },
    ],
    eventos: [
      {
        id: 'ev-1',
        tipo: 'IMPORTADO',
        descricao: 'Processo importado para a carteira',
        criadoEm: '2026-08-09T12:00:00.000Z',
        // sem camposAlterados, sem detalhe, sem importacaoId
      },
    ],
  } as unknown as ProcessoDetalhe;
}

describe('página do processo — resposta do cliente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crm.equipe.mockResolvedValue([]);
    crm.contatos.mockResolvedValue([]);
    crm.listarEtiquetas.mockResolvedValue([]);
    negociacao.resumo.mockResolvedValue({
      baseAtual: null,
      baseOrigemAtual: null,
      viva: null,
      aceita: null,
      rodadas: [],
    });
  });

  it('renderiza sem quebrar mesmo sem os campos internos', async () => {
    api.mockResolvedValue(processoDoCliente());
    render(<ProcessoPage />);

    /* Chegou ao conteúdo: se qualquer um dos dois TypeErrors voltar, o React
       derruba a árvore e nada disto aparece.

       Pelo título, e não por texto: o número do precatório também aparece em
       "Dados do processo", e uma busca por texto casaria com os dois. */
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
      '0000123-45.2020.4.01.3400',
    );
    expect(screen.getByText('MARIA DE SOUZA')).toBeInTheDocument();
    expect(screen.getByText('Processo importado para a carteira')).toBeInTheDocument();
    expect(screen.getByText('(61) 99999-8888')).toBeInTheDocument();
  });

  it('não revela o enriquecimento ao cliente', async () => {
    api.mockResolvedValue(processoDoCliente());
    render(<ProcessoPage />);
    await screen.findByText('MARIA DE SOUZA');

    /* O selo de status é o vocabulário do enriquecimento. Sem o campo, ele não
       pode aparecer — nem como "Pendente", que seria uma inferência errada
       além de vazar a existência da esteira. */
    for (const rotulo of ['Enriquecido', 'Pendente', 'Sem dados', 'Erro']) {
      expect(screen.queryByText(rotulo)).not.toBeInTheDocument();
    }
  });

  it('parte sem contato não fala em fila nem em enriquecimento', async () => {
    const p = processoDoCliente();
    p.partes[0].pessoa.telefones = [];
    api.mockResolvedValue(p);
    render(<ProcessoPage />);
    await screen.findByText('MARIA DE SOUZA');

    expect(
      screen.getByText('Não há telefone, e-mail ou endereço cadastrados para esta parte.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/enriquecimento/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /fila/i })).not.toBeInTheDocument();
  });

  it('⚠ o veredito do CPF não aparece — nem mesmo se o servidor voltar a mandá-lo', async () => {
    /* O selo saiu de todas as telas em 20/09/2026 e o campo saiu da resposta no
       mesmo dia. Esta era a tela mais sensível: é aqui que o telefone aparece.

       O caso força o campo de volta na resposta (`as never`, porque o tipo já
       não o tem) para provar que a tela não voltaria a desenhá-lo se uma versão
       antiga da API ainda o enviasse — durante um deploy, por exemplo.

       O veredito não sumiu do sistema: continua gravado e continua bloqueando o
       sorteio (ver `PROCESSO_DISTRIBUIVEL`). O que saiu é o texto na tela. */
    const p = processoDoCliente();
    (p.partes[0].pessoa as Record<string, unknown>).conferenciaNome = 'DIVERGE';
    api.mockResolvedValue(p);
    render(<ProcessoPage />);
    await screen.findByText('MARIA DE SOUZA');

    expect(screen.queryByText(/CPF (a conferir|não conferido)/)).not.toBeInTheDocument();
    /* E o bloco da parte continua de pé: nome e CPF no lugar. */
    expect(screen.getByText('MARIA DE SOUZA')).toBeInTheDocument();
  });

  it('o time interno continua vendo status e de/para', async () => {
    /* O contraponto: a mesma tela com a resposta COMPLETA. Sem este caso, um
       "conserto" que simplesmente apagasse o selo e o diff passaria batido. */
    const p = processoDoCliente();
    p.partes[0].pessoa.statusEnriquecimento = 'SINCRONIZADO';
    p.eventos = [
      {
        id: 'ev-2',
        tipo: 'DADO_ATUALIZADO',
        descricao: 'Situação alterada',
        criadoEm: '2026-08-09T12:00:00.000Z',
        camposAlterados: ['situacao'],
        detalhe: { situacao: { de: 'Aguardando', para: 'Pago' } },
        importacaoId: null,
      },
    ];
    api.mockResolvedValue(p);
    render(<ProcessoPage />);

    expect(await screen.findByText('Enriquecido')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Aguardando')).toBeInTheDocument());
    expect(screen.getByText('Pago')).toBeInTheDocument();
  });
});
