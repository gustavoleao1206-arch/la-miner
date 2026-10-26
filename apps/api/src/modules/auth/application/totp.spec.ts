import {
  conferirCodigo,
  deBase32,
  gerarCodigo,
  gerarSegredo,
  paraBase32,
  uriDeProvisionamento,
} from './totp';

/**
 * ── OS VETORES OFICIAIS DA RFC 6238 ──
 *
 * É este bloco que justifica ter escrito o TOTP em vez de instalar uma
 * biblioteca. Uma biblioteca de terceiro seria verificada exatamente assim; a
 * diferença é que aqui a verificação está no repositório, roda no CI e falha se
 * alguém "otimizar" o truncamento.
 *
 * Apêndice B da RFC: sementes ASCII conhecidas, seis instantes, três
 * algoritmos, códigos de 8 dígitos. Dezoito respostas que não admitem
 * interpretação.
 *
 * As sementes entram como ASCII e são convertidas para Base32 aqui — então
 * cada caso exercita TAMBÉM o codificador, que é o outro lugar onde um erro
 * silencioso caberia.
 */
describe('TOTP — vetores da RFC 6238', () => {
  const semente = (texto: string) => paraBase32(Buffer.from(texto, 'ascii'));

  const SEMENTES = {
    sha1: semente('12345678901234567890'),
    sha256: semente('12345678901234567890123456789012'),
    sha512: semente('1234567890123456789012345678901234567890123456789012345678901234'),
  } as const;

  /* [instante, sha1, sha256, sha512] — transcritos do apêndice B. */
  const VETORES: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  it.each(VETORES)('T=%i confere nos três algoritmos', (t, sha1, sha256, sha512) => {
    const opcoes = { digitos: 8, periodoSegundos: 30 } as const;
    expect(gerarCodigo(SEMENTES.sha1, t, { ...opcoes, algoritmo: 'sha1' })).toBe(sha1);
    expect(gerarCodigo(SEMENTES.sha256, t, { ...opcoes, algoritmo: 'sha256' })).toBe(sha256);
    expect(gerarCodigo(SEMENTES.sha512, t, { ...opcoes, algoritmo: 'sha512' })).toBe(sha512);
  });

  it('o código de 6 dígitos é o de 8 truncado à direita', () => {
    /* Confirma que `digitos` opera no módulo, e não num corte de string: o
       94287082 de T=59 tem de virar 287082, não 942870. */
    expect(gerarCodigo(SEMENTES.sha1, 59, { digitos: 6, algoritmo: 'sha1' })).toBe('287082');
  });
});

describe('Base32', () => {
  it('ida e volta preserva os bytes', () => {
    for (const n of [1, 5, 10, 20, 32, 64]) {
      const original = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37) % 256));
      expect(deBase32(paraBase32(original))).toEqual(original);
    }
  });

  it('aceita o que a pessoa digita: minúsculas, espaços e padding', () => {
    /* O app mostra o segredo em grupos de quatro. Recusar por causa disso
       transformaria formatação em "código inválido" — e o usuário culparia o
       sistema, não o espaço. */
    const s = paraBase32(Buffer.from('12345678901234567890', 'ascii'));
    const digitado = s.toLowerCase().replace(/(.{4})/g, '$1 ').trim() + '==';
    expect(deBase32(digitado)).toEqual(deBase32(s));
  });

  it('caractere fora do alfabeto é recusado, não ignorado', () => {
    /* Ignorar em silêncio produziria um segredo DIFERENTE do que a pessoa
       cadastrou, e o erro apareceria como "código nunca confere". */
    expect(() => deBase32('ABC1DEF')).toThrow(/inválido/i);
  });
});

describe('conferirCodigo', () => {
  const segredo = paraBase32(Buffer.from('12345678901234567890', 'ascii'));
  const agora = 1_700_000_000;

  it('aceita o código do momento', () => {
    expect(conferirCodigo(segredo, gerarCodigo(segredo, agora), agora)).toBe(true);
  });

  it('tolera relógio adiantado ou atrasado em um período', () => {
    /* Sem tolerância, quem digita no fim do ciclo é recusado com o código
       CERTO — e conclui que o MFA está quebrado. */
    expect(conferirCodigo(segredo, gerarCodigo(segredo, agora - 30), agora)).toBe(true);
    expect(conferirCodigo(segredo, gerarCodigo(segredo, agora + 30), agora)).toBe(true);
  });

  it('RECUSA além da janela', () => {
    /* A outra borda. Cada período aceito a mais é uma janela a mais para um
       código interceptado — tolerância generosa demais é o mesmo que não ter. */
    expect(conferirCodigo(segredo, gerarCodigo(segredo, agora - 60), agora)).toBe(false);
    expect(conferirCodigo(segredo, gerarCodigo(segredo, agora + 60), agora)).toBe(false);
  });

  it('recusa código errado, vazio, curto e não numérico', () => {
    for (const ruim of ['000000', '', '12345', '1234567', 'abcdef', null as never]) {
      expect(conferirCodigo(segredo, ruim, agora)).toBe(false);
    }
  });

  it('recusa o código de OUTRO segredo', () => {
    const outro = gerarSegredo();
    expect(conferirCodigo(segredo, gerarCodigo(outro, agora), agora)).toBe(false);
  });

  it('o segredo gerado tem 160 bits, como a RFC 4226 recomenda', () => {
    expect(deBase32(gerarSegredo())).toHaveLength(20);
    // E dois segredos nunca saem iguais.
    expect(gerarSegredo()).not.toBe(gerarSegredo());
  });
});

describe('uriDeProvisionamento', () => {
  it('monta a URI que o app autenticador entende', () => {
    const uri = uriDeProvisionamento({
      segredoBase32: 'JBSWY3DPEHPK3PXP',
      conta: 'admin@exemplo.com.br',
      emissor: 'Leão Amorim Miner',
    });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const u = new URL(uri);
    expect(u.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    /* O issuer vai no rótulo E no parâmetro: os apps divergem sobre qual leem,
       e sem os dois a conta entra na lista sem nome. */
    expect(u.searchParams.get('issuer')).toBe('Leão Amorim Miner');
    expect(decodeURIComponent(u.pathname)).toContain('Leão Amorim Miner:admin@exemplo.com.br');
  });
});
