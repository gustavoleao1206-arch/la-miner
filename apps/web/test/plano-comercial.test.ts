import { describe, it, expect } from 'vitest';
import { descontoSobreMensal, planoEscolhido, reais, type PlanoComercial } from '@/lib/plano-comercial';

/**
 * Os helpers da vitrine — as contas que aparecem numa PÁGINA PÚBLICA.
 *
 * O desconto anunciado é o que o CDC cobra: por isso o piso (floor), nunca o
 * arredondamento para cima. 20,4% de desconto real anunciado como "20%" é
 * honestidade barata; como "21%" é propaganda enganosa.
 */

const MENSAL: PlanoComercial = {
  id: 'm',
  nome: 'Miner 250',
  descricao: null,
  processosPorCiclo: 250,
  precoCentavos: 79_900,
  intervaloMeses: 1,
};
const ANUAL: PlanoComercial = {
  id: 'a',
  nome: 'Miner 250 Anual',
  descricao: null,
  processosPorCiclo: 250,
  precoCentavos: 767_000,
  intervaloMeses: 12,
};

describe('descontoSobreMensal', () => {
  it('o anual de R$ 7.670 sobre 12×R$ 799 anuncia exatamente 20', () => {
    /* 9.588 → 7.670 = 20,004%. O piso segura no 20 — a promessa da migration. */
    expect(descontoSobreMensal([MENSAL, ANUAL], ANUAL)).toBe(20);
  });

  it('nunca arredonda para cima', () => {
    /* 20,99% de desconto real TEM de anunciar 20 — o centavo de erro fica do
       lado do cliente. */
    const quaseVinteUm = { ...ANUAL, precoCentavos: Math.round(79_900 * 12 * 0.7901) };
    expect(descontoSobreMensal([MENSAL, quaseVinteUm], quaseVinteUm)).toBe(20);
  });

  it('mensal não tem desconto; anual mais CARO que 12× o mensal também não', () => {
    expect(descontoSobreMensal([MENSAL, ANUAL], MENSAL)).toBeNull();
    const caro = { ...ANUAL, precoCentavos: 79_900 * 12 + 1 };
    expect(descontoSobreMensal([MENSAL, caro], caro)).toBeNull();
  });

  it('sem um mensal no catálogo, não inventa base de comparação', () => {
    expect(descontoSobreMensal([ANUAL], ANUAL)).toBeNull();
  });
});

describe('planoEscolhido', () => {
  it('acha pelo id do ?plano= da URL', () => {
    expect(planoEscolhido([MENSAL, ANUAL], 'a')).toBe(ANUAL);
  });

  it('id desconhecido cai no PRIMEIRO — nunca num formulário sem preço', () => {
    expect(planoEscolhido([MENSAL, ANUAL], 'nao-existe')).toBe(MENSAL);
    expect(planoEscolhido([MENSAL, ANUAL], undefined)).toBe(MENSAL);
  });

  it('catálogo vazio devolve null, e a tela cai no caminho de contato', () => {
    expect(planoEscolhido([], 'a')).toBeNull();
  });
});

describe('reais', () => {
  it('redondo sem centavos, quebrado com', () => {
    expect(reais(76_7000)).toContain('7.670');
    expect(reais(79_990)).toContain('799,90');
  });
});
