import { cifrarSegredo, decifrarSegredo } from './segredo-cifrado';

const CHAVE = 'chave-de-teste-com-tamanho-suficiente-1234567890';
const OUTRA = 'outra-chave-de-teste-igualmente-longa-0987654321';

describe('segredo cifrado (AES-256-GCM)', () => {
  const segredo = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  it('ida e volta devolve o mesmo segredo', () => {
    expect(decifrarSegredo(cifrarSegredo(segredo, CHAVE), CHAVE)).toBe(segredo);
  });

  it('o texto cifrado NÃO contém o segredo', () => {
    /* Óbvio? É a asserção que pega o dia em que alguém "simplifica" para
       base64 e acha que cifrou. */
    const guardado = cifrarSegredo(segredo, CHAVE);
    expect(guardado).not.toContain(segredo);
    expect(Buffer.from(guardado, 'utf8').toString('hex')).not.toContain(
      Buffer.from(segredo).toString('hex'),
    );
  });

  it('cifrar duas vezes o MESMO segredo dá saídas diferentes', () => {
    /* IV aleatório por operação. Sem ele, saídas iguais denunciariam quais
       usuários compartilham segredo — e, pior, abririam a porta para os ataques
       que reuso de nonce permite no GCM. */
    expect(cifrarSegredo(segredo, CHAVE)).not.toBe(cifrarSegredo(segredo, CHAVE));
  });

  it('chave ERRADA falha alto, não devolve lixo', () => {
    /* É o ganho do GCM sobre o CBC. Com CBC, decifrar com a chave errada
       produziria bytes quaisquer que passariam por segredo válido — e todo
       código do usuário seria recusado sem que nada indicasse a causa. */
    const guardado = cifrarSegredo(segredo, CHAVE);
    expect(() => decifrarSegredo(guardado, OUTRA)).toThrow();
  });

  it('adulterar o texto cifrado é detectado', () => {
    const partes = cifrarSegredo(segredo, CHAVE).split('.');
    /* Um byte trocado no corpo cifrado. A tag de autenticação não fecha. */
    const corpo = Buffer.from(partes[3], 'base64url');
    corpo[0] ^= 0xff;
    partes[3] = corpo.toString('base64url');

    expect(() => decifrarSegredo(partes.join('.'), CHAVE)).toThrow();
  });

  it('adulterar a TAG também é detectado', () => {
    const partes = cifrarSegredo(segredo, CHAVE).split('.');
    const tag = Buffer.from(partes[2], 'base64url');
    tag[0] ^= 0xff;
    partes[2] = tag.toString('base64url');

    expect(() => decifrarSegredo(partes.join('.'), CHAVE)).toThrow();
  });

  it('formato desconhecido é recusado com mensagem clara', () => {
    /* O prefixo de versão existe para o dia em que a cifra mudar. Sem esta
       recusa, um formato antigo viraria erro de criptografia sem explicação. */
    for (const ruim of ['', 'texto-solto', 'v2.a.b.c', 'v1.a.b']) {
      expect(() => decifrarSegredo(ruim, CHAVE)).toThrow(/formato desconhecido/i);
    }
  });
});
