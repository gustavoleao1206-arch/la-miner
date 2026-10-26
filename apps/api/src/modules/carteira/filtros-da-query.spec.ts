import { BadRequestException } from '@nestjs/common';
import { filtrosDaQuery } from './filtros-da-query';

/**
 * A leitura da query RECUSA valor fora da lista, e não o ignora.
 *
 * O modo de falha que isto tranca: um filtro que o servidor descarta em
 * silêncio devolve a carteira inteira, e a tela mostra "todos" achando que
 * mostra "estaduais". Com os três chips do módulo de pré-precatórios a lista
 * de valores aceitos cresceu — e cada um precisa do mesmo tratamento.
 */
describe('filtrosDaQuery — os três chips do módulo de pré-precatórios', () => {
  it('aceita os valores da lista e os devolve tipados', () => {
    const f = filtrosDaQuery({
      fase: 'CALCULOS_HOMOLOGADOS',
      esfera: 'ESTADUAL',
      conferencia: 'DIVERGE',
    });
    expect(f.fase).toBe('CALCULOS_HOMOLOGADOS');
    expect(f.esfera).toBe('ESTADUAL');
    expect(f.conferencia).toBe('DIVERGE');
  });

  it('ausente ou vazio significa "não filtre", nunca um valor', () => {
    const f = filtrosDaQuery({ fase: '', esfera: undefined });
    expect(f.fase).toBeUndefined();
    expect(f.esfera).toBeUndefined();
    expect(f.conferencia).toBeUndefined();
  });

  it.each([
    ['fase', 'EXPEDIDO'],
    ['fase', 'calculos_homologados'],
    ['esfera', 'MUNICIPAL'],
    ['conferencia', 'OK'],
  ])('recusa %s=%s com 400, em vez de devolver a carteira inteira', (chave, valor) => {
    expect(() => filtrosDaQuery({ [chave]: valor })).toThrow(BadRequestException);
  });

  it('os filtros antigos continuam passando pelo mesmo caminho', () => {
    const f = filtrosDaQuery({ estagio: 'PROPOSTA', frioDias: '15', semContato: 'true' });
    expect(f.estagio).toBe('PROPOSTA');
    expect(f.frioDias).toBe(15);
    expect(f.semContato).toBe(true);
  });
});

/**
 * O termo de busca tem TETO de comprimento.
 *
 * É o único parâmetro de texto livre do módulo, e vai para um `contains` (LIKE)
 * sobre número, nome e CPF. Sem teto, um termo patológico vira varredura das
 * três colunas disfarçada de busca. 120 cobre qualquer busca real; acima disso
 * é 400, não uma consulta cara aceita em silêncio.
 */
describe('filtrosDaQuery — teto do termo de busca', () => {
  it('aceita um termo no limite (120 caracteres)', () => {
    const f = filtrosDaQuery({ termo: 'a'.repeat(120) });
    expect(f.termo).toHaveLength(120);
  });

  it('recusa com 400 um termo acima do teto', () => {
    expect(() => filtrosDaQuery({ termo: 'a'.repeat(121) })).toThrow(BadRequestException);
  });

  it('um termo comum passa intacto', () => {
    const f = filtrosDaQuery({ termo: 'JOAO DA SILVA' });
    expect(f.termo).toBe('JOAO DA SILVA');
  });
});
