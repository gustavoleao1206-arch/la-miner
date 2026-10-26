import { ImportacaoService } from '../../src/modules/importacao/importacao.service';
import { MOTIVO_METODO_RECUSADO } from '../../src/modules/importacao/metodo-do-cpf';
import { prisma, observador, limparDados, semearOrganizacao, encerrar } from './ambiente';

const lotesEnfileirados: { pessoaId: string }[][] = [];
const filaFalsa = {
  enfileirarLote: async (itens: { pessoaId: string }[]) => {
    lotesEnfileirados.push(itens);
    return { enfileirados: itens.length };
  },
  enfileirarImportacao: async (importacaoId: string) => ({ id: `job-${importacaoId}` }),
};

const importacao = new ImportacaoService(prisma as never, filaFalsa as never);

function cpfValido(seq: number): string {
  const b = String(seq).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (n: number[], peso: number) =>
    ((n.reduce((s, x, i) => s + x * (peso - i), 0) * 10) % 11) % 10;
  const d1 = dv(b, 10);
  return b.join('') + d1 + dv([...b, d1], 11);
}

/** O cabeçalho do radar, com a coluna do método. O tempero de bytes vai no fim dele. */
function csv(linhas: string[]): Express.Multer.File {
  const cabecalho =
    'CPF do credor,Credor,Processo,Tribunal,Fase,Como o CPF foi obtido,Valor extraído' +
    ' '.repeat(1 + Math.floor(Math.random() * 400));
  return {
    buffer: Buffer.from([cabecalho, ...linhas].join('\n'), 'utf8'),
    originalname: 'radar.csv',
  } as Express.Multer.File;
}

/**
 * O MÉTODO DO CPF DECIDE SE A LINHA ENTRA.
 *
 * Medido em 20/09/2026: o método "rotulado CPF, credor unico" do radar acerta
 * 21% das vezes. O dono decidiu que essas linhas não entram — nem processo, nem
 * pessoa, nem consulta paga. O que estes casos trancam é que a regra vale nos
 * DOIS lados (a simulação promete o que o confirmar entrega) e que o dinheiro
 * de fato não sai: a fila recebe só quem veio pelo método confiável.
 */
describe('Importação × método de obtenção do CPF', () => {
  let perfilId: string;

  beforeAll(async () => {
    const p = await prisma.perfilImportacao.findFirstOrThrow({
      where: { tribunalId: null, ativo: true },
      select: { id: true, mapaColunas: true },
    });
    perfilId = p.id;
  });
  beforeEach(async () => {
    await limparDados();
    lotesEnfileirados.length = 0;
  });
  afterAll(encerrar);

  const LINHAS = [
    `${cpfValido(810000001)},MARIA DE MINAS,5001111-11.2026.8.13.0024,TJMG,2,junto ao nome do credor,250000`,
    `${cpfValido(810000002)},JOAO,0002222-22.2026.5.03.0011,TRT3,4,"rotulado CPF, credor unico",90000`,
    `${cpfValido(810000003)},ANA FEDERAL,0003333-33.2026.4.05.0000,TRF5,3,unico CPF valido no texto,120000`,
  ];

  it('a migration ensinou o perfil a ler a coluna — sem isso a regra nunca dispararia', async () => {
    const p = await prisma.perfilImportacao.findUniqueOrThrow({
      where: { id: perfilId },
      select: { mapaColunas: true },
    });
    expect((p.mapaColunas as Record<string, string[]>).metodoCpf).toContain('como o cpf foi obtido');
  });

  it('a SIMULAÇÃO tira a linha da conta e diz quantas ficam de fora, com o motivo', async () => {
    const { org, user } = await semearOrganizacao();

    const r = (await importacao.importar({
      arquivo: csv(LINHAS),
      organizationId: org.id,
      userId: user.id,
      perfilId,
      dryRun: true,
    })) as {
      totalLinhas: number;
      recusadasPeloMetodo: { total: number; motivo: string | null };
      pessoas: { novas: number };
      processos: { novos: number };
      seriamEnfileiradas: number;
    };

    expect(r.totalLinhas).toBe(3);
    expect(r.recusadasPeloMetodo).toEqual({ total: 1, motivo: MOTIVO_METODO_RECUSADO });
    /* Duas pessoas, dois processos, duas consultas — e não três. */
    expect(r.pessoas.novas).toBe(2);
    expect(r.processos.novos).toBe(2);
    expect(r.seriamEnfileiradas).toBe(2);
  });

  it('⚠ na importação REAL a linha vira IGNORADA: sem processo, sem pessoa, sem consulta paga', async () => {
    const { org, user } = await semearOrganizacao();

    const r = (await importacao.importar({
      arquivo: csv(LINHAS),
      organizationId: org.id,
      userId: user.id,
      perfilId,
    })) as { importacaoId: string };
    await importacao.processarImportacao(r.importacaoId);

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: r.importacaoId } });
    expect(imp.status).toBe('CONCLUIDA');
    expect(imp.sucesso).toBe(2);
    expect(imp.falhas).toBe(0);

    const ignorada = await prisma.importacaoLinha.findFirstOrThrow({
      where: { importacaoId: r.importacaoId, status: 'IGNORADA' },
      select: { numeroLinha: true, mensagemErro: true, pessoaId: true },
    });
    /* Linha 3 do arquivo (cabeçalho + base 1): o número NÃO desloca por causa do
       descarte — quem abrir a planilha acha a linha certa. */
    expect(ignorada.numeroLinha).toBe(3);
    expect(ignorada.mensagemErro).toBe(MOTIVO_METODO_RECUSADO);
    expect(ignorada.pessoaId).toBeNull();

    expect(await observador.processo.count()).toBe(2);
    expect(await prisma.pessoa.count({ where: { cpf: cpfValido(810000002) } })).toBe(0);
    /* O ponto inteiro: a fila paga recebeu DOIS, e nenhum é o do método recusado. */
    expect(lotesEnfileirados.flat()).toHaveLength(2);
  });

  it('planilha SEM a coluna segue entrando inteira — é o caso de toda carga dos TRFs', async () => {
    const { org, user } = await semearOrganizacao();
    const semColuna = {
      buffer: Buffer.from(
        [
          'CPF do credor,Credor,Processo,Tribunal,Fase' + ' '.repeat(1 + Math.floor(Math.random() * 400)),
          `${cpfValido(810000009)},PEDRO DE MINAS,5009999-99.2026.8.13.0024,TJMG,2`,
        ].join('\n'),
        'utf8',
      ),
      originalname: 'sem-coluna.csv',
    } as Express.Multer.File;

    const r = (await importacao.importar({
      arquivo: semColuna,
      organizationId: org.id,
      userId: user.id,
      perfilId,
    })) as { importacaoId: string };
    await importacao.processarImportacao(r.importacaoId);

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: r.importacaoId } });
    expect(imp.sucesso).toBe(1);
    expect(await observador.processo.count()).toBe(1);
  });
});
