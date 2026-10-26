import { BadRequestException } from '@nestjs/common';
import readXlsxFile, { readSheet } from 'read-excel-file/node';

/**
 * Leitura de planilha .xlsx, com tetos.
 *
 * ── POR QUE SAIU O `xlsx` (SheetJS) ──
 *
 * O pacote `xlsx` do npm carrega uma vulnerabilidade ALTA para a qual NÃO
 * EXISTE correção publicada — é o único achado da auditoria nessa condição, e o
 * que mantinha o portão do CI vermelho. Atualizar não resolvia; só a troca.
 *
 * A migração foi conferida contra as planilhas REAIS do TRF1, célula a célula:
 * 111.650 células, ZERO divergência, mesmas abas, mesmas contagens.
 *
 * ⚠ O QUE SE PERDEU: `.xls` (Excel 97-2003, formato binário). O `read-excel-file`
 * só lê `.xlsx`. Nenhum `.xls` jamais foi importado neste sistema — o histórico
 * tem uma importação, `.xlsx` — e manter uma biblioteca com falha alta e sem
 * conserto para um formato nunca usado seria a troca errada. Quem tiver um
 * arquivo antigo recebe uma mensagem dizendo exatamente o que fazer.
 */

/**
 * Teto de linhas. Serve a dois propósitos ao mesmo tempo: barra a planilha
 * absurda (acidental ou não) e mantém o consumo de memória previsível.
 *
 * 100 mil é folgado: a maior carga real até hoje teve 8.479 linhas.
 *
 * ── ESTE NÚMERO JÁ FOI INCOERENTE, E DEIXOU DE SER ──
 *
 * Quando o teto entrou (B6), a importação inteira acontecia DENTRO da
 * requisição, a 8,5 ms por linha — medido. Cem mil linhas eram catorze minutos
 * de HTTP, que nenhum proxy deixa terminar: o teto autorizava exatamente a
 * planilha que o sistema não conseguia processar.
 *
 * O B5 tirou o trabalho da requisição. Medido de novo, com o mesmo script
 * (`scripts/medir-importacao.js`), sobre 10 mil linhas:
 *
 *   requisição ....... 0,19 ms/linha  →  ~19 s no teto
 *   worker ........... 9,7 ms/linha   →  ~16 min no teto
 *
 * Dezenove segundos de requisição para o caso extremo é aceitável — e, mais
 * importante, o modo de falha mudou: se a conexão cair, a carga já está
 * gravada e enfileirada, e aparece no histórico. Antes, o corte deixava a
 * importação PROCESSANDO para sempre, pela metade.
 */
export const TETO_LINHAS = 100_000;

/**
 * Teto do conteúdo DESCOMPACTADO.
 *
 * Um .xlsx é um ZIP. O limite de 25 MB do upload não diz nada sobre o que ele
 * vira na memória: XML repetitivo comprime muito bem, e alguns megabytes podem
 * virar gigabytes ao abrir — é a "zip bomb". O processo morre por falta de
 * memória antes de qualquer validação nossa rodar.
 */
export const TETO_DESCOMPACTADO = 400 * 1024 * 1024;

/** Assinaturas do formato ZIP, em little-endian. */
const FIM_DO_DIRETORIO = 0x06054b50;
const ENTRADA_DO_DIRETORIO = 0x02014b50;

/**
 * Soma o tamanho descompactado declarado no diretório central do ZIP.
 *
 * Lê SÓ os metadados — nada é descompactado, então a checagem não pode ser
 * vítima da bomba que ela procura. Os tamanhos são declarados pelo arquivo e
 * podem mentir; por isso o teto de linhas continua valendo depois. Esta é a
 * primeira porta, não a única.
 *
 * Devolve `null` quando o diretório não pode ser lido (ZIP64, comentário
 * gigante, arquivo truncado). Nesse caso NÃO reprovamos: um falso positivo
 * recusaria planilha legítima, e as portas seguintes — teto de linhas e limite
 * de upload — seguem de pé.
 */
export function tamanhoDescompactado(buffer: Buffer): number | null {
  /* O fim do diretório central mora no fim do arquivo, atrás de um comentário
     de até 65535 bytes. Varremos de trás para frente. */
  const minimo = 22;
  if (buffer.length < minimo) return null;
  const inicioDaBusca = Math.max(0, buffer.length - minimo - 0xffff);

  let fim = -1;
  for (let i = buffer.length - minimo; i >= inicioDaBusca; i--) {
    if (buffer.readUInt32LE(i) === FIM_DO_DIRETORIO) {
      fim = i;
      break;
    }
  }
  if (fim < 0) return null;

  const totalEntradas = buffer.readUInt16LE(fim + 10);
  const inicioDoDiretorio = buffer.readUInt32LE(fim + 16);

  /* 0xFFFF/0xFFFFFFFF é o marcador de ZIP64: os valores reais estão noutro
     lugar. Não interpretamos ZIP64 — devolver null joga a decisão para os
     tetos seguintes em vez de somar um número errado. */
  if (totalEntradas === 0xffff || inicioDoDiretorio === 0xffffffff) return null;
  if (inicioDoDiretorio >= buffer.length) return null;

  let total = 0;
  let p = inicioDoDiretorio;
  for (let n = 0; n < totalEntradas; n++) {
    if (p + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(p) !== ENTRADA_DO_DIRETORIO) return null;

    const descompactado = buffer.readUInt32LE(p + 24);
    if (descompactado === 0xffffffff) return null; // ZIP64 na entrada
    total += descompactado;

    const nomeLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const comentarioLen = buffer.readUInt16LE(p + 32);
    p += 46 + nomeLen + extraLen + comentarioLen;
  }
  return total;
}

/** Barra a bomba antes de qualquer descompactação. */
export function conferirBombaZip(buffer: Buffer): void {
  const total = tamanhoDescompactado(buffer);
  if (total !== null && total > TETO_DESCOMPACTADO) {
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    throw new BadRequestException(
      `A planilha declara ${mb(total)} MB descompactados, acima do limite de ${mb(TETO_DESCOMPACTADO)} MB. ` +
        'Divida o arquivo em partes menores.',
    );
  }
}

/* `linhasEmObjetos` mudou de casa: foi para `colunas-planilha.ts`, que JÁ é o
   par espelhado entre a API e o `@miner/database`. O motivo é que o seed e o
   carregador do TRF1 passaram a precisar dela — e um import atravessando os dois
   pacotes quebraria o `nest build`, pelo mesmo motivo escrito no cabeçalho de
   lá. Re-exportada aqui para quem já a importava (inclusive o spec) não mudar. */
import { linhasEmObjetos } from './colunas-planilha';
/* Importada E re-exportada: `export … from` sozinho NÃO traz o nome para o
   escopo deste módulo, e a `lerPlanilha` logo abaixo a chama. O typecheck pegou
   com "Cannot find name 'linhasEmObjetos'". */
export { linhasEmObjetos };

/**
 * Lê a planilha e devolve as linhas como objetos.
 *
 * `aba` vem do PerfilImportacao. Quando o perfil a declara e ela não existe, a
 * importação PARA: ler a primeira aba em silêncio já processou a aba errada de
 * uma pasta com várias, e o estrago só aparece depois, nos números.
 */
export async function lerPlanilha(
  buffer: Buffer,
  aba: string | null,
): Promise<{ abas: string[]; registros: Record<string, unknown>[] }> {
  conferirBombaZip(buffer);

  let folhas: { sheet: string }[];
  try {
    folhas = await readXlsxFile(buffer);
  } catch (e) {
    /* Erro de formato vira 400, não 500: quem mandou o arquivo consegue
       corrigir, e um 500 mandaria o operador procurar defeito no servidor. */
    throw new BadRequestException(
      `Não foi possível ler a planilha: ${(e as Error).message}. ` +
        'Confirme que é um arquivo .xlsx válido (Excel 2007 ou mais novo).',
    );
  }

  const abas = folhas.map((f) => f.sheet);
  if (abas.length === 0) throw new BadRequestException('A planilha não tem nenhuma aba.');

  if (aba && !abas.includes(aba)) {
    throw new BadRequestException(
      `A planilha não tem a aba "${aba}" esperada por este perfil. Abas encontradas: ${abas.join(', ')}.`,
    );
  }

  const linhas = (await readSheet(buffer, aba ?? abas[0])) as unknown[][];

  /* -1 pelo cabeçalho: o teto conta linhas de DADO, que é o que o operador vê
     na tela e o que vira processo no banco. */
  const linhasDeDado = Math.max(0, linhas.length - 1);
  if (linhasDeDado > TETO_LINHAS) {
    throw new BadRequestException(
      `A planilha tem ${linhasDeDado.toLocaleString('pt-BR')} linhas, acima do limite de ` +
        `${TETO_LINHAS.toLocaleString('pt-BR')} por importação. Divida o arquivo em partes.`,
    );
  }

  return { abas, registros: linhasEmObjetos(linhas) };
}
