import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  descricaoDaFase,
  faseExigivel,
  SeloFase,
  ValorIndicativo,
} from '@/components/fase-processo';
import type { FaseProcesso } from '@/lib/api';

/**
 * O selo de fase, que é o que impede um pré-precatório de passar por precatório.
 *
 * A decisão de incluir pré-precatórios no sorteio dos 250 tornou este selo
 * obrigatório: sem ele, dois itens de valor parecido ficam idênticos na tela
 * mesmo estando a anos de distância um do outro. A landing corrigida em
 * 07/09/2026 diz a composição do lote; o selo é quem diz a de cada linha.
 */
describe('SeloFase', () => {
  it('nomeia cada estágio com o texto que o advogado reconhece', () => {
    const casos: [FaseProcesso, string][] = [
      ['TRANSITO_EM_JULGADO', 'Trânsito em julgado'],
      ['CALCULOS_HOMOLOGADOS', 'Cálculos homologados'],
      ['REQUISITORIO_EXPEDIDO', 'Requisitório expedido'],
      ['PRECATORIO_AUTUADO', 'Precatório autuado'],
      ['PRECATORIO_EXPEDIDO', 'Precatório expedido'],
    ];
    for (const [fase, rotulo] of casos) {
      const { unmount } = render(<SeloFase fase={fase} />);
      expect(screen.getByText(rotulo)).toBeInTheDocument();
      unmount();
    }
  });

  it('a informação NÃO depende da cor — o rótulo é texto e a explicação é atributo', () => {
    /* Daltonismo e leitor de tela: quem não distingue o âmbar do neutro precisa
       receber a mesma informação. Por isso o estágio é palavra, não só cor. */
    render(<SeloFase fase="CALCULOS_HOMOLOGADOS" />);
    const selo = screen.getByText('Cálculos homologados');
    expect(selo).toHaveAttribute('title', expect.stringContaining('ainda não foi requisitado'));
  });

  it('só o precatório expedido é neutro; os demais pedem atenção', () => {
    /* O neutro é o esperado — a carteira inteira era isso. Os outros ganham
       âmbar de ATENÇÃO, nunca de erro: a própria fonte observa que a fase 2 pode
       valer MAIS que a 4, porque o credor ainda não foi procurado. */
    const { container: exigivel } = render(<SeloFase fase="PRECATORIO_EXPEDIDO" />);
    expect(exigivel.firstElementChild?.className).not.toMatch(/alerta/);

    const { container: cedo } = render(<SeloFase fase="TRANSITO_EM_JULGADO" />);
    expect(cedo.firstElementChild?.className).toMatch(/alerta/);
  });

  it('fase desconhecida aparece crua, e NÃO como precatório comum', () => {
    /* Um valor novo no enum do banco que o front ainda não conheça renderizaria
       um selo vazio — e vazio se lê como "precatório normal". Mostrar o valor
       cru é feio e honesto; o silêncio seria bonito e mentiroso. */
    render(<SeloFase fase={'FASE_QUE_NAO_EXISTE' as FaseProcesso} />);
    expect(screen.getByText('FASE_QUE_NAO_EXISTE')).toBeInTheDocument();
  });
});

describe('ValorIndicativo', () => {
  it('mostra o valor com til e a palavra "estimado"', () => {
    /* A fonte diz que o número "é palpite — pode ser honorário, custas ou valor
       da causa". Exibi-lo com a mesma cara do valor apurado faria o advogado
       decidir a abordagem por ele e descobrir depois. */
    render(<ValorIndicativo valor="250000" />);
    expect(screen.getByText(/estimado/i)).toBeInTheDocument();
    expect(screen.getByText(/~/)).toBeInTheDocument();
  });

  it('não renderiza nada quando não há valor', () => {
    const { container } = render(<ValorIndicativo valor={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza lixo quando o valor não é número', () => {
    const { container } = render(<ValorIndicativo valor="não é número" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('na forma compacta abrevia o número e guarda o inteiro no title', () => {
    /* É a forma de LISTA: o olho compara "1,2 mi" com "245 mil" descendo a
       coluna. O número inteiro não some — vai para o hover, e o til e o
       "estimado" continuam nas duas formas. */
    render(<ValorIndicativo valor="1234567" compacto />);
    const el = screen.getByText(/~R\$ 1,2 mi/);
    expect(el.getAttribute('title')).toMatch(/R\$\s1\.234\.567/);
    expect(el.getAttribute('title')).toMatch(/indicativo/);
    expect(screen.getByText(/estimado/i)).toBeInTheDocument();
  });
});

/**
 * A RÉGUA DE EXIGIBILIDADE, agora usada também pelo AGREGADO.
 *
 * Enquanto a base era 100% precatório expedido, saber "isto já é exigível?" só
 * importava no item. Com os pré-precatórios na mesma carteira, o KPI do
 * dashboard precisa da mesma resposta — e duas definições seriam duas que
 * divergem na próxima fase que entrar no enum.
 */
describe('faseExigivel', () => {
  it('só o precatório expedido é exigível', () => {
    expect(faseExigivel('PRECATORIO_EXPEDIDO')).toBe(true);
    for (const f of [
      'TRANSITO_EM_JULGADO',
      'CALCULOS_HOMOLOGADOS',
      'REQUISITORIO_EXPEDIDO',
      'PRECATORIO_AUTUADO',
    ] as FaseProcesso[]) {
      expect(faseExigivel(f)).toBe(false);
    }
  });

  it('⚠ fase desconhecida devolve undefined, e NÃO false', () => {
    /* A distinção inteira. Um `false` aqui faria o dashboard contar uma fase que
       ninguém classificou como "em fase anterior" — afirmando sobre a carteira
       do cliente algo que nenhuma pessoa decidiu. `undefined` a deixa fora dos
       dois lados, que é a única resposta honesta. */
    expect(faseExigivel('FASE_QUE_NAO_EXISTE' as FaseProcesso)).toBeUndefined();
  });
});

/**
 * O TEXTO DO ESTÁGIO, para onde não há cor nem `title`.
 *
 * A folha impressa da proposta é papel: não tem tooltip, não tem cor confiável e
 * o titular assina. Ela precisa do nome do estágio E da explicação por extenso,
 * e ambos têm de sair do MESMO mapa que desenha o selo na tela.
 */
describe('descricaoDaFase', () => {
  it('devolve o nome curto e a explicação de cada estágio', () => {
    expect(descricaoDaFase('TRANSITO_EM_JULGADO')).toEqual({
      curto: 'Trânsito em julgado',
      explica: expect.stringContaining('não foi apurado'),
    });
    expect(descricaoDaFase('PRECATORIO_EXPEDIDO')?.curto).toBe('Precatório expedido');
  });

  it('⚠ fase desconhecida devolve undefined — quem imprime decide o que fazer', () => {
    /* O documento então imprime o valor cru do enum: feio e honesto. Um rótulo
       de fallback ("Precatório", digamos) inventaria sobre um papel assinado. */
    expect(descricaoDaFase('FASE_QUE_NAO_EXISTE' as FaseProcesso)).toBeUndefined();
  });
});
