import { deflateRawSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

/**
 * Monta arquivos ZIP (e, com eles, .xlsx) para os testes.
 *
 * Existe porque a biblioteca que ESCREVIA planilha saiu do projeto: o `xlsx`
 * carregava vulnerabilidade alta sem correção e foi removido no B6. Sem um
 * gerador, os testes do leitor dependeriam de um binário commitado — opaco de
 * revisar e impossível de ajustar num caso novo.
 *
 * Escreve só o essencial do formato: entradas DEFLATE, diretório central e o
 * registro de fim. É suficiente para o Excel e para qualquer leitor de xlsx.
 *
 * ⚠ MORA EM `src/`, e não em `test/`, POR UM MOTIVO CARO DE DESCOBRIR.
 *
 * Ele nasceu em `apps/api/test/`. O spec que o importa está em `src/`, e essa
 * única linha de import puxou `test/` para dentro do programa do TypeScript.
 * Com isso a raiz comum de compilação deixou de ser `src/` e virou a raiz do
 * app — a saída passou de `dist/main.js` para `dist/src/main.js`.
 *
 * O build continuou "passando". Quebraram duas coisas em silêncio:
 *  1. `node apps/api/dist/main.js`, que é o comando de produção do render.yaml,
 *     apontava para um arquivo que não existia mais;
 *  2. `__dirname` ganhou um nível, e o `.env` da raiz — resolvido a partir dele
 *     no app.module — deixou de ser encontrado. A API não subia.
 *
 * O `rootDir: "./src"` no tsconfig agora impede a repetição: qualquer import de
 * fora de `src/` vira erro de compilação, em vez de mudança silenciosa de
 * layout.
 */

interface Entrada {
  nome: string;
  conteudo: Buffer;
  /** Mentira deliberada no tamanho descompactado, para testar a bomba-zip. */
  descompactadoDeclarado?: number;
}

export function montarZip(entradas: Entrada[]): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let deslocamento = 0;

  for (const e of entradas) {
    const nome = Buffer.from(e.nome, 'utf8');
    const comprimido = deflateRawSync(e.conteudo);
    const crc = crc32(e.conteudo);
    const descompactado = e.descompactadoDeclarado ?? e.conteudo.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // assinatura do cabeçalho local
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0, 6); // sem sinalizadores
    local.writeUInt16LE(8, 8); // método DEFLATE
    local.writeUInt16LE(0, 10); // hora
    local.writeUInt16LE(0x21, 12); // data (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(descompactado, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28); // sem campo extra
    locais.push(local, nome, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // versão que criou
    central.writeUInt16LE(20, 6); // versão necessária
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(descompactado, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentário
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);

    deslocamento += 30 + nome.length + comprimido.length;
  }

  const corpo = Buffer.concat(locais);
  const diretorio = Buffer.concat(centrais);

  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(0, 4); // disco
  fim.writeUInt16LE(0, 6); // disco do diretório
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(corpo.length, 16);
  fim.writeUInt16LE(0, 20); // sem comentário

  return Buffer.concat([corpo, diretorio, fim]);
}

const xml = (s: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${s}`;

/** Escapa o que não pode entrar cru num XML. */
const esc = (v: unknown) =>
  String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Gera um .xlsx de verdade a partir de uma matriz de células.
 *
 * Usa `inlineStr` em vez da tabela de strings compartilhadas: é o caminho mais
 * curto para um arquivo válido, e o que se quer testar é o LEITOR, não a
 * eficiência de quem escreve.
 */
export function montarXlsx(abas: { nome: string; linhas: unknown[][] }[]): Buffer {
  const colunaDaLetra = (i: number) => {
    let s = '';
    for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
    return s;
  };

  const folhas = abas.map((aba, indice) => {
    const linhas = aba.linhas
      .map((linha, l) => {
        const celulas = linha
          .map((valor, c) => {
            if (valor === null || valor === undefined || valor === '') return '';
            const ref = `${colunaDaLetra(c)}${l + 1}`;
            if (typeof valor === 'number') return `<c r="${ref}"><v>${valor}</v></c>`;
            return `<c r="${ref}" t="inlineStr"><is><t>${esc(valor)}</t></is></c>`;
          })
          .join('');
        return `<row r="${l + 1}">${celulas}</row>`;
      })
      .join('');
    return {
      caminho: `xl/worksheets/sheet${indice + 1}.xml`,
      conteudo: xml(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${linhas}</sheetData></worksheet>`,
      ),
    };
  });

  const refs = abas
    .map((a, i) => `<sheet name="${esc(a.nome)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const relsDaPasta = abas
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join('');
  const tiposDasFolhas = abas
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  return montarZip([
    {
      nome: '[Content_Types].xml',
      conteudo: Buffer.from(
        xml(
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
            tiposDasFolhas +
            `</Types>`,
        ),
      ),
    },
    {
      nome: '_rels/.rels',
      conteudo: Buffer.from(
        xml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
            `</Relationships>`,
        ),
      ),
    },
    {
      nome: 'xl/workbook.xml',
      conteudo: Buffer.from(
        xml(
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
            `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<sheets>${refs}</sheets></workbook>`,
        ),
      ),
    },
    {
      nome: 'xl/_rels/workbook.xml.rels',
      conteudo: Buffer.from(
        xml(
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsDaPasta}</Relationships>`,
        ),
      ),
    },
    ...folhas.map((f) => ({ nome: f.caminho, conteudo: Buffer.from(f.conteudo) })),
  ]);
}
