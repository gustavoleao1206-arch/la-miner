import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chaveColuna, lerCampos, valorDePlanilha } from './colunas-planilha';

describe('chaveColuna — normalização de cabeçalho', () => {
  it('ignora acento, caixa e pontuação', () => {
    const esperado = 'situacaodorequisitorio';
    expect(chaveColuna('Situação do Requisitório')).toBe(esperado);
    expect(chaveColuna('SITUACAO DO REQUISITORIO')).toBe(esperado);
    expect(chaveColuna('situacao_do_requisitorio')).toBe(esperado);
    expect(chaveColuna('Situação  do   Requisitório ')).toBe(esperado);
  });

  it('barra e ponto somem, e é isso que casa o cabeçalho real', () => {
    expect(chaveColuna('CPF do requerente/exequente')).toBe('cpfdorequerenteexequente');
    /* `º` não some: o NFKD o decompõe em `o`, então "Nº" e "No" caem na mesma
       chave — que é justamente o comportamento desejado num cabeçalho. */
    expect(chaveColuna('Nº do processo')).toBe('nodoprocesso');
  });
});

describe('lerCampos — resolução pelo perfil', () => {
  const mapa = {
    cpf: ['cpf', 'cpf do requerente', 'cpf do requerente/exequente'],
    valor: ['valor atualizado individual', 'valor'],
  };

  it('casa o cabeçalho da planilha com o alias do perfil', () => {
    const campo = lerCampos({ 'CPF do requerente/exequente': '529.982.247-25' }, mapa);
    expect(campo('cpf')).toBe('529.982.247-25');
  });

  /**
   * Regressão do defeito real: o perfil do TRF5 listava `cpf`,
   * `cpf do requerente`, `cpf/cnpj`, `documento` e `cpf requerente` — nenhum
   * normaliza para `cpfdorequerenteexequente`, que é o cabeçalho da planilha.
   * A importação pela API SEMPRE recusou o arquivo com "não encontrei a coluna
   * cpf", e ninguém notou porque a carteira entrou pelo seed, que lia rótulos
   * literais e contornava o perfil.
   */
  it('alias que não cobre o cabeçalho devolve null (o bug que existiu)', () => {
    const mapaAntigo = { cpf: ['cpf', 'cpf do requerente', 'cpf/cnpj', 'documento'] };
    const campo = lerCampos({ 'CPF do requerente/exequente': '529.982.247-25' }, mapaAntigo);
    expect(campo('cpf')).toBeNull();
  });

  it('a ORDEM do perfil decide quando a planilha tem as duas colunas', () => {
    const campo = lerCampos(
      { Valor: '10,00', 'Valor atualizado individual': '99,00' },
      mapa,
    );
    // 'valor atualizado individual' vem primeiro na lista do perfil.
    expect(campo('valor')).toBe('99,00');
  });

  it('célula vazia não conta: cai para o próximo alias', () => {
    const campo = lerCampos({ 'Valor atualizado individual': '   ', Valor: '42,00' }, mapa);
    expect(campo('valor')).toBe('42,00');
  });

  it('valor numérico vira texto aparado, sem perder o conteúdo', () => {
    const campo = lerCampos({ Valor: 919542.51 }, mapa);
    expect(campo('valor')).toBe('919542.51');
  });

  it('campo sem alias no perfil devolve null em vez de estourar', () => {
    const campo = lerCampos({ Qualquer: 'x' }, mapa);
    expect(campo('entidade')).toBeNull();
  });

  it('zero é conteúdo válido e não pode ser tratado como vazio', () => {
    const campo = lerCampos({ Valor: 0 }, mapa);
    expect(campo('valor')).toBe('0');
  });
});

describe('valorDePlanilha — formato brasileiro e americano', () => {
  /**
   * Assumir um dos dois formatos faria "1.234" virar 1,234 — um precatório de
   * mil reais lido como um real e vinte e três centavos. A decisão é pelo
   * ÚLTIMO separador.
   */
  it('formato brasileiro', () => {
    expect(valorDePlanilha('1.234,56')).toBe(1234.56);
    expect(valorDePlanilha('919.542,51')).toBe(919542.51);
    expect(valorDePlanilha('1.191.419.657,62')).toBe(1191419657.62);
  });

  it('formato americano', () => {
    expect(valorDePlanilha('1,234.56')).toBe(1234.56);
    expect(valorDePlanilha('919542.51')).toBe(919542.51);
  });

  it('sem separador decimal', () => {
    expect(valorDePlanilha('1234')).toBe(1234);
    // Só pontos, grupos de 3 dígitos: milhar brasileiro, não decimal americano.
    expect(valorDePlanilha('1.234')).toBe(1234);
    expect(valorDePlanilha('1.234.567')).toBe(1234567);
    // Mas 1 ou 2 casas continuam sendo decimal — dinheiro tem 2 casas.
    expect(valorDePlanilha('1.23')).toBe(1.23);
    expect(valorDePlanilha('1.2')).toBe(1.2);
  });

  it('ignora símbolo de moeda e espaço', () => {
    expect(valorDePlanilha('R$ 1.234,56')).toBe(1234.56);
  });

  it('nulo e lixo não viram número', () => {
    expect(valorDePlanilha(null)).toBeNull();
    expect(valorDePlanilha('')).toBeNull();
    expect(valorDePlanilha('sem valor')).toBeNull();
    expect(valorDePlanilha('-')).toBeNull();
    expect(valorDePlanilha('R$')).toBeNull();
  });

  it('negativo é preservado', () => {
    expect(valorDePlanilha('-1.234,56')).toBe(-1234.56);
  });
});

describe('colunas-planilha — espelho', () => {
  it('as duas cópias são byte a byte idênticas', () => {
    const daApi = readFileSync(join(__dirname, 'colunas-planilha.ts'), 'utf8');
    const doSeed = readFileSync(
      join(__dirname, '../../../../../packages/database/prisma/colunas-planilha.ts'),
      'utf8',
    );
    expect(doSeed).toBe(daApi);
  });
});
