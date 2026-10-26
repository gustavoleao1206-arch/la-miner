import { describe, it, expect } from 'vitest';
import type { Estagio, ItemFila } from '@/lib/api';
import { decidirMovimento, ehTerminal, moverNoQuadro, removerDoQuadro, type Coluna } from '@/lib/quadro';

/**
 * O MIOLO DO QUADRO.
 *
 * Este arquivo existe porque a Etapa 5 acrescenta o arraste, e arraste é a única
 * parte do projeto que o teste automático não alcança — o ambiente não calcula
 * posição de tela. A regra fica AQUI, fora do gesto, e o gesto passa a ser só a
 * física. O que estes casos trancam é tudo que o arraste poderia errar.
 */

function item(id: string, over: Partial<ItemFila> = {}): ItemFila {
  return {
    id,
    numeroPrecatorio: `n-${id}`,
    entidadeDevedora: 'INSS',
    situacao: null,
    valor: '1000.00',
    /* O padrão da base inteira até 04/09/2026 — precatório na fila
       orçamentária. Os casos escritos antes da coluna de fase falam desse
       estágio sem nunca ter precisado dizer. */
    fase: 'PRECATORIO_EXPEDIDO' as const,
    valorIndicativo: null,
    tribunal: 'TRF5',
    titular: { id: `t-${id}`, nome: 'MARIA', cpf: '39053344705' },
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

function coluna(estagio: Estagio, itens: ItemFila[], total = itens.length): Coluna {
  return { estagio, itens, total };
}

describe('decidirMovimento', () => {
  it('soltar na MESMA coluna não faz nada', () => {
    /* É o gesto mais comum de todos: a desistência. Gravar aqui encheria a
       timeline de linhas permanentes dizendo que nada aconteceu. */
    expect(decidirMovimento('NOVO', 'NOVO')).toEqual({ tipo: 'nada' });
    expect(decidirMovimento('PERDIDO', 'PERDIDO')).toEqual({ tipo: 'nada' });
  });

  it('mover entre estágios não terminais grava direto', () => {
    expect(decidirMovimento('NOVO', 'EM_CONTATO')).toEqual({
      tipo: 'grava',
      de: 'NOVO',
      para: 'EM_CONTATO',
    });
  });

  it('FECHADO e PERDIDO pedem confirmação', () => {
    /* O servidor não valida transição nenhuma: mover de "Novo" direto para
       "Fechado" passa e escreve uma linha permanente. Num quadro, a distância
       entre duas colunas é um gesto curto. */
    expect(decidirMovimento('NOVO', 'FECHADO')).toMatchObject({ tipo: 'confirma' });
    expect(decidirMovimento('PROPOSTA', 'PERDIDO')).toMatchObject({ tipo: 'confirma' });
  });

  it('só PERDIDO pede o motivo', () => {
    expect(decidirMovimento('NOVO', 'PERDIDO')).toMatchObject({ pedeMotivo: true });
    expect(decidirMovimento('NOVO', 'FECHADO')).toMatchObject({ pedeMotivo: false });
  });

  it('SAIR de um terminal não pede confirmação', () => {
    /* Reabrir uma negociação é correção de erro, e pôr fricção nela faria o
       operador conviver com o dado errado em vez de consertá-lo. */
    expect(decidirMovimento('PERDIDO', 'EM_CONTATO')).toEqual({
      tipo: 'grava',
      de: 'PERDIDO',
      para: 'EM_CONTATO',
    });
  });

  it('ehTerminal responde pelos dois, e só por eles', () => {
    expect(ehTerminal('FECHADO')).toBe(true);
    expect(ehTerminal('PERDIDO')).toBe(true);
    expect(ehTerminal('PROPOSTA')).toBe(false);
    expect(ehTerminal('NOVO')).toBe(false);
  });
});

describe('moverNoQuadro', () => {
  it('tira da origem, põe no destino e ajusta os DOIS totais', () => {
    const colunas = [
      coluna('NOVO', [item('a')], 3000),
      coluna('EM_CONTATO', [], 40),
    ];

    const r = moverNoQuadro(colunas, 'a', 'NOVO', 'EM_CONTATO');

    expect(r[0].itens).toHaveLength(0);
    expect(r[1].itens.map((i) => i.id)).toEqual(['a']);
    /* O cabeçalho conta o SERVIDOR, não os cartões carregados: se o total não
       acompanhasse, a coluna continuaria dizendo 3.000 com o cartão já fora. */
    expect(r[0].total).toBe(2999);
    expect(r[1].total).toBe(41);
  });

  it('insere na posição certa por valor, não no fim', () => {
    /**
     * A fila ordena por valor, do maior para o menor. Empilhar no fim colocaria
     * um precatório de R$ 4 milhões abaixo de um de R$ 5 mil — e na recarga
     * seguinte ele saltaria para o topo sozinho, o que parece defeito.
     */
    const colunas = [
      coluna('NOVO', [item('grande', { valor: '4000000.00' })]),
      coluna('EM_CONTATO', [
        item('alto', { valor: '900000.00' }),
        item('baixo', { valor: '5000.00' }),
      ]),
    ];

    const r = moverNoQuadro(colunas, 'grande', 'NOVO', 'EM_CONTATO');

    expect(r[1].itens.map((i) => i.id)).toEqual(['grande', 'alto', 'baixo']);
  });

  it('processo sem valor lançado vai para o fim, e não para o topo', () => {
    /* `null` como zero: o contrário faria um precatório sem valor liderar a
       coluna, que é o mesmo defeito de ordenação que o backend já tratou com
       `nulls: last`. */
    const colunas = [
      coluna('NOVO', [item('semvalor', { valor: null })]),
      coluna('EM_CONTATO', [item('tem', { valor: '5000.00' })]),
    ];

    const r = moverNoQuadro(colunas, 'semvalor', 'NOVO', 'EM_CONTATO');

    expect(r[1].itens.map((i) => i.id)).toEqual(['tem', 'semvalor']);
  });

  it('o cartão movido já chega com o estágio novo', () => {
    const colunas = [coluna('NOVO', [item('a')]), coluna('PROPOSTA', [])];

    const r = moverNoQuadro(colunas, 'a', 'NOVO', 'PROPOSTA');

    expect(r[1].itens[0].estagio).toBe('PROPOSTA');
    expect(r[1].itens[0].estagioEm).not.toBeNull();
  });

  it('devolve colunas NOVAS, sem mutar as antigas', () => {
    /* O React só re-renderiza o que muda de identidade: mutar em lugar deixaria
       a tela parada com o dado certo por baixo — o pior tipo de defeito, porque
       o estado está correto e ninguém vê. */
    const antes = [coluna('NOVO', [item('a')]), coluna('PROPOSTA', [])];
    const copia = JSON.parse(JSON.stringify(antes));

    const r = moverNoQuadro(antes, 'a', 'NOVO', 'PROPOSTA');

    expect(antes).toEqual(copia);
    expect(r).not.toBe(antes);
  });

  it('id que não está no quadro não mexe em nada', () => {
    const colunas = [coluna('NOVO', [item('a')]), coluna('PROPOSTA', [])];
    expect(moverNoQuadro(colunas, 'fantasma', 'NOVO', 'PROPOSTA')).toBe(colunas);
  });

  it('mover e voltar devolve exatamente o estado anterior', () => {
    /* É o "desfazer" do quadro, e ele precisa ser IGUALDADE, não aproximação: um
       desfazer que deixa o cartão noutro lugar é pior que não ter desfazer. */
    const antes = [
      coluna('NOVO', [item('a', { valor: '900.00' }), item('b', { valor: '100.00' })], 10),
      coluna('EM_CONTATO', [item('c', { valor: '500.00' })], 5),
    ];

    const ida = moverNoQuadro(antes, 'a', 'NOVO', 'EM_CONTATO');
    const volta = moverNoQuadro(ida, 'a', 'EM_CONTATO', 'NOVO');

    expect(volta.map((c) => ({ e: c.estagio, ids: c.itens.map((i) => i.id), t: c.total }))).toEqual(
      antes.map((c) => ({ e: c.estagio, ids: c.itens.map((i) => i.id), t: c.total })),
    );
  });
});

describe('removerDoQuadro', () => {
  it('tira o cartão e desconta do total da coluna certa', () => {
    /* Usado quando o servidor responde 404: aquele processo não está mais na
       carteira desta organização. Devolvê-lo à origem seria reafirmar na tela o
       que o servidor acabou de negar. */
    const colunas = [coluna('NOVO', [item('a'), item('b')], 100), coluna('PROPOSTA', [], 3)];

    const r = removerDoQuadro(colunas, 'a');

    expect(r[0].itens.map((i) => i.id)).toEqual(['b']);
    expect(r[0].total).toBe(99);
    expect(r[1].total).toBe(3);
  });
});
