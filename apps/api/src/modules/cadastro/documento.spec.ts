import { cnpjValido, cpfEmTexto, cpfValido, documentoValido, telefoneValido } from './documento';

/**
 * Os documentos abaixo são SINTÉTICOS: construídos para fechar o dígito
 * verificador, não pertencentes a ninguém. Usar um CPF real de um titular da
 * carteira num arquivo de teste — versionado, lido por qualquer um que clone o
 * repositório — seria vazar dado pessoal para economizar cinco minutos.
 */

describe('CPF', () => {
  it.each(['529.982.247-25', '52998224725', '111.444.777-35'])('aceita %s', (v) => {
    expect(cpfValido(v)).toBe(true);
  });

  it('recusa quando o primeiro dígito verificador está errado', () => {
    expect(cpfValido('529.982.247-15')).toBe(false);
  });

  it('recusa quando o segundo dígito verificador está errado', () => {
    expect(cpfValido('529.982.247-24')).toBe(false);
  });

  it.each(['00000000000', '11111111111', '99999999999'])(
    'recusa a repetição %s, que FECHA a conta mas não é CPF',
    (v) => {
      /* O algoritmo do módulo 11 valida estes números. Sem a checagem separada
         de repetição, "11111111111" entraria — e é exatamente o que se digita
         para pular um campo obrigatório. */
      expect(cpfValido(v)).toBe(false);
    },
  );

  it.each(['5299822472', '529982247256', ''])('recusa tamanho errado (%s)', (v) => {
    expect(cpfValido(v)).toBe(false);
  });
});

describe('CNPJ', () => {
  it.each(['11.222.333/0001-81', '11222333000181'])('aceita %s', (v) => {
    expect(cnpjValido(v)).toBe(true);
  });

  it('recusa dígito verificador errado', () => {
    expect(cnpjValido('11.222.333/0001-82')).toBe(false);
  });

  it('recusa repetição', () => {
    expect(cnpjValido('11111111111111')).toBe(false);
  });

  it('NÃO aceita um CPF válido como CNPJ — o tamanho decide', () => {
    expect(cnpjValido('52998224725')).toBe(false);
  });

  it('usa os pesos cíclicos do CNPJ, não os do CPF', () => {
    /* Se alguém reaproveitar a sequência decrescente do CPF aqui, este número
       (montado com os pesos certos) passa a ser recusado. É a mutação mais
       provável deste arquivo, e a que valida documento falso em produção. */
    expect(cnpjValido('11222333000181')).toBe(true);
  });
});

describe('documentoValido — o que o Asaas aceita', () => {
  it('aceita CPF de 11 e CNPJ de 14', () => {
    expect(documentoValido('529.982.247-25')).toBe(true);
    expect(documentoValido('11.222.333/0001-81')).toBe(true);
  });

  it.each(['123', '5299822472512345', 'abcdefghijk'])('recusa %s', (v) => {
    expect(documentoValido(v)).toBe(false);
  });
});

describe('telefone', () => {
  it.each(['(81) 99999-8888', '81999998888', '8133334444'])('aceita %s', (v) => {
    expect(telefoneValido(v)).toBe(true);
  });

  it('recusa DDD inexistente — não há DDD abaixo de 11', () => {
    expect(telefoneValido('0199998888')).toBe(false);
    expect(telefoneValido('00000000000')).toBe(false);
  });

  it('recusa celular de 11 dígitos que não começa com 9 após o DDD', () => {
    /* Celular no Brasil tem o nono dígito. Um 11 dígitos sem ele é digitação
       errada — provavelmente um fixo com um algarismo a mais. */
    expect(telefoneValido('81899998888')).toBe(false);
  });

  it.each(['999998888', '819999988888'])('recusa tamanho %s', (v) => {
    expect(telefoneValido(v)).toBe(false);
  });
});

/**
 * ── `cpfEmTexto`: A PENEIRA QUE SÓ FUNCIONA NO TAMANHO CERTO ──
 *
 * Esta função existe para a retenção do termo de busca: antes de descartar o
 * texto digitado, o CPF que estivesse só ali é promovido para a coluna
 * estruturada, para o titular não perder essa consulta na trilha do art. 18.
 *
 * A primeira versão deslizava uma janela de 11 dígitos dentro de corridas
 * maiores, confiando no dígito verificador. Medido, o verificador só peneira
 * bem quando a corrida TEM 11 dígitos (1% de falso positivo); dentro de uma
 * corrida de 20 ele deixa passar 8,8%, e num número de precatório do TRF5
 * colado sem máscara, 26,1% — concentrados em pouquíssimos valores, porque a
 * cauda do tribunal/ano se repete. Seria uma máquina de carimbar o mesmo CPF
 * inexistente em milhares de linhas de auditoria.
 */
describe('cpfEmTexto', () => {
  const CPF = '52998224725';

  it('acha o CPF sozinho', () => {
    expect(cpfEmTexto(CPF)).toBe(CPF);
  });

  it('acha o CPF separado de outros números por espaço', () => {
    /* O caso que motiva a função: CPF mais DDD, digitado junto na busca. */
    expect(cpfEmTexto(`${CPF} 81`)).toBe(CPF);
    expect(cpfEmTexto(`cpf ${CPF}, tel 81`)).toBe(CPF);
  });

  it('NÃO inventa CPF dentro de número de precatório colado sem máscara', () => {
    /* O fantasma. 20 dígitos contíguos: deslizar aqui produzia acerto em 26%
       dos números reais do TRF5. */
    expect(cpfEmTexto('99000014820254050000')).toBeNull();
  });

  it('DESISTE de corrida longa mesmo contendo um CPF válido, e isso é a decisão certa', () => {
    /* Numa corrida de 13 a janela deslizante devolvia a posição ERRADA em 10%
       dos prefixos — inventava um CPF e perdia o verdadeiro. Numa trilha de
       prestação de contas, não achar é recuperável; achar errado não é. */
    expect(cpfEmTexto(`12${CPF}`)).toBeNull();
  });

  it('recusa 11 dígitos que não fecham o verificador', () => {
    expect(cpfEmTexto('81999998888')).toBeNull();
  });

  it('texto sem dígito nenhum não quebra', () => {
    expect(cpfEmTexto('MARIA DE SOUZA')).toBeNull();
    expect(cpfEmTexto('')).toBeNull();
  });
});
