import { ImportacaoService } from '../../src/modules/importacao/importacao.service';
import { CarteiraService } from '../../src/modules/carteira/carteira.service';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearCliente,
  liberarProcesso,
  encerrar,
} from './ambiente';

/**
 * A IMPORTAÇÃO MULTI-TRIBUNAL — o modo que os pré-precatórios exigiram.
 *
 * Até 04/09/2026 uma importação era UM tribunal, escolhido na tela antes de o
 * arquivo ser aberto. A planilha de pré-precatórios traz 42 num arquivo só, com
 * o tribunal numa coluna.
 *
 * O modo é escolhido pelo PERFIL, e nunca pela ausência de escolha: quem não
 * mandar `perfilId` cai no caminho de sempre. É isso que garante que a carga de
 * dívida consolidada dos TRFs não muda de comportamento — e há 42 casos em
 * `carteira.int-spec` cobrindo esse caminho, todos verdes.
 *
 * O que este arquivo defende é o modo NOVO, e principalmente o que ele RECUSA.
 * Um importador que aceita demais é pior que um que recusa: linha adivinhada
 * entra na carteira e é vendida, e ninguém revisita.
 */
const lotesEnfileirados: { pessoaId: string }[][] = [];
const importacoesEnfileiradas: string[] = [];
const filaFalsa = {
  enfileirarLote: async (itens: { pessoaId: string }[]) => {
    lotesEnfileirados.push(itens);
    return { enfileirados: itens.length };
  },
  enfileirarImportacao: async (importacaoId: string) => {
    importacoesEnfileiradas.push(importacaoId);
    return { id: `job-${importacaoId}` };
  },
};

const importacao = new ImportacaoService(prisma as never, filaFalsa as never);

/** CPF com dígito verificador válido — o importador recusa inválido. */
function cpfValido(seq: number): string {
  const b = String(seq).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (n: number[], peso: number) =>
    ((n.reduce((s, x, i) => s + x * (peso - i), 0) * 10) % 11) % 10;
  const d1 = dv(b, 10);
  return b.join('') + d1 + dv([...b, d1], 11);
}

function csv(linhas: string[]): Express.Multer.File {
  /* ⚠ O TEMPERO VAI NO CABEÇALHO, e não numa linha nova.
     A trava de duplicidade é por SHA-256 do conteúdo, então cada arquivo do
     teste precisa ter bytes diferentes. A primeira versão disto anexava
     "#<random>" numa linha ao final — e aquilo virava uma LINHA DE DADOS, sem
     tribunal, que o modo multi-tribunal recusa (com razão). Espaços no fim do
     cabeçalho mudam os bytes sem criar registro: `chaveColuna` remove tudo que
     não é alfanumérico antes de comparar, então a última coluna continua
     casando. */
  const cabecalho =
    'CPF do credor,Credor,Processo,Tribunal,Fase,Ente devedor,Órgão julgador,Valor extraído' +
    ' '.repeat(1 + Math.floor(Math.random() * 400));
  return {
    buffer: Buffer.from([cabecalho, ...linhas].join('\n'), 'utf8'),
    originalname: 'pre-precatorios.csv',
  } as Express.Multer.File;
}

describe('Importação multi-tribunal (pré-precatórios)', () => {
  let perfilId: string;

  beforeAll(async () => {
    const p = await prisma.perfilImportacao.findFirstOrThrow({
      where: { tribunalId: null, ativo: true },
      select: { id: true },
    });
    perfilId = p.id;
  });
  beforeEach(async () => {
    await limparDados();
    lotesEnfileirados.length = 0;
    importacoesEnfileiradas.length = 0;
  });
  afterAll(encerrar);

  async function importar(arquivo: Express.Multer.File, org: string, user: string) {
    const r = (await importacao.importar({
      arquivo,
      organizationId: org,
      userId: user,
      perfilId,
    })) as { importacaoId: string };
    await importacao.processarImportacao(r.importacaoId);
    return prisma.importacao.findUniqueOrThrow({ where: { id: r.importacaoId } });
  }

  it('grava cada linha sob o SEU tribunal, com a fase que a planilha declara', async () => {
    const { org, user } = await semearOrganizacao();

    const imp = await importar(
      csv([
        `${cpfValido(800000001)},MARIA DE MINAS,5001111-11.2026.8.13.0024,TJMG,2,Estado de Minas Gerais,2ª Vara Cível,250000`,
        `${cpfValido(800000002)},JOAO DO TRABALHO,0002222-22.2026.5.02.0011,TRT2,3,União,LIQ2 São Paulo,90000`,
        `${cpfValido(800000003)},ANA FEDERAL,0003333-33.2026.4.05.0000,TRF5,4,INSS,3ª Vara Federal,120000`,
      ]),
      org.id,
      user.id,
    );

    expect(imp.status).toBe('CONCLUIDA');
    expect(imp.sucesso).toBe(3);
    expect(imp.processosCriados).toBe(3);
    /* A carga NÃO tem tribunal: ele é por linha, e inventar um faria as três
       linhas caírem sob ele. O que o worker relê aqui é o perfil. */
    expect(imp.tribunalId).toBeNull();
    expect(imp.perfilId).toBe(perfilId);

    const processos = await observador.processo.findMany({
      select: { fase: true, valor: true, valorIndicativo: true, vara: true, tribunal: { select: { sigla: true } } },
      orderBy: { numeroPrecatorio: 'asc' },
    });
    expect(processos.map((p) => p.tribunal.sigla).sort()).toEqual(['TJMG', 'TRF5', 'TRT2']);
    expect(processos.map((p) => p.fase).sort()).toEqual([
      'CALCULOS_HOMOLOGADOS',
      'PRECATORIO_AUTUADO',
      'REQUISITORIO_EXPEDIDO',
    ]);
    /* O juízo de origem chega — é o mesmo fio de `vara` que estava solto. */
    expect(processos.every((p) => p.vara !== null)).toBe(true);
  });

  it('o "Valor extraído" NÃO entra em `valor` — ele é palpite, e vai para a coluna própria', async () => {
    /* A fonte documenta: "NENHUMA fonte pública tem campo de valor. Todo número
       foi extraído do texto (…) pode ser honorário, custas ou valor da causa."
       `valor` é somado no ranking por entidade devedora, no dashboard e na
       calculadora. Misturar ali contamina agregado que o cliente usa para
       decidir, e depois não há como separar. */
    const { org, user } = await semearOrganizacao();

    await importar(
      csv([
        `${cpfValido(800000010)},CARLOS,5009999-99.2026.8.13.0024,TJMG,2,Estado de Minas Gerais,1ª Vara,250000`,
      ]),
      org.id,
      user.id,
    );

    const p = await prisma.processo.findFirstOrThrow({
      select: { valor: true, valorIndicativo: true },
    });
    expect(p.valor).toBeNull();
    expect(Number(p.valorIndicativo)).toBe(250000);
  });

  it('o MESMO número de processo em tribunais diferentes vira DOIS processos', async () => {
    /* A identidade do sistema é (tribunal, número), e não o número sozinho. A
       chave em memória que evita reconciliar duas vezes precisou passar a
       incluir o tribunal — sem isso, a primeira linha venceria a segunda e o
       processo do outro tribunal viraria uma parte pendurada no primeiro. */
    const { org, user } = await semearOrganizacao();
    const numero = '5005555-55.2026.8.13.0024';

    const imp = await importar(
      csv([
        `${cpfValido(800000020)},TITULAR MG,${numero},TJMG,2,Estado de Minas Gerais,1ª Vara,10000`,
        `${cpfValido(800000021)},TITULAR MT,${numero},TJMT,2,Estado de Mato Grosso,1ª Vara,20000`,
      ]),
      org.id,
      user.id,
    );

    expect(imp.processosCriados).toBe(2);
    const siglas = await observador.processo.findMany({
      where: { numeroPrecatorio: numero },
      select: { tribunal: { select: { sigla: true } } },
    });
    expect(siglas.map((p) => p.tribunal.sigla).sort()).toEqual(['TJMG', 'TJMT']);
  });

  describe('o que o modo RECUSA — e recusar é o ponto', () => {
    it('sigla desconhecida recusa o ARQUIVO INTEIRO, não a linha', async () => {
      /* Deixar passar as conhecidas importaria parte da carga e deixaria o resto
         num limbo que ninguém revisita — e o operador, vendo "concluída",
         acharia que importou tudo. */
      const { org, user } = await semearOrganizacao();

      await expect(
        importacao.importar({
          arquivo: csv([
            `${cpfValido(800000030)},VALIDO,5001111-11.2026.8.13.0024,TJMG,2,Estado,1ª Vara,1000`,
            `${cpfValido(800000031)},INVENTADO,5002222-22.2026.8.99.0024,TJXX,2,Estado,1ª Vara,1000`,
          ]),
          organizationId: org.id,
          userId: user.id,
          perfilId,
        }),
      ).rejects.toThrow(/TJXX \(1 linha\)/);

      /* Nada foi gravado: a recusa acontece ANTES de qualquer escrita. */
      expect(await observador.importacao.count()).toBe(0);
      expect(await observador.processo.count()).toBe(0);
    });

    it('fase ausente na planilha recusa o arquivo pela coluna obrigatória', async () => {
      const { org, user } = await semearOrganizacao();
      const semFase = {
        buffer: Buffer.from(
          'CPF do credor,Credor,Processo,Tribunal,Ente devedor\n' +
            `${cpfValido(800000040)},SEM FASE,5001111-11.2026.8.13.0024,TJMG,Estado\n`,
          'utf8',
        ),
        originalname: 'sem-fase.csv',
      } as Express.Multer.File;

      await expect(
        importacao.importar({
          arquivo: semFase,
          organizationId: org.id,
          userId: user.id,
          perfilId,
        }),
      ).rejects.toThrow(/fase/i);
    });

    it('fase NÃO RECONHECIDA recusa a LINHA, com o texto original no erro', async () => {
      /* Aqui a recusa é por linha, e não pelo arquivo: a coluna existe e o resto
         da carga é bom. O texto original entra na mensagem porque é ele que diz
         se é fonte nova ou erro de digitação. */
      const { org, user } = await semearOrganizacao();

      const imp = await importar(
        csv([
          `${cpfValido(800000050)},BOM,5001111-11.2026.8.13.0024,TJMG,2,Estado,1ª Vara,1000`,
          `${cpfValido(800000051)},RUIM,5002222-22.2026.8.13.0024,TJMG,Pago,Estado,1ª Vara,1000`,
        ]),
        org.id,
        user.id,
      );

      expect(imp.status).toBe('CONCLUIDA_COM_ERROS');
      expect(imp.sucesso).toBe(1);
      expect(imp.falhas).toBe(1);

      const erro = await prisma.importacaoLinha.findFirstOrThrow({
        where: { importacaoId: imp.id, status: 'ERRO' },
        select: { mensagemErro: true },
      });
      expect(erro.mensagemErro).toMatch(/Pago/);

      /* E a linha boa entrou: uma linha ruim não derruba a carga. */
      expect(await observador.processo.count()).toBe(1);
    });
  });

  /**
   * ── O CONTRATO QUE A TELA CONSOME ──
   *
   * O selo de fase e o "~estimado" só aparecem se a API mandar os campos. Os
   * testes de componente provam que o selo RENDERIZA; este prova que ele recebe
   * o que renderizar — sem ele, a tela cairia no ramo de fase desconhecida e o
   * pré-precatório voltaria a parecer precatório comum.
   *
   * As duas rotas importam por motivos diferentes: a FILA é onde o cliente
   * varre e escolhe o que trabalhar; o DETALHE é onde ele decide a abordagem.
   */
  it('a fila e o detalhe devolvem a fase e o valor indicativo', async () => {
    const { org, user } = await semearOrganizacao();

    await importar(
      csv([
        `${cpfValido(800000070)},TITULAR MG,5007777-77.2026.8.13.0024,TJMG,2,Estado de Minas Gerais,1ª Vara,250000`,
      ]),
      org.id,
      user.id,
    );

    const carteira = new CarteiraService(prisma as never);
    const p = await prisma.processo.findFirstOrThrow({ select: { id: true } });

    /**
     * ⚠ O ESCOPO É DE CLIENTE, e a escolha revelou um vão que vale registrar.
     *
     * Para o time INTERNO, `loteEfetivo` devolve `LOTE_PADRAO` (TRF5/2027)
     * quando ninguém escolhe lote — e lote é (tribunal + exercício). Um
     * pré-precatório do TJMG sem exercício não casa com nenhum lote, e o
     * seletor da tela só oferece pares que existem na base. Ou seja: hoje o time
     * interno NÃO ENXERGA os pré-precatórios na carteira, e não tem como pedir.
     *
     * Para o CLIENTE não há recorte de lote — ele vê tudo que lhe foi liberado.
     * Então é o cliente, justamente, quem vai receber esses itens; e é por isso
     * que o selo de fase precisa existir. O teste segue o caminho de quem vê.
     */
    const cliente = await semearCliente('Escritório que recebe pré-precatório');
    await liberarProcesso(cliente.org.id, p.id);
    const escopo = {
      id: cliente.user.id,
      organizationId: cliente.org.id,
      papel: 'CLIENTE' as const,
      tipo: 'CLIENTE' as const,
    };

    const fila = await carteira.fila({ usuario: escopo, pagina: 1, porPagina: 10 } as never);
    const item = (fila as { itens: { fase: string; valor: string | null; valorIndicativo: string | null }[] })
      .itens[0];
    expect(item.fase).toBe('CALCULOS_HOMOLOGADOS');
    /* `valor` NULO e o indicativo preenchido: é o par que impede o palpite de
       entrar nos agregados e, ao mesmo tempo, de sumir da tela. */
    expect(item.valor).toBeNull();
    expect(Number(item.valorIndicativo)).toBe(250000);

    const detalhe = (await carteira.processo(p.id, escopo as never)) as {
      fase: string;
      valorIndicativo: string | null;
    } | null;
    expect(detalhe?.fase).toBe('CALCULOS_HOMOLOGADOS');
    expect(Number(detalhe?.valorIndicativo)).toBe(250000);
  });

  it('sem `perfilId`, o caminho de sempre — o tribunal vem do lote', async () => {
    /* A prova de que o modo novo é uma ESCOLHA. Sem ele, o comportamento é o de
       antes: perfil do tribunal do lote, e a coluna "Tribunal" da planilha é
       ignorada porque o perfil da dívida consolidada não a mapeia. */
    const { org, user } = await semearOrganizacao();

    const arquivo = {
      buffer: Buffer.from(
        `CPF,Nome,Processo\n${cpfValido(800000060)},CLASSICO,0009999-99.2026.4.05.0000\n`,
        'utf8',
      ),
      originalname: 'classico.csv',
    } as Express.Multer.File;

    const r = (await importacao.importar({
      arquivo,
      organizationId: org.id,
      userId: user.id,
      lote: { tribunal: 'TRF5', exercicio: 2027 },
    })) as { importacaoId: string };
    await importacao.processarImportacao(r.importacaoId);

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: r.importacaoId } });
    expect(imp.tribunalId).not.toBeNull();
    expect(imp.exercicio).toBe(2027);

    const p = await prisma.processo.findFirstOrThrow({
      select: { fase: true, tribunal: { select: { sigla: true } } },
    });
    expect(p.tribunal.sigla).toBe('TRF5');
    /* E a fase do modo clássico continua sendo a que a dívida consolidada É. */
    expect(p.fase).toBe('PRECATORIO_EXPEDIDO');
  });
});
