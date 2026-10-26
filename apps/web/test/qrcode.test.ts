import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  caminhoSvg,
  informacaoDeFormato,
  informacaoDeVersao,
  ladoComMargem,
  matrizComMascara,
  matrizQr,
  penalidades,
} from '@/lib/qrcode';

/**
 * O codificador de QR.
 *
 * ── COMO ISTO FOI VERIFICADO, E POR QUE ESTES TESTES SÃO O QUE SÃO ──
 *
 * Diferente do TOTP, o padrão de QR não publica vetores de teste. A verificação
 * de verdade aconteceu FORA daqui, contra duas bases de código independentes,
 * instaladas fora do repositório só para isso:
 *
 *   • contra o codificador `qrcode` do npm, MÓDULO A MÓDULO: 2.002 payloads de
 *     todo comprimento entre 1 e 666 bytes, cobrindo as 20 versões, mais 56
 *     comparações com a máscara forçada nos dois lados. As 56 forçadas batem
 *     100% — é isso que prova a codificação, os corretores, a intercalação, a
 *     colocação em zigue-zague, o formato e a informação de versão. Das 2.002
 *     automáticas, 18 escolhem outra MÁSCARA, e as 18 estão explicadas: a
 *     biblioteca diverge do padrão na regra 4 (ver o teste dela abaixo).
 *   • contra o decodificador `jsQR`, no sentido inverso: os 666 comprimentos
 *     gerados e LIDOS DE VOLTA, idênticos, mais as 8 máscaras e as URIs reais.
 *     Bater com outro codificador não prova que o QR seja legível — só um
 *     decodificador prova.
 *
 * O que fica AQUI é o que roda no CI sem dependência nenhuma: os valores
 * publicados pelo padrão, as fronteiras de capacidade, e matrizes congeladas
 * daquela conferência. Não substituem a verificação externa; pegam a regressão.
 */

const comoTexto = (m: boolean[][]) => m.map((l) => l.map((v) => (v ? '#' : '.')).join('')).join('\n');
const resumo = (m: boolean[][]) => createHash('sha256').update(comoTexto(m)).digest('hex').slice(0, 16);

/** A URI que a API devolve no cadastro do segundo fator. */
const URI_REAL =
  'otpauth://totp/Le%C3%A3o%20Amorim%20Miner%3Ateste%40exemplo.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Le%C3%A3o+Amorim+Miner&algorithm=SHA1&digits=6&period=30';

describe('informação de formato — a tabela do padrão, as 32 combinações', () => {
  /**
   * Estes 32 valores são PUBLICADOS pela ISO/IEC 18004, não gerados por este
   * código. É o vetor de teste mais próximo do que a norma oferece: se o BCH ou
   * a máscara final de XOR estiverem errados, nenhum leitor descobre a máscara
   * do símbolo — e o QR inteiro se perde, mesmo com todo o resto certo.
   */
  const PUBLICADOS: Record<string, [number, number[]]> = {
    L: [0b01, [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976]],
    M: [0b00, [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0]],
    Q: [0b11, [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed]],
    H: [0b10, [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b]],
  };

  for (const [nome, [bits, esperados]] of Object.entries(PUBLICADOS)) {
    it(`nível ${nome}, as 8 máscaras`, () => {
      expect(esperados.map((_, m) => informacaoDeFormato(bits, m))).toEqual(esperados);
    });
  }
});

describe('informação de versão — publicada para v7 a v40', () => {
  /* Só existe da versão 7 em diante: abaixo disso o leitor descobre a versão
     contando os módulos, e o padrão não gasta 36 módulos com o que já se sabe. */
  const PUBLICADOS: Record<number, number> = {
    7: 0x07c94,
    8: 0x085bc,
    9: 0x09a99,
    10: 0x0a4d3,
    11: 0x0bbf6,
    12: 0x0c762,
    13: 0x0d847,
    14: 0x0e60d,
    15: 0x0f928,
    16: 0x10b78,
    17: 0x1145d,
    18: 0x12a17,
    19: 0x13532,
    20: 0x149a6,
  };

  it('v7 a v20 batem com a tabela', () => {
    for (const [versao, esperado] of Object.entries(PUBLICADOS)) {
      expect(informacaoDeVersao(Number(versao))).toBe(esperado);
    }
  });
});

/**
 * As fronteiras de capacidade — o teste que confere a tabela de correção.
 *
 * Cada número aqui é a capacidade em bytes que o padrão publica para o nível M.
 * Errar UM par (corretores, blocos) da tabela desloca a fronteira, e é
 * exatamente o modo de falha de um codificador escrito à mão. Um byte a mais
 * tem de empurrar para a versão seguinte, nunca antes.
 */
describe('escolha de versão nas fronteiras da tabela de capacidade', () => {
  const versaoDe = (bytes: number) => (matrizQr('a'.repeat(bytes)).length - 17) / 4;

  it.each([
    [14, 1],
    [15, 2],
    [26, 2],
    [27, 3],
    [42, 3],
    [43, 4],
    [122, 7],
    [123, 8],
    [180, 9],
    [181, 10],
    [213, 10],
    [214, 11],
    [666, 20],
  ])('%i bytes cabem na versão %i', (bytes, versao) => {
    expect(versaoDe(bytes)).toBe(versao);
  });

  it('acima da versão 20 lança, em vez de gerar um QR torto', () => {
    expect(() => matrizQr('a'.repeat(667))).toThrow(/longo demais/);
  });
});

describe('matrizes congeladas', () => {
  /**
   * A grade inteira, legível.
   *
   * Foi conferida módulo a módulo contra o codificador de referência. Está por
   * extenso, e não como resumo, porque uma regressão aqui precisa ser
   * DIAGNOSTICÁVEL: o diff mostra onde o desenho mudou.
   */
  it('"HELLO WORLD" desenha a grade v1 esperada', () => {
    expect(comoTexto(matrizQr('HELLO WORLD'))).toBe(
      [
        '#######.##..#.#######',
        '#.....#....#..#.....#',
        '#.###.#..#.#..#.###.#',
        '#.###.#.#..#..#.###.#',
        '#.###.#.###.#.#.###.#',
        '#.....#.#..#..#.....#',
        '#######.#.#.#.#######',
        '........#..##........',
        '#...#.######.#####..#',
        '...#....#.###....####',
        '..######..##.##.#..#.',
        '#####...##...#.......',
        '#####.#.#.#.#.##..##.',
        '........#.#.####.#.##',
        '#######.###.#.#.##.#.',
        '#.....#..#.###.##..##',
        '#.###.#.##.#.##...##.',
        '#.###.#..#..#...##.##',
        '#.###.#..###...###...',
        '#.....#....#.#.......',
        '#######.#########.#.#',
      ].join('\n'),
    );
  });

  /* As grandes ficam como resumo: por extenso seriam 9.409 caracteres para a
     versão 20, e ninguém leria o diff mesmo. Todas conferidas contra a
     referência na mesma passada. */
  it.each([
    ['a URI real do MINER', URI_REAL, 53, 'c30095acc04638da'],
    ['v2', 'x'.repeat(20), 25, '2d76870525e203e3'],
    ['v5', 'y'.repeat(80), 37, '8d18352aefb61eaf'],
    ['v9', 'z'.repeat(175), 53, '65ba7e12b3cd0267'],
    ['v10 (onde a contagem passa a 16 bits)', 'w'.repeat(200), 57, 'f94e4d6ad9499426'],
    ['v15', 'k'.repeat(400), 77, '8640bf6bfd34a80e'],
    ['v20', 'q'.repeat(660), 97, '29abc6cd71f732b5'],
  ])('%s', (_nome, texto, lado, digest) => {
    const m = matrizQr(texto);
    expect(m.length).toBe(lado);
    expect(resumo(m)).toBe(digest);
  });
});

describe('estrutura do símbolo', () => {
  const m = matrizQr(URI_REAL);
  const lado = m.length;

  it('os três localizadores estão nos cantos, com o anel e o miolo certos', () => {
    for (const [l0, c0] of [
      [0, 0],
      [0, lado - 7],
      [lado - 7, 0],
    ]) {
      for (let l = 0; l < 7; l++) {
        for (let c = 0; c < 7; c++) {
          const anel = l === 0 || l === 6 || c === 0 || c === 6;
          const miolo = l >= 2 && l <= 4 && c >= 2 && c <= 4;
          expect(m[l0 + l][c0 + c]).toBe(anel || miolo);
        }
      }
    }
  });

  it('o quarto canto NÃO tem localizador — é o que dá orientação ao leitor', () => {
    /* Três cantos marcados e um livre é o que permite ao aplicativo saber se o
       telefone está de cabeça para baixo. Se os quatro tivessem localizador, o
       símbolo seria simétrico e a leitura viria embaralhada. */
    const localizador = Array.from({ length: 7 }, (_, l) =>
      Array.from(
        { length: 7 },
        (_, c) => l === 0 || l === 6 || c === 0 || c === 6 || (l >= 2 && l <= 4 && c >= 2 && c <= 4),
      ),
    );
    const cantoLivre = m.slice(lado - 7).map((l) => l.slice(lado - 7));
    expect(comoTexto(cantoLivre)).not.toBe(comoTexto(localizador));
  });

  it('o sincronismo alterna nas duas réguas', () => {
    for (let i = 8; i < lado - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
  });

  it('o módulo escuro fixo está aceso', () => {
    expect(m[lado - 8][8]).toBe(true);
  });

  it('a matriz é quadrada e do tamanho 4·versão+17', () => {
    expect(m.every((linha) => linha.length === lado)).toBe(true);
    expect((lado - 17) % 4).toBe(0);
  });
});

describe('máscaras', () => {
  it('o resultado de matrizQr é uma das oito, e não uma nona coisa', () => {
    const escolhida = matrizQr(URI_REAL);
    const candidatas = Array.from({ length: 8 }, (_, m) => comoTexto(matrizComMascara(URI_REAL, m)));
    expect(candidatas).toContain(comoTexto(escolhida));
  });

  it('fica com a de menor penalidade', () => {
    const notas = Array.from({ length: 8 }, (_, m) => penalidades(matrizComMascara(URI_REAL, m)).total);
    const menor = Math.min(...notas);
    expect(penalidades(matrizQr(URI_REAL)).total).toBe(menor);
  });
});

describe('penalidades', () => {
  const grade = (linhas: string[]) => linhas.map((l) => [...l].map((c) => c === '#'));
  const vazia = (n: number) => Array.from({ length: n }, () => Array(n).fill(false));

  it('regra 1: corrida de 5 vale 3, e cada módulo a mais soma 1', () => {
    /* Numa grade 5×5 toda clara: 5 linhas × 3 + 5 colunas × 3 = 30. */
    expect(penalidades(vazia(5)).r1).toBe(30);
  });

  it('regra 2: cada bloco 2×2 de uma cor só vale 3', () => {
    // 3×3 toda clara tem quatro blocos 2×2 sobrepostos.
    expect(penalidades(vazia(3)).r2).toBe(12);
  });

  it('regra 3: a sequência que imita o localizador vale 40', () => {
    /* 1:1:3:1:1 com quatro claros de um lado — de longe, a câmera confunde isto
       com um padrão localizador e tenta se orientar pelo lugar errado. */
    const comPadrao = grade([
      '#.###.#....',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
    ]);
    const semPadrao = grade(Array(11).fill('...........'));
    expect(penalidades(comPadrao).r3 - penalidades(semPadrao).r3).toBe(40);
  });

  /**
   * A regra 4 segue a ISO, e não a biblioteca de referência — de propósito.
   *
   * O procedimento do padrão é ficar com a MENOR distância entre os múltiplos de
   * 5 vizinhos e 50%. Uma proporção de 52% de escuros está a 2 pontos de 50: o
   * múltiplo anterior é o próprio 50, distância zero, penalidade zero. A
   * biblioteca `qrcode` do npm calcula `|ceil(proporção/5) − 10|`, que cria um
   * degrau logo acima de 50% e cobra 10 pontos de 52% — o mesmo que cobra de
   * 55%. Foi a ÚNICA divergência encontrada na conferência, e o motivo de 18 das
   * 2.002 comparações escolherem outra máscara.
   */
  it('regra 4: 52% de escuros não é punido; a partir de 55% é', () => {
    const comEscuros = (n: number, quantos: number) => {
      const g = vazia(n);
      for (let i = 0; i < quantos; i++) g[Math.floor(i / n)][i % n] = true;
      return g;
    };
    // 10×10 = 100 módulos: 52 escuros = 52%, 55 escuros = 55%.
    expect(penalidades(comEscuros(10, 50)).r4).toBe(0);
    expect(penalidades(comEscuros(10, 52)).r4).toBe(0);
    expect(penalidades(comEscuros(10, 55)).r4).toBe(10);
    expect(penalidades(comEscuros(10, 45)).r4).toBe(10);
    expect(penalidades(comEscuros(10, 60)).r4).toBe(20);
  });

  it('total é a soma das quatro', () => {
    const p = penalidades(matrizQr(URI_REAL));
    expect(p.total).toBe(p.r1 + p.r2 + p.r3 + p.r4);
  });
});

describe('caminhoSvg', () => {
  it('une módulos vizinhos numa corrida só', () => {
    const m = [
      [true, true, true],
      [false, false, false],
      [true, false, true],
    ];
    /* Três subcaminhos, não cinco: a primeira linha vira UM retângulo de
       largura 3. É essa união que evita milhares de nós no DOM. */
    expect(caminhoSvg(m, 0)).toBe('M0 0h3v1h-3zM0 2h1v1h-1zM2 2h1v1h-1z');
  });

  it('desloca tudo pela margem, que é a zona de silêncio', () => {
    expect(caminhoSvg([[true]], 4)).toBe('M4 4h1v1h-1z');
  });

  it('matriz vazia não gera caminho nenhum', () => {
    expect(caminhoSvg([[false, false], [false, false]])).toBe('');
  });

  it('o lado do viewBox inclui as duas margens', () => {
    /**
     * A zona de silêncio de 4 módulos é EXIGÊNCIA do padrão, não estética. Sem
     * ela encostada em outro conteúdo, o leitor não acha a borda do símbolo — e
     * o QR simplesmente não escaneia, sem dar pista do motivo.
     */
    expect(ladoComMargem(matrizQr('HELLO WORLD'))).toBe(21 + 8);
  });

  /**
   * Este teste existe porque a suíte passou calada quando a margem PADRÃO do
   * `caminhoSvg` foi zerada de propósito: os outros testes passavam a margem
   * explicitamente, e nenhum exercitava o valor de fábrica.
   *
   * O que ele protege é a CONCORDÂNCIA entre as duas funções. Elas têm padrões
   * separados, e divergir é o pior caso possível: o desenho sairia encostado num
   * canto de um quadro grande demais, o QR ainda escanearia às vezes — e "às
   * vezes" é o defeito que ninguém consegue reproduzir.
   */
  it('o desenho e o viewBox usam a MESMA margem padrão', () => {
    const umModulo = [[true]];
    expect(caminhoSvg(umModulo)).toBe('M4 4h1v1h-1z');
    expect(ladoComMargem(umModulo)).toBe(1 + 4 * 2);
  });
});
