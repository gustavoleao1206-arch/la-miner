import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BlocoErro, Vazio, comoEstado } from '@/components/estado';

/**
 * As primitivas de estado da tela. Além de provarem o harness de renderização,
 * elas carregam uma decisão de acessibilidade que o comentário do arquivo faz
 * questão de guardar: "carregando", "erro" e "vazio" são DISTINTOS, e o erro é
 * anunciado a leitores de tela.
 */
describe('BlocoErro', () => {
  it('mostra a mensagem e se anuncia como status', () => {
    render(<BlocoErro msg="Redis fora do ar" />);
    const bloco = screen.getByRole('status');
    expect(bloco).toHaveTextContent('Redis fora do ar');
  });
});

describe('Vazio', () => {
  it('renderiza título e descrição', () => {
    render(<Vazio titulo="Nada pendente" descricao="Nenhuma tarefa aberta." />);
    expect(screen.getByText('Nada pendente')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma tarefa aberta.')).toBeInTheDocument();
  });

  it('a descrição é opcional', () => {
    const { container } = render(<Vazio titulo="Sem histórico" />);
    expect(screen.getByText('Sem histórico')).toBeInTheDocument();
    // Só o título — nenhum parágrafo de descrição.
    expect(container.querySelectorAll('p')).toHaveLength(1);
  });

  it('a ação só aparece quando passada', () => {
    const { rerender } = render(<Vazio titulo="X" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(<Vazio titulo="X" acao={<button>Limpar filtros</button>} />);
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeInTheDocument();
  });
});

/**
 * `comoEstado` converte um resultado de `Promise.allSettled` — é o que permite
 * o dashboard renderizar a carteira mesmo com a fila fora do ar, em vez de a
 * página inteira cair por uma dependência secundária.
 */
describe('comoEstado', () => {
  it('fulfilled vira ok com os dados', () => {
    expect(comoEstado({ status: 'fulfilled', value: { n: 1 } })).toEqual({
      st: 'ok',
      dados: { n: 1 },
    });
  });

  it('rejected vira erro, preservando a mensagem', () => {
    const estado = comoEstado({ status: 'rejected', reason: new Error('timeout') });
    expect(estado).toEqual({ st: 'erro', msg: 'timeout' });
  });

  it('rejected sem mensagem cai num texto padrão', () => {
    const estado = comoEstado({ status: 'rejected', reason: {} });
    expect(estado).toMatchObject({ st: 'erro', msg: 'Falha ao carregar' });
  });
});
