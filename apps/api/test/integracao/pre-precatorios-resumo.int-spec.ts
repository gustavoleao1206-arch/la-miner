import { CarteiraService } from '../../src/modules/carteira/carteira.service';
import {
  prisma,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  liberarProcesso,
  encerrar,
} from './ambiente';

const carteira = new CarteiraService(prisma as never);

const FASES_PRE = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
] as const;

/**
 * O RESUMO DO MÓDULO DE PRÉ-PRECATÓRIOS — e os três chips que ele alimenta.
 *
 * ── O QUE ESTES CASOS TRANCAM ──
 *
 * 1. O resumo conta o MESMO universo que a lista filtra. Um chip que diz
 *    "Estadual 2" sobre uma lista de 1 não é bug reportável, é "o sistema
 *    mente" — a lição que `condicoes-da-fila.ts` carrega desde o funil.
 * 2. O resumo IGNORA os próprios chips (`fase`, `esfera`, `conferencia`), pela
 *    mesma regra do funil com `estagio`: clicar em um não pode zerar os outros.
 * 3. `semLote: true` remove o recorte de EXIBIÇÃO, nunca o de ACESSO: o cliente
 *    conta só o que lhe foi liberado.
 */
describe('Resumo dos pré-precatórios', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  const interno = (org: string, id = 'u-interno') =>
    ({ id, organizationId: org, papel: 'ADMIN', tipo: 'INTERNA' }) as never;

  let seq = 0;
  async function pessoa(
    processoId: string,
    conferenciaNome: 'NAO_CONFERIDO' | 'CONFERE' | 'DIVERGE',
  ) {
    seq += 1;
    const cpf = String(10000000000 + seq);
    const p = await prisma.pessoa.create({
      data: { cpf, nome: `CREDOR ${seq}`, nomeNormalizado: `CREDOR ${seq}`, conferenciaNome },
      select: { id: true },
    });
    await prisma.processoPessoa.create({ data: { processoId, pessoaId: p.id } });
    return p;
  }

  async function pre(
    organizationId: string,
    sigla: string,
    fase: (typeof FASES_PRE)[number],
    valorIndicativo: number | null,
  ) {
    const p = await semearProcesso({ organizationId, sigla, fase, exercicio: null, valor: null });
    await prisma.processo.update({ where: { id: p.id }, data: { valorIndicativo } });
    return p;
  }

  /**
   * Uma base pequena com as três dimensões:
   *   TJMG  · cálculos homologados · R$ 100.000 · CONFERE
   *   TJMG  · requisitório expedido · sem valor  · NAO_CONFERIDO
   *   TRT6  · trânsito em julgado   · R$ 50.000  · DIVERGE
   *   TRF5  · precatório EXPEDIDO   (fora do módulo, de propósito)
   */
  async function base(organizationId: string) {
    const a = await pre(organizationId, 'TJMG', 'CALCULOS_HOMOLOGADOS', 100_000);
    const b = await pre(organizationId, 'TJMG', 'REQUISITORIO_EXPEDIDO', null);
    const c = await pre(organizationId, 'TRT6', 'TRANSITO_EM_JULGADO', 50_000);
    await pessoa(a.id, 'CONFERE');
    await pessoa(b.id, 'NAO_CONFERIDO');
    await pessoa(c.id, 'DIVERGE');
    const fora = await semearProcesso({ organizationId, sigla: 'TRF5', exercicio: 2027 });
    return { a, b, c, fora };
  }

  it('conta o módulo por fase, esfera e veredito, e soma só o indicativo', async () => {
    const { org } = await semearOrganizacao();
    await base(org.id);

    const r = await carteira.resumoDaFila({
      usuario: interno(org.id),
      semLote: true,
      fases: [...FASES_PRE],
    });

    expect(r.total).toBe(3);
    expect(r.tribunais).toBe(2);
    expect(r.valorIndicativo).toBe('150000');
    expect(r.comValorIndicativo).toBe(2);
    expect(r.porFase).toEqual(
      expect.arrayContaining([
        { fase: 'CALCULOS_HOMOLOGADOS', quantidade: 1 },
        { fase: 'REQUISITORIO_EXPEDIDO', quantidade: 1 },
        { fase: 'TRANSITO_EM_JULGADO', quantidade: 1 },
      ]),
    );
    expect(r.porFase.some((f) => f.fase === 'PRECATORIO_EXPEDIDO')).toBe(false);
    expect(r.porEsfera).toEqual([
      { esfera: 'ESTADUAL', quantidade: 2 },
      { esfera: 'TRABALHISTA', quantidade: 1 },
    ]);
    expect(r.porConferencia).toEqual([
      { conferencia: 'CONFERE', quantidade: 1 },
      { conferencia: 'DIVERGE', quantidade: 1 },
      { conferencia: 'NAO_CONFERIDO', quantidade: 1 },
    ]);
  });

  it('cada chip filtra a LISTA exatamente como o resumo contou', async () => {
    const { org } = await semearOrganizacao();
    const { a, b, c } = await base(org.id);
    const comum = { usuario: interno(org.id), semLote: true, fases: [...FASES_PRE], pagina: 1, porPagina: 50 };

    const estaduais = await carteira.fila({ ...comum, esfera: 'ESTADUAL' });
    expect(estaduais.itens.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

    const homologados = await carteira.fila({ ...comum, fase: 'CALCULOS_HOMOLOGADOS' });
    expect(homologados.itens.map((i) => i.id)).toEqual([a.id]);

    const divergentes = await carteira.fila({ ...comum, conferencia: 'DIVERGE' });
    expect(divergentes.itens.map((i) => i.id)).toEqual([c.id]);

    /* Chip fora do módulo: vazio, e não a carteira inteira. */
    const expedidos = await carteira.fila({ ...comum, fase: 'PRECATORIO_EXPEDIDO' });
    expect(expedidos.total).toBe(0);
  });

  it('o resumo ignora os próprios chips — clicar em um não zera os outros', async () => {
    const { org } = await semearOrganizacao();
    await base(org.id);

    const r = await carteira.resumoDaFila({
      usuario: interno(org.id),
      semLote: true,
      fases: [...FASES_PRE],
      esfera: 'TRABALHISTA',
      fase: 'TRANSITO_EM_JULGADO',
      conferencia: 'DIVERGE',
    });

    expect(r.total).toBe(3);
    expect(r.porEsfera.find((e) => e.esfera === 'ESTADUAL')?.quantidade).toBe(2);
  });

  it('mas respeita os DEMAIS filtros, que são o universo da lista', async () => {
    const { org } = await semearOrganizacao();
    const { c } = await base(org.id);
    const numero = (await prisma.processo.findUniqueOrThrow({ where: { id: c.id } })).numeroPrecatorio;

    const r = await carteira.resumoDaFila({
      usuario: interno(org.id),
      semLote: true,
      fases: [...FASES_PRE],
      termo: numero,
    });

    expect(r.total).toBe(1);
    expect(r.porEsfera).toEqual([{ esfera: 'TRABALHISTA', quantidade: 1 }]);
  });

  it('⚠ o cliente conta só o que lhe foi LIBERADO — e não recebe o agregado de CPF', async () => {
    const { org } = await semearOrganizacao();
    const { a } = await base(org.id);
    const cliente = await semearCliente('Escritório com um só liberado');
    await liberarProcesso(cliente.org.id, a.id);

    const r = await carteira.resumoDaFila({
      usuario: {
        id: cliente.user.id,
        organizationId: cliente.org.id,
        papel: 'CLIENTE',
        tipo: 'CLIENTE',
      } as never,
      semLote: true,
      fases: [...FASES_PRE],
    });

    expect(r.total).toBe(1);
    expect(r.tribunais).toBe(1);
    expect(r.valorIndicativo).toBe('100000');
    expect(r.porEsfera).toEqual([{ esfera: 'ESTADUAL', quantidade: 1 }]);
    /* Omitido, não zerado: o agregado de conferência é métrica da NOSSA base,
       e o dono decidiu que o assinante não o vê. A chave nem existe na resposta. */
    expect(r).not.toHaveProperty('porConferencia');
  });

  it('a operação interna não vê, nem soma, o que saiu do sorteio — e a busca ainda acha', async () => {
    /* Decisão de 03/10/2026: os 1.050 que não são Fazenda inflavam o "Valor
       estimado" (um deles com R$ 4,4 bi de palpite). Lista e resumo pelo MESMO
       recorte — o cartão soma o que a lista mostra. */
    const { org } = await semearOrganizacao();
    const { a } = await base(org.id);
    const naoFazenda = await pre(org.id, 'TJMG', 'CALCULOS_HOMOLOGADOS', 4_400_000_000);
    await prisma.processo.update({
      where: { id: naoFazenda.id },
      data: { foraDaDistribuicao: 'DEVEDOR_NAO_E_FAZENDA' },
    });
    const modulo = { usuario: interno(org.id), semLote: true, fases: [...FASES_PRE], semForaDaDistribuicao: true };

    const r = await carteira.resumoDaFila(modulo);
    expect(r.total).toBe(3);
    expect(r.valorIndicativo).toBe('150000');

    const lista = await carteira.fila({ ...modulo, pagina: 1, porPagina: 50 });
    expect(lista.itens.map((i) => i.id)).not.toContain(naoFazenda.id);
    expect(lista.itens.map((i) => i.id)).toContain(a.id);

    /* Sem o recorte do módulo (a busca, a página do processo), continua lá:
       saiu do sorteio, não da base. */
    const numero = (await prisma.processo.findUniqueOrThrow({ where: { id: naoFazenda.id } })).numeroPrecatorio;
    const semRecorte = await carteira.fila({ usuario: interno(org.id), semLote: true, fases: [...FASES_PRE], termo: numero, pagina: 1, porPagina: 50 });
    expect(semRecorte.itens.map((i) => i.id)).toEqual([naoFazenda.id]);
  });

  it('⚠ o cliente que JÁ recebeu um processo que saiu do sorteio continua vendo', async () => {
    /* A trava não é retroativa: sumir com o que foi entregue seria tirar do
       assinante algo que ele já tem. */
    const { org } = await semearOrganizacao();
    const naoFazenda = await pre(org.id, 'TJMG', 'CALCULOS_HOMOLOGADOS', 10_000);
    await prisma.processo.update({
      where: { id: naoFazenda.id },
      data: { foraDaDistribuicao: 'DEVEDOR_NAO_E_FAZENDA' },
    });
    const cliente = await semearCliente('Escritório que recebeu antes da trava');
    await liberarProcesso(cliente.org.id, naoFazenda.id);
    const usuario = {
      id: cliente.user.id,
      organizationId: cliente.org.id,
      papel: 'CLIENTE',
      tipo: 'CLIENTE',
    } as never;
    const modulo = { usuario, semLote: true, fases: [...FASES_PRE], semForaDaDistribuicao: true };

    expect((await carteira.resumoDaFila(modulo)).total).toBe(1);
    const lista = await carteira.fila({ ...modulo, pagina: 1, porPagina: 50 });
    expect(lista.itens.map((i) => i.id)).toEqual([naoFazenda.id]);
  });
});
