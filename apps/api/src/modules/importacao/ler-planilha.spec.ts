import { BadRequestException } from '@nestjs/common';
import {
  TETO_DESCOMPACTADO,
  TETO_LINHAS,
  conferirBombaZip,
  lerPlanilha,
  linhasEmObjetos,
  tamanhoDescompactado,
} from './ler-planilha';
import { montarXlsx, montarZip } from './zip-de-teste';

/**
 * O leitor de planilha depois da saída do SheetJS.
 *
 * A troca em si foi conferida contra as planilhas REAIS do TRF1 — 111.650
 * células, zero divergência. O que estes casos guardam é o que aquela
 * comparação NÃO cobre: os tetos, os erros de borda e a conversão em objetos,
 * que é código nosso e é onde uma regressão passaria despercebida.
 */
describe('linhasEmObjetos', () => {
  it('primeira linha vira cabeçalho', () => {
    expect(linhasEmObjetos([['CPF', 'Nome'], ['123', 'MARIA']])).toEqual([
      { CPF: '123', Nome: 'MARIA' },
    ]);
  });

  it('célula faltando vira null, e não `undefined`', () => {
    /* O `sheet_to_json` do SheetJS era chamado com `defval: null`. O resto do
       importador distingue "veio vazio" de "não veio"; devolver `undefined`
       mudaria o comportamento de `lerCampos` sem nenhum erro visível. */
    expect(linhasEmObjetos([['A', 'B', 'C'], ['x']])).toEqual([{ A: 'x', B: null, C: null }]);
  });

  it('coluna sem cabeçalho é ignorada', () => {
    expect(linhasEmObjetos([['A', '', 'C'], ['1', '2', '3']])).toEqual([{ A: '1', C: '3' }]);
  });

  it('cabeçalho repetido: fica a primeira ocorrência', () => {
    expect(linhasEmObjetos([['A', 'A'], ['primeiro', 'segundo']])).toEqual([{ A: 'primeiro' }]);
  });

  it('planilha só com cabeçalho devolve lista vazia', () => {
    expect(linhasEmObjetos([['A', 'B']])).toEqual([]);
  });

  it('planilha vazia não estoura', () => {
    expect(linhasEmObjetos([])).toEqual([]);
  });
});

describe('tamanhoDescompactado', () => {
  it('soma o que o diretório central declara', () => {
    const zip = montarZip([
      { nome: 'a.txt', conteudo: Buffer.from('x'.repeat(1000)) },
      { nome: 'b.txt', conteudo: Buffer.from('y'.repeat(2500)) },
    ]);
    expect(tamanhoDescompactado(zip)).toBe(3500);
  });

  it('devolve null para conteúdo que não é ZIP', () => {
    /* Fail-open DE PROPÓSITO: reprovar aqui recusaria planilha legítima por um
       defeito do nosso parser. O teto de linhas continua valendo depois. */
    expect(tamanhoDescompactado(Buffer.from('isto não é um zip'))).toBeNull();
  });

  it('devolve null para arquivo curto demais', () => {
    expect(tamanhoDescompactado(Buffer.alloc(4))).toBeNull();
  });
});

describe('conferirBombaZip', () => {
  it('deixa passar o que cabe no teto', () => {
    const zip = montarZip([{ nome: 'a.txt', conteudo: Buffer.from('conteúdo pequeno') }]);
    expect(() => conferirBombaZip(zip)).not.toThrow();
  });

  it('barra o arquivo que declara mais que o teto, SEM descompactar', () => {
    /**
     * O coração da defesa: 16 bytes de verdade, declarados como 2 GB. Se a
     * checagem descompactasse para medir, ela mesma seria a vítima. Lendo só o
     * metadado, a recusa custa microssegundos.
     */
    const bomba = montarZip([
      {
        nome: 'grande.xml',
        conteudo: Buffer.from('conteúdo mínimo'),
        descompactadoDeclarado: TETO_DESCOMPACTADO + 1_000_000,
      },
    ]);
    expect(() => conferirBombaZip(bomba)).toThrow(BadRequestException);
    expect(() => conferirBombaZip(bomba)).toThrow(/acima do limite/);
  });
});

describe('lerPlanilha', () => {
  const planilha = (linhas: unknown[][], nome = 'Folha1') =>
    montarXlsx([{ nome, linhas }]);

  it('lê cabeçalho e linhas de uma planilha de verdade', async () => {
    const buffer = planilha([
      ['CPF', 'Nome', 'Valor'],
      ['39053344705', 'MARIA DE SOUZA', 1500.5],
      ['52998224725', 'JOÃO & FILHO', 2000],
    ]);

    const { abas, registros } = await lerPlanilha(buffer, null);

    expect(abas).toEqual(['Folha1']);
    expect(registros).toHaveLength(2);
    expect(registros[0]).toMatchObject({ CPF: '39053344705', Nome: 'MARIA DE SOUZA', Valor: 1500.5 });
    // O `&` sobrevive ao XML — escapar errado corromperia nome de gente real.
    expect(registros[1].Nome).toBe('JOÃO & FILHO');
  });

  it('escolhe a aba pelo nome que o perfil declara', async () => {
    const buffer = montarXlsx([
      { nome: 'Instruções', linhas: [['leia antes']] },
      { nome: 'Dados', linhas: [['CPF'], ['39053344705']] },
    ]);

    const { registros } = await lerPlanilha(buffer, 'Dados');
    expect(registros).toEqual([{ CPF: '39053344705' }]);
  });

  it('aba declarada e ausente PARA a importação, listando as que existem', async () => {
    /* Cair na primeira aba em silêncio já processou a aba errada de uma pasta
       com várias — e o estrago só apareceu depois, nos números. */
    const buffer = montarXlsx([{ nome: 'Planilha1', linhas: [['A'], ['1']] }]);

    await expect(lerPlanilha(buffer, 'Dados')).rejects.toThrow(/não tem a aba "Dados"/);
    await expect(lerPlanilha(buffer, 'Dados')).rejects.toThrow(/Planilha1/);
  });

  it('sem aba declarada, usa a primeira', async () => {
    const buffer = montarXlsx([
      { nome: 'Primeira', linhas: [['A'], ['1']] },
      { nome: 'Segunda', linhas: [['B'], ['2']] },
    ]);
    const { registros } = await lerPlanilha(buffer, null);
    expect(registros).toEqual([{ A: '1' }]);
  });

  it('a bomba é barrada ANTES de tentar abrir a planilha', async () => {
    /**
     * O ponto de integração, e não só a função isolada: se o `conferirBombaZip`
     * sair de dentro do `lerPlanilha`, os testes da função continuariam verdes
     * e a defesa não existiria mais no caminho real.
     *
     * O arquivo abaixo nem é uma planilha válida — se a ordem estiver certa,
     * ele é recusado pelo TAMANHO DECLARADO, e a mensagem prova qual das duas
     * portas o barrou.
     */
    const bomba = montarZip([
      {
        nome: 'xl/worksheets/sheet1.xml',
        conteudo: Buffer.from('<x/>'),
        descompactadoDeclarado: TETO_DESCOMPACTADO + 1,
      },
    ]);

    await expect(lerPlanilha(bomba, null)).rejects.toThrow(/acima do limite de \d+ MB/);
  });

  it('arquivo que não é planilha vira 400, e não 500', async () => {
    /* Quem mandou o arquivo consegue corrigir; um 500 mandaria o operador
       procurar defeito no servidor. */
    await expect(lerPlanilha(Buffer.from('não sou um xlsx'), null)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('barra a planilha acima do teto de linhas', async () => {
    const linhas: unknown[][] = [['CPF']];
    for (let i = 0; i < TETO_LINHAS + 1; i++) linhas.push([String(i)]);
    const buffer = planilha(linhas);

    await expect(lerPlanilha(buffer, null)).rejects.toThrow(/acima do limite/);
  }, 60_000);

  it('o teto conta linhas de DADO, não o cabeçalho', async () => {
    /* Exatamente no limite tem de PASSAR: um erro de ±1 aqui recusaria a
       planilha que o operador montou para caber. */
    const linhas: unknown[][] = [['CPF']];
    for (let i = 0; i < TETO_LINHAS; i++) linhas.push([String(i)]);

    const { registros } = await lerPlanilha(planilha(linhas), null);
    expect(registros).toHaveLength(TETO_LINHAS);
  }, 60_000);
});
