import { candidatosDoNome, conferirNome, tokensDoNome } from './conferencia-de-nome';

/**
 * A conferência que transforma "titular identificado" em estado, e não promessa.
 *
 * O CPF dos pré-precatórios é EXTRAÍDO DE TEXTO — dígito verificador válido prova
 * que o número é bem formado, não que seja daquele credor. A Contactra devolve o
 * nome de quem realmente tem o CPF, e comparar os dois é a verificação.
 *
 * O calibre destes casos é o ponto: frouxo para não gritar sobre variação
 * inocente, firme para pegar o CPF de outra pessoa.
 */
describe('conferirNome', () => {
  describe('CONFERE — variação inocente não pode virar alarme', () => {
    it.each([
      ['idêntico', 'MARIA DE SOUZA SANTOS', 'MARIA DE SOUZA SANTOS'],
      ['acento e caixa', 'José Antônio Pereira', 'JOSE ANTONIO PEREIRA'],
      ['pontuação', "JOSE D'AVILA LIMA", 'JOSE D AVILA LIMA'],
      ['inicial abreviada no meio', 'MARIA A. DOS SANTOS', 'MARIA APARECIDA DOS SANTOS'],
      ['um lado tem sobrenome a mais', 'JOAO PEREIRA', 'JOAO PEREIRA DA SILVA'],
      ['conectivos diferentes', 'ANA DOS SANTOS', 'ANA SANTOS'],
      ['espaço duplicado', 'CARLOS  MELLO', 'CARLOS MELLO'],
    ])('%s', (_caso, planilha, provedor) => {
      expect(conferirNome(planilha, provedor)).toBe('CONFERE');
    });

    it('nome de UM token só: basta o primeiro bater', () => {
      /* Não há sobrenome para comparar. Exigir mais seria inventar rigor sobre
         dado que não existe, e produziria divergência falsa. */
      expect(conferirNome('MARIA', 'MARIA DE SOUZA')).toBe('CONFERE');
      expect(conferirNome('MARIA DE SOUZA', 'MARIA')).toBe('CONFERE');
    });

    it('sem nada para comparar, devolve NAO_CONFERIDO — nem acusa, nem afirma', () => {
      /* Devolvia CONFERE até 10/09/2026, e isso era confiança fabricada: o
         neutro não é "conferi e bate", é "não deu para conferir". Nenhum dos
         dois desenha aviso na tela — só o DIVERGE desenha —, então o objetivo
         de não gritar sobre o nada continua atendido. */
      expect(conferirNome('', 'MARIA DE SOUZA')).toBe('NAO_CONFERIDO');
      expect(conferirNome('MARIA DE SOUZA', '')).toBe('NAO_CONFERIDO');
      expect(conferirNome('DE DA DOS', 'MARIA')).toBe('NAO_CONFERIDO');
    });

    it('nome de INICIAIS não pode sair como conferido', () => {
      /* Medido: 41 dos 1.169 pré-precatórios estavam CONFERE com nome assim.
         É como o tribunal anonimiza menor de idade e segredo de justiça —
         `tokensDoNome` descarta token de uma letra, então não sobra nada com que
         comparar, e afirmar que o CPF é daquela pessoa era invenção. */
      expect(conferirNome('M.A.V.', 'MARIA APARECIDA VIEIRA')).toBe('NAO_CONFERIDO');
      expect(conferirNome('T.S.L.D.O.', 'TIAGO SOUZA LIMA DE OLIVEIRA')).toBe('NAO_CONFERIDO');
    });
  });

  describe('DIVERGE — o caso que isto existe para pegar', () => {
    it('pessoas completamente diferentes', () => {
      /* O CPF de outra pessoa, colhido do mesmo despacho. É o modo de falha que
         a própria fonte descreve: "documento errado ao lado de um nome é pior
         que documento nenhum". */
      expect(conferirNome('JOAO PEREIRA SILVA', 'MARIA SANTOS COSTA')).toBe('DIVERGE');
    });

    it('primeiro nome igual, mas nenhum sobrenome em comum', () => {
      /* Dois "JOSÉ" diferentes no mesmo processo é exatamente o cenário de
         polo ativo com vários credores — o que a fonte diz descartar. */
      expect(conferirNome('JOSE PEREIRA LIMA', 'JOSE SANTOS COSTA')).toBe('DIVERGE');
    });

    it('sobrenome igual não salva primeiro nome diferente', () => {
      /* Parentes no mesmo processo: pai e filho, ou irmãos. O sobrenome bate e a
         pessoa é outra — e é justamente quem mais aparece junto num despacho. */
      expect(conferirNome('CARLOS DE SOUZA', 'MARIA DE SOUZA')).toBe('DIVERGE');
    });
  });
});

describe('célula com VÁRIOS credores — o caso dos pré-precatórios', () => {
  /* A planilha empilha credores numa coluna só, separados por vírgula. Medido em
     produção em 08/09/2026: 192 dos 1.169. Como `tokensDoNome` remove
     pontuação, comparar a célula inteira jogava os sobrenomes de todo mundo num
     saco só — e errava nas DUAS direções. */

  it('sobrenome do OUTRO credor não valida o CPF do primeiro', () => {
    /* O lado FROUXO. "KESSLER" é sobrenome do segundo da lista; sozinho, "OTAVIO
       SANTOS KESSLER" não tem nada a ver com "OTAVIO BRANDAO DE ARRUDA". Antes da
       correção isto dava CONFERE, porque os dois nomes viravam um só. */
    expect(conferirNome('OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER', 'OTAVIO SANTOS KESSLER')).toBe(
      'DIVERGE',
    );
  });

  it('o CPF pode ser do SEGUNDO nome da lista', () => {
    /* O lado RÍGIDO, e o mais caro: o primeiro token da célula era o único
       primeiro nome aceito, então o dono legítimo do CPF caía como divergente e
       o processo ia parar na lista de bloqueados por defeito da comparação. */
    expect(conferirNome('OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER', 'RUBENS KESSLER')).toBe('CONFERE');
  });

  it('o primeiro da lista continua conferindo', () => {
    expect(conferirNome('OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER', 'OTAVIO BRANDAO DE ARRUDA')).toBe(
      'CONFERE',
    );
  });

  it('nenhum dos listados bate: segue DIVERGE', () => {
    expect(conferirNome('OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER', 'MARIA SANTOS COSTA')).toBe(
      'DIVERGE',
    );
  });

  it('empresa na mesma célula não atrapalha a pessoa física', () => {
    /* Formato comum na base: "HELIO DE CASTRO VALADARES, TRANSPORTADORA EXEMPLO - SERVICOS E
       TRANSPORTE RODOVIARIO LTDA". */
    expect(
      conferirNome(
        'HELIO DE CASTRO VALADARES, TRANSPORTADORA EXEMPLO - SERVICOS E TRANSPORTE RODOVIARIO LTDA',
        'HELIO DE CASTRO VALADARES',
      ),
    ).toBe('CONFERE');
  });

  it('sem vírgula, o comportamento é o de sempre', () => {
    /* A trava contra regressão silenciosa: a correção não pode mudar o veredito
       de nenhum nome de uma pessoa só, que é a maioria da base. */
    expect(conferirNome('JOSE PEREIRA LIMA', 'JOSE SANTOS COSTA')).toBe('DIVERGE');
    expect(conferirNome('MARIA DE SOUZA SANTOS', 'MARIA DE SOUZA SANTOS')).toBe('CONFERE');
  });
});

describe('candidatosDoNome', () => {
  it('parte por vírgula e descarta segmento sem nome', () => {
    expect(candidatosDoNome('OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER,  , DE')).toEqual([
      'OTAVIO BRANDAO DE ARRUDA',
      'RUBENS KESSLER',
    ]);
  });

  it('NÃO parte por " E " — ele é conectivo dentro do nome', () => {
    /* Partir por " E " transformaria "MARIA SOUZA E SILVA" em dois credores. */
    expect(candidatosDoNome('MARIA SOUZA E SILVA')).toEqual(['MARIA SOUZA E SILVA']);
  });
});

describe('tokensDoNome', () => {
  it('descarta conectivos e iniciais soltas', () => {
    expect(tokensDoNome('MARIA A. DOS SANTOS E SILVA')).toEqual(['MARIA', 'SANTOS', 'SILVA']);
  });

  it('normaliza acento, caixa e pontuação', () => {
    expect(tokensDoNome("José D'Ávila-Neto")).toEqual(['JOSE', 'AVILA', 'NETO']);
  });
});
