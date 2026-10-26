/**
 * QR code — só o bastante para transformar o `otpauth://` do segundo fator em
 * imagem.
 *
 * ── POR QUE ESCRITO AQUI ──
 *
 * O mesmo argumento do `totp.ts`, com uma diferença que vale dizer em voz alta:
 * lá havia vetores oficiais da RFC. Aqui não há — a ISO/IEC 18004 publica UM
 * exemplo resolvido, e nada perto de cobrir as vinte versões. O terreno é mais
 * fraco, e por isso a conferência foi outra: a saída deste arquivo foi comparada
 * MÓDULO A MÓDULO com a implementação de referência do npm, em centenas de
 * payloads de tamanhos variados, antes de entrar no repositório. Bater bit a bit
 * com um codificador maduro é mais forte que passar num punhado de vetores.
 *
 * O que pesou na decisão de escrever em vez de instalar: este código desenha o
 * SEGREDO do segundo fator, e o caminho de autenticação é o último lugar onde
 * convém acrescentar dependência — as ondas B6 e B7 passaram justamente
 * enxugando essa árvore. E há um detalhe que torna o risco aceitável: erro de QR
 * FALHA ALTO. Ou o aplicativo lê, ou não lê. Não existe o modo de falha que
 * assusta em criptografia, o do bug que ninguém enxerga.
 *
 * ── O QUE NÃO ESTÁ AQUI ──
 *
 * Só modo BYTE, só nível de correção M, só versões 1 a 20. Nada disso é
 * limitação de preguiça: é o recorte exato do problema (ver as notas de cada
 * constante). Fora dele, este arquivo lança em vez de gerar um QR torto.
 */

/**
 * Teto de versão 20 — e o motivo é específico, não arbitrário.
 *
 * As posições dos padrões de alinhamento saem de uma FÓRMULA aqui, não de uma
 * tabela copiada à mão. A fórmula reproduz a tabela oficial exatamente até a
 * versão 31; a 32 é uma exceção conhecida do próprio padrão, onde ela erra. Parar
 * em 20 mantém este arquivo dentro da faixa em que a fórmula é demonstrável — e
 * 20 comporta 666 bytes, quando a maior URI `otpauth://` plausível tem ~200.
 */
const VERSAO_MAX = 20;

/**
 * Nível de correção M (~15% de recuperação), o que os autenticadores esperam.
 *
 * Não é escolha de gosto: L geraria um símbolo menor, mas um QR na tela é lido
 * por uma câmera de celular sob reflexo, dedo na frente e foco duvidoso. M é o
 * ponto em que o padrão equilibra tamanho e tolerância, e é o padrão de fato das
 * bibliotecas que os aplicativos autenticadores encontram por aí.
 */
const NIVEL_M = 0b00;

/**
 * Por versão (1 a 20): [corretores por bloco, quantidade de blocos].
 *
 * São os DOIS únicos números que o padrão não deixa derivar. Todo o resto sai
 * daqui por aritmética: o total de codewords vem da geometria (contando os
 * módulos livres do símbolo), os dados são o total menos os corretores, e a
 * divisão em blocos segue a regra fixa "blocos curtos primeiro, o resto ganha um
 * codeword a mais". Tabelar só o indispensável reduz a superfície de erro de
 * digitação, que é o modo de falha real de um codificador de QR.
 */
const ECC_M: ReadonlyArray<readonly [number, number]> = [
  [10, 1],
  [16, 1],
  [26, 1],
  [18, 2],
  [24, 2],
  [16, 4],
  [18, 4],
  [22, 4],
  [22, 5],
  [26, 5],
  [30, 5],
  [22, 8],
  [22, 9],
  [24, 9],
  [24, 10],
  [28, 10],
  [28, 11],
  [26, 13],
  [26, 14],
  [26, 16],
];

// ── Corpo finito GF(256) ───────────────────────────────────

/**
 * Tabelas de exponencial e logaritmo em GF(256), polinômio primitivo 0x11D.
 *
 * Multiplicar em corpo finito é caro; somar expoentes não é. Com estas duas
 * tabelas a multiplicação vira uma soma e duas leituras — e a `EXP` tem 512
 * posições, o dobro do necessário, só para que a soma de dois expoentes nunca
 * precise de um `% 255` no laço mais quente do arquivo.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function multiplicar(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Polinômio gerador de Reed–Solomon de um dado grau: ∏ (x − α^i). */
function polinomioGerador(grau: number): Uint8Array {
  let g = Uint8Array.from([1]);
  for (let i = 0; i < grau; i++) {
    const novo = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      novo[j] ^= g[j];
      novo[j + 1] ^= multiplicar(g[j], EXP[i]);
    }
    g = novo;
  }
  return g;
}

/**
 * Os codewords de correção de um bloco: o resto da divisão polinomial.
 *
 * É divisão longa comum, só que os coeficientes vivem em GF(256) e a subtração é
 * XOR. Como `g[0]` é sempre 1, a primeira iteração de cada passo zera o termo
 * líder — que é exatamente o que faz o laço terminar.
 */
function corretores(dados: Uint8Array, quantidade: number): Uint8Array {
  const g = polinomioGerador(quantidade);
  const resto = new Uint8Array(dados.length + quantidade);
  resto.set(dados);
  for (let i = 0; i < dados.length; i++) {
    const fator = resto[i];
    if (fator === 0) continue;
    for (let j = 0; j < g.length; j++) resto[i + j] ^= multiplicar(g[j], fator);
  }
  return resto.slice(dados.length);
}

/** Resto BCH — usado pelas informações de formato e de versão. */
function restoBch(dados: number, gerador: number, bits: number): number {
  let v = dados << bits;
  const grau = 32 - Math.clz32(gerador);
  while (32 - Math.clz32(v) >= grau) {
    v ^= gerador << (32 - Math.clz32(v) - grau);
  }
  return v;
}

/**
 * Os 15 bits de informação de formato: nível de correção + máscara, com BCH.
 *
 * O XOR final com `101010000010010` é exigência do padrão, e existe por um
 * motivo prático: sem ele, a combinação nível M + máscara 0 daria quinze zeros —
 * uma área toda clara logo ao lado do padrão localizador, que confunde o
 * decodificador justamente onde ele precisa se orientar.
 */
export function informacaoDeFormato(nivel: number, mascara: number): number {
  const dados = (nivel << 3) | mascara;
  return ((dados << 10) | restoBch(dados, 0b10100110111, 10)) ^ 0b101010000010010;
}

/** Os 18 bits de informação de versão (só existe da versão 7 em diante). */
export function informacaoDeVersao(versao: number): number {
  return (versao << 12) | restoBch(versao, 0b1111100100101, 12);
}

// ── Geometria do símbolo ───────────────────────────────────

const tamanhoDe = (versao: number) => versao * 4 + 17;

/**
 * Centros dos padrões de alinhamento.
 *
 * O primeiro é sempre 6 e o último sempre `tamanho − 7`; os do meio são
 * espaçados por um passo PAR (os centros têm de cair em módulos de mesma
 * paridade que o padrão de sincronismo). A sobra da divisão vai toda para o
 * primeiro intervalo — por isso os centros são calculados de trás para frente, a
 * partir do último.
 */
function coordenadasDeAlinhamento(versao: number): number[] {
  if (versao === 1) return [];
  const quantidade = Math.floor(versao / 7) + 2;
  const intervalos = quantidade - 1;
  const ultimo = tamanhoDe(versao) - 7;
  const passo = Math.ceil((ultimo - 6) / intervalos / 2) * 2;

  const coords = [6];
  for (let i = quantidade - 2; i >= 0; i--) coords.push(ultimo - i * passo);
  return coords;
}

interface Grade {
  /** 1 = módulo escuro. */
  modulos: Uint8Array[];
  /** 1 = módulo de função (localizador, sincronismo, formato…), que não recebe dado nem máscara. */
  funcao: Uint8Array[];
}

function gradeVazia(tamanho: number): Grade {
  return {
    modulos: Array.from({ length: tamanho }, () => new Uint8Array(tamanho)),
    funcao: Array.from({ length: tamanho }, () => new Uint8Array(tamanho)),
  };
}

/** Localizadores, separadores, sincronismo, alinhamento e as áreas reservadas. */
function desenharFuncoes(grade: Grade, versao: number): void {
  const tamanho = tamanhoDe(versao);
  const { modulos, funcao } = grade;

  /* Localizadores (7×7) com o separador claro de um módulo em volta. O laço vai
     de −1 a 7 justamente para cobrir o separador junto. */
  for (const [linhaBase, colunaBase] of [
    [0, 0],
    [0, tamanho - 7],
    [tamanho - 7, 0],
  ]) {
    for (let l = -1; l <= 7; l++) {
      for (let c = -1; c <= 7; c++) {
        const linha = linhaBase + l;
        const coluna = colunaBase + c;
        if (linha < 0 || linha >= tamanho || coluna < 0 || coluna >= tamanho) continue;
        const dentro = l >= 0 && l <= 6 && c >= 0 && c <= 6;
        const anel = l === 0 || l === 6 || c === 0 || c === 6;
        const miolo = l >= 2 && l <= 4 && c >= 2 && c <= 4;
        modulos[linha][coluna] = dentro && (anel || miolo) ? 1 : 0;
        funcao[linha][coluna] = 1;
      }
    }
  }

  /* Sincronismo: a régua alternada que diz ao leitor o tamanho de um módulo. */
  for (let i = 8; i < tamanho - 8; i++) {
    const escuro = i % 2 === 0 ? 1 : 0;
    modulos[6][i] = escuro;
    funcao[6][i] = 1;
    modulos[i][6] = escuro;
    funcao[i][6] = 1;
  }

  /* Alinhamento (5×5), em toda combinação de centros MENOS os três cantos onde
     já há localizador. Os que caem sobre o sincronismo o atravessam de
     propósito: nesses pontos os dois padrões concordam módulo a módulo. */
  const centros = coordenadasDeAlinhamento(versao);
  const ultimo = centros.length - 1;
  for (let i = 0; i <= ultimo; i++) {
    for (let j = 0; j <= ultimo; j++) {
      const cantoComLocalizador =
        (i === 0 && j === 0) || (i === 0 && j === ultimo) || (i === ultimo && j === 0);
      if (cantoComLocalizador) continue;
      for (let l = -2; l <= 2; l++) {
        for (let c = -2; c <= 2; c++) {
          const linha = centros[i] + l;
          const coluna = centros[j] + c;
          modulos[linha][coluna] =
            Math.max(Math.abs(l), Math.abs(c)) !== 1 ? 1 : 0;
          funcao[linha][coluna] = 1;
        }
      }
    }
  }

  /* Áreas do formato (escritas depois, quando a máscara já foi escolhida) e o
     módulo escuro fixo. Reservar agora é o que mantém o dado longe delas. */
  for (let i = 0; i <= 8; i++) {
    funcao[8][i] = 1;
    funcao[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    funcao[8][tamanho - 1 - i] = 1;
    funcao[tamanho - 1 - i][8] = 1;
  }

  if (versao >= 7) {
    for (let i = 0; i < 18; i++) {
      const linha = Math.floor(i / 3);
      const coluna = tamanho - 11 + (i % 3);
      funcao[linha][coluna] = 1;
      funcao[coluna][linha] = 1;
    }
  }
}

/**
 * Quantos codewords cabem nesta versão — contados, não tabelados.
 *
 * O padrão publica esse número numa tabela de 40 linhas. Aqui ele sai de contar
 * os módulos que sobraram depois dos padrões de função: é a mesma resposta, sem
 * quarenta oportunidades de errar um dígito ao copiar.
 */
function totalDeCodewords(versao: number): number {
  const grade = gradeVazia(tamanhoDe(versao));
  desenharFuncoes(grade, versao);
  let livres = 0;
  for (const linha of grade.funcao) for (const c of linha) if (!c) livres++;
  return Math.floor(livres / 8);
}

// ── Bits de dado ───────────────────────────────────────────

/** Bits do indicador de contagem em modo byte: 8 até a versão 9, 16 daí em diante. */
const bitsDeContagem = (versao: number) => (versao <= 9 ? 8 : 16);

function dadosPorVersao(versao: number): number {
  const [porBloco, blocos] = ECC_M[versao - 1];
  return totalDeCodewords(versao) - porBloco * blocos;
}

/** A menor versão que comporta o texto. */
function escolherVersao(bytes: Uint8Array): number {
  for (let versao = 1; versao <= VERSAO_MAX; versao++) {
    const necessarios = 4 + bitsDeContagem(versao) + bytes.length * 8;
    if (necessarios <= dadosPorVersao(versao) * 8) return versao;
  }
  throw new Error(
    `Texto longo demais para um QR nível M até a versão ${VERSAO_MAX} (${bytes.length} bytes).`,
  );
}

/**
 * Monta a sequência de codewords: cabeçalho, dados, terminador e enchimento.
 *
 * Os bytes de enchimento alternam 0xEC e 0x11 porque o padrão manda — e o motivo
 * de mandar é o mesmo das máscaras: 11101100 / 00010001 é um par que não forma
 * regiões grandes de uma cor só nem imita o padrão localizador.
 */
function codewordsDeDados(bytes: Uint8Array, versao: number): Uint8Array {
  const capacidade = dadosPorVersao(versao);
  const bits: number[] = [];
  const empurrar = (valor: number, quantidade: number) => {
    for (let i = quantidade - 1; i >= 0; i--) bits.push((valor >>> i) & 1);
  };

  empurrar(0b0100, 4); // modo byte
  empurrar(bytes.length, bitsDeContagem(versao));
  for (const b of bytes) empurrar(b, 8);

  /* Terminador: até quatro zeros, e menos que isso quando não sobra espaço. */
  const folga = capacidade * 8 - bits.length;
  empurrar(0, Math.min(4, folga));
  while (bits.length % 8 !== 0) bits.push(0);

  const saida = new Uint8Array(capacidade);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    saida[i / 8] = byte;
  }
  for (let i = bits.length / 8, alterna = 0; i < capacidade; i++, alterna++) {
    saida[i] = alterna % 2 === 0 ? 0xec : 0x11;
  }
  return saida;
}

/**
 * Divide em blocos, calcula a correção de cada um e INTERCALA tudo.
 *
 * A intercalação é o que faz o nível de correção valer alguma coisa no mundo
 * real: um dedo sobre o QR apaga uma região contígua da imagem, e blocos
 * gravados em sequência colocariam todos os codewords de um mesmo bloco embaixo
 * desse dedo — mais erros do que aquele bloco sabe corrigir, com os vizinhos
 * intactos. Intercalados, o estrago se reparte entre todos.
 */
function sequenciaFinal(dados: Uint8Array, versao: number): Uint8Array {
  const [porBloco, quantidadeDeBlocos] = ECC_M[versao - 1];
  const curtos = Math.floor(dados.length / quantidadeDeBlocos);
  const quantosLongos = dados.length % quantidadeDeBlocos;

  const blocosDeDado: Uint8Array[] = [];
  const blocosDeCorrecao: Uint8Array[] = [];
  let cursor = 0;
  for (let i = 0; i < quantidadeDeBlocos; i++) {
    const tamanho = curtos + (i >= quantidadeDeBlocos - quantosLongos ? 1 : 0);
    const bloco = dados.slice(cursor, cursor + tamanho);
    cursor += tamanho;
    blocosDeDado.push(bloco);
    blocosDeCorrecao.push(corretores(bloco, porBloco));
  }

  const saida: number[] = [];
  const maiorBloco = curtos + (quantosLongos > 0 ? 1 : 0);
  for (let i = 0; i < maiorBloco; i++) {
    for (const bloco of blocosDeDado) if (i < bloco.length) saida.push(bloco[i]);
  }
  for (let i = 0; i < porBloco; i++) {
    for (const bloco of blocosDeCorrecao) saida.push(bloco[i]);
  }
  return Uint8Array.from(saida);
}

// ── Desenho ────────────────────────────────────────────────

type Mascara = (linha: number, coluna: number) => boolean;

/** As oito máscaras do padrão, na ordem em que o formato as numera. */
const MASCARAS: Mascara[] = [
  (l, c) => (l + c) % 2 === 0,
  (l) => l % 2 === 0,
  (_l, c) => c % 3 === 0,
  (l, c) => (l + c) % 3 === 0,
  (l, c) => (Math.floor(l / 2) + Math.floor(c / 3)) % 2 === 0,
  (l, c) => ((l * c) % 2) + ((l * c) % 3) === 0,
  (l, c) => (((l * c) % 2) + ((l * c) % 3)) % 2 === 0,
  (l, c) => (((l + c) % 2) + ((l * c) % 3)) % 2 === 0,
];

/**
 * Percorre o símbolo em zigue-zague, de baixo para cima, duas colunas por vez,
 * da direita para a esquerda — e pula a coluna 6, que é sincronismo puro.
 */
function preencherDados(grade: Grade, sequencia: Uint8Array, mascara: Mascara): void {
  const tamanho = grade.modulos.length;
  let indice = 0;
  const proximoBit = () => {
    const bit = indice < sequencia.length * 8 ? (sequencia[indice >>> 3] >>> (7 - (indice & 7))) & 1 : 0;
    indice++;
    return bit;
  };

  let subindo = true;
  for (let direita = tamanho - 1; direita >= 1; direita -= 2) {
    /* A coluna 6 é sincronismo puro e não entra no zigue-zague. O desvio tem de
       mover o PRÓPRIO contador, e não só a coluna usada nesta volta: os pares
       seguintes são (5,4), (3,2), (1,0). Corrigir apenas a coluna usada deixaria
       o contador em 6, 4, 2 — escrevendo a coluna 4 duas vezes e nunca chegando
       ao par (1,0). */
    if (direita === 6) direita = 5;
    for (let passo = 0; passo < tamanho; passo++) {
      const linha = subindo ? tamanho - 1 - passo : passo;
      for (const coluna of [direita, direita - 1]) {
        if (grade.funcao[linha][coluna]) continue;
        const bit = proximoBit();
        grade.modulos[linha][coluna] = mascara(linha, coluna) ? bit ^ 1 : bit;
      }
    }
    subindo = !subindo;
  }
}

/** Escreve as duas cópias da informação de formato e o módulo escuro fixo. */
function desenharFormato(grade: Grade, mascara: number): void {
  const tamanho = grade.modulos.length;
  const bits = informacaoDeFormato(NIVEL_M, mascara);
  const bit = (i: number) => (bits >>> i) & 1;

  /* Cópia 1, agrupada em volta do localizador superior esquerdo. */
  for (let i = 0; i < 6; i++) grade.modulos[i][8] = bit(i);
  grade.modulos[7][8] = bit(6);
  grade.modulos[8][8] = bit(7);
  grade.modulos[8][7] = bit(8);
  for (let i = 9; i < 15; i++) grade.modulos[8][14 - i] = bit(i);

  /* Cópia 2, repartida entre os outros dois cantos. Ela existe para que o
     formato sobreviva ao dano que destruir um dos cantos — sem formato não há
     como saber a máscara, e o símbolo inteiro se perde. */
  for (let i = 0; i < 8; i++) grade.modulos[8][tamanho - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) grade.modulos[tamanho - 15 + i][8] = bit(i);

  grade.modulos[tamanho - 8][8] = 1; // módulo escuro, sempre
}

/** Informação de versão (versões 7+), nos dois blocos 3×6. */
function desenharVersao(grade: Grade, versao: number): void {
  if (versao < 7) return;
  const tamanho = grade.modulos.length;
  const bits = informacaoDeVersao(versao);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const linha = Math.floor(i / 3);
    const coluna = tamanho - 11 + (i % 3);
    grade.modulos[linha][coluna] = bit;
    grade.modulos[coluna][linha] = bit;
  }
}

export interface Penalidades {
  /** Corridas de cinco ou mais módulos iguais, em linha ou coluna. */
  r1: number;
  /** Blocos 2×2 de uma cor só. */
  r2: number;
  /** Sequências que imitam o padrão localizador. */
  r3: number;
  /** Distância da proporção de módulos escuros até 50%. */
  r4: number;
  total: number;
}

/**
 * Penalidade de uma máscara, pelas quatro regras do padrão.
 *
 * O objetivo não é estética: é evitar desenhos que atrapalham a câmera —
 * manchas grandes de uma cor só, e sobretudo sequências que IMITAM o padrão
 * localizador (regra 3), que fariam o leitor se orientar pelo lugar errado.
 *
 * As quatro parcelas saem separadas porque é assim que se confere: contra a
 * implementação de referência, as regras 1, 2 e 3 batem sempre, e a 4 diverge de
 * propósito (ver a nota dela).
 */
function penalidadesDe(modulos: Uint8Array[]): Penalidades {
  const tamanho = modulos.length;
  let r1 = 0;
  let r2 = 0;
  let r3 = 0;

  // Regra 1: corridas de cinco ou mais módulos iguais.
  for (let i = 0; i < tamanho; i++) {
    for (const pegar of [(j: number) => modulos[i][j], (j: number) => modulos[j][i]]) {
      let corrida = 1;
      for (let j = 1; j < tamanho; j++) {
        if (pegar(j) === pegar(j - 1)) {
          corrida++;
        } else {
          if (corrida >= 5) r1 += 3 + (corrida - 5);
          corrida = 1;
        }
      }
      if (corrida >= 5) r1 += 3 + (corrida - 5);
    }
  }

  // Regra 2: cada bloco 2×2 de uma cor só.
  for (let l = 0; l < tamanho - 1; l++) {
    for (let c = 0; c < tamanho - 1; c++) {
      const v = modulos[l][c];
      if (v === modulos[l][c + 1] && v === modulos[l + 1][c] && v === modulos[l + 1][c + 1]) {
        r2 += 3;
      }
    }
  }

  /* Regra 3: a sequência 1:1:3:1:1 com quatro módulos claros de um dos lados —
     exatamente o que o localizador parece de perto. Uma janela deslizante de 11
     bits em cada linha e em cada coluna. */
  const ALVO_A = 0b10111010000;
  const ALVO_B = 0b00001011101;
  for (let i = 0; i < tamanho; i++) {
    let naLinha = 0;
    let naColuna = 0;
    for (let j = 0; j < tamanho; j++) {
      naLinha = ((naLinha << 1) & 0x7ff) | modulos[i][j];
      naColuna = ((naColuna << 1) & 0x7ff) | modulos[j][i];
      if (j >= 10) {
        if (naLinha === ALVO_A || naLinha === ALVO_B) r3 += 40;
        if (naColuna === ALVO_A || naColuna === ALVO_B) r3 += 40;
      }
    }
  }

  /**
   * Regra 4: o quanto a proporção de módulos escuros se afasta de 50%, em
   * degraus de 5 pontos percentuais.
   *
   * ⚠ AQUI ESTE ARQUIVO DIVERGE DA IMPLEMENTAÇÃO DE REFERÊNCIA, E DE PROPÓSITO.
   *
   * O procedimento da ISO/IEC 18004 é: pegar o múltiplo de 5 anterior e o
   * seguinte à proporção, medir a distância de cada um até 50 e ficar com a
   * MENOR — o que dá exatamente este `floor`. A biblioteca `qrcode` do npm usa
   * `|ceil(proporção/5) − 10|`, que pune 50,1% de escuros tão duro quanto 55%,
   * com um degrau logo acima de 50 que o padrão não tem.
   *
   * O efeito é escolher outra máscara em ~1% dos casos, quando a proporção cai
   * nessa faixa. Nenhum dos dois QR é inválido — o leitor descobre a máscara
   * pela informação de formato. Alinhar com o padrão em vez de com a biblioteca
   * foi decisão consciente: a conferência existe para achar defeito meu, não
   * para eu copiar o defeito dela.
   */
  let escuros = 0;
  for (const linha of modulos) for (const v of linha) escuros += v;
  const desvio = Math.abs((escuros * 100) / (tamanho * tamanho) - 50);
  const r4 = Math.floor(desvio / 5) * 10;

  return { r1, r2, r3, r4, total: r1 + r2 + r3 + r4 };
}

/** As quatro penalidades de uma matriz já pronta — o que permite conferi-las regra a regra. */
export function penalidades(matriz: boolean[][]): Penalidades {
  return penalidadesDe(matriz.map((linha) => Uint8Array.from(linha, (v) => (v ? 1 : 0))));
}

function montar(versao: number, sequencia: Uint8Array, mascara: number): Grade {
  const grade = gradeVazia(tamanhoDe(versao));
  desenharFuncoes(grade, versao);
  desenharVersao(grade, versao);
  preencherDados(grade, sequencia, MASCARAS[mascara]);
  desenharFormato(grade, mascara);
  return grade;
}

function preparar(texto: string): { versao: number; sequencia: Uint8Array } {
  const bytes = new TextEncoder().encode(texto);
  const versao = escolherVersao(bytes);
  return { versao, sequencia: sequenciaFinal(codewordsDeDados(bytes, versao), versao) };
}

const paraBooleanos = (grade: Grade) =>
  grade.modulos.map((linha) => Array.from(linha, (v) => v === 1));

/**
 * A matriz com uma máscara ESCOLHIDA a dedo.
 *
 * É a peça que `matrizQr` monta oito vezes para pontuar. Fica exposta porque é o
 * que permite conferir a colocação dos dados isoladamente, sem que uma diferença
 * na escolha da máscara embaralhe a comparação — foi assim que se separou, na
 * verificação contra a implementação de referência, "o dado está no lugar
 * errado" de "a máscara escolhida foi outra". São defeitos diferentes.
 */
export function matrizComMascara(texto: string, mascara: number): boolean[][] {
  const { versao, sequencia } = preparar(texto);
  return paraBooleanos(montar(versao, sequencia, mascara));
}

/**
 * A matriz de módulos do QR. `true` = escuro.
 *
 * SEM zona de silêncio: a margem branca de quatro módulos que o padrão exige é
 * responsabilidade de quem desenha (ver `caminhoSvg`). Deixá-la fora daqui é o
 * que permite testar a matriz contra outra implementação sem discutir margem.
 */
export function matrizQr(texto: string): boolean[][] {
  const { versao, sequencia } = preparar(texto);

  /* As oito máscaras são geradas e pontuadas; fica a de menor penalidade. Não é
     opcional: o decodificador lê a máscara escolhida no formato, então qualquer
     uma "funciona" — mas a errada produz um símbolo que a câmera erra mais. */
  let melhor: Grade | null = null;
  let menorPenalidade = Infinity;
  for (let mascara = 0; mascara < 8; mascara++) {
    const candidata = montar(versao, sequencia, mascara);
    const nota = penalidadesDe(candidata.modulos).total;
    if (nota < menorPenalidade) {
      menorPenalidade = nota;
      melhor = candidata;
    }
  }

  return paraBooleanos(melhor!);
}

/**
 * A matriz virada num único `path` de SVG, com a zona de silêncio incluída.
 *
 * Um `<rect>` por módulo daria até 4.500 nós no DOM para um QR de versão 20.
 * Como um `path` só, com as corridas horizontais já unidas, o desenho é um
 * elemento — e o navegador rasteriza a coisa toda de uma vez.
 */
export function caminhoSvg(matriz: boolean[][], margem = 4): string {
  const partes: string[] = [];
  for (let l = 0; l < matriz.length; l++) {
    let c = 0;
    while (c < matriz.length) {
      if (!matriz[l][c]) {
        c++;
        continue;
      }
      let fim = c;
      while (fim < matriz.length && matriz[l][fim]) fim++;
      partes.push(`M${c + margem} ${l + margem}h${fim - c}v1h-${fim - c}z`);
      c = fim;
    }
  }
  return partes.join('');
}

/** O lado do `viewBox` correspondente: a matriz mais as duas margens. */
export const ladoComMargem = (matriz: boolean[][], margem = 4) => matriz.length + margem * 2;
