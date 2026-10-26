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

/**
 * O MÓDULO DE PRÉ-PRECATÓRIOS.
 *
 * ── O VÃO QUE ELE FECHA, E COMO ELE APARECEU ──
 *
 * Descobri escrevendo o teste de contrato da fase na tela: a fila voltou VAZIA
 * com escopo interno. Achei defeito do teste; era do produto.
 *
 * Sem lote explícito, a operação interna cai em `LOTE_PADRAO` (TRF5/2027). Lote é
 * (tribunal + exercício), e pré-precatório não tem exercício — não casa com
 * nenhum, e o seletor da tela só oferece pares que EXISTEM na base. O time
 * interno não enxergava os pré-precatórios e não tinha como pedir.
 *
 * O cliente, que não tem recorte de lote, já os recebia. Ou seja: o cliente
 * recebia o que a operação não conseguia revisar. É isso que estes casos
 * impedem de voltar.
 */
describe('Módulo de pré-precatórios', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  const interno = (org: string, id = 'u-interno') =>
    ({ id, organizationId: org, papel: 'ADMIN', tipo: 'INTERNA' }) as never;

  /** Um pré-precatório num TJ (sem exercício) e um precatório do TRF5 (com). */
  async function baseMista(organizationId: string) {
    const pre = await semearProcesso({
      organizationId,
      sigla: 'TJMG',
      fase: 'CALCULOS_HOMOLOGADOS',
      exercicio: undefined,
      numeroPrecatorio: '5001111-11.2026.8.13.0024',
    });
    /* `exercicio` do helper tem padrão 2027; para o pré-precatório ele é
       apagado logo abaixo, porque é justamente a AUSÊNCIA dele que cria o vão. */
    await prisma.processo.update({ where: { id: pre.id }, data: { exercicio: null } });

    const precatorio = await semearProcesso({
      organizationId,
      sigla: 'TRF5',
      exercicio: 2027,
      numeroPrecatorio: '0002222-22.2026.4.05.0000',
    });
    return { pre, precatorio };
  }

  it('a fila COMUM da operação interna não mostra o pré-precatório — é o vão', async () => {
    /* Este caso fixa o comportamento que motivou o módulo. Se um dia a fila
       comum passar a mostrá-los, é aqui que a mudança aparece — e aí o módulo
       precisa ser repensado, em vez de duplicar a lista. */
    const { org } = await semearOrganizacao();
    const { precatorio } = await baseMista(org.id);

    const fila = await carteira.fila({ usuario: interno(org.id), pagina: 1, porPagina: 50 });

    expect(fila.itens.map((i) => i.id)).toEqual([precatorio.id]);
  });

  it('o MÓDULO mostra o pré-precatório para a operação interna', async () => {
    const { org } = await semearOrganizacao();
    const { pre } = await baseMista(org.id);

    const r = await carteira.fila({
      usuario: interno(org.id),
      pagina: 1,
      porPagina: 50,
      semLote: true,
      fases: ['TRANSITO_EM_JULGADO', 'CALCULOS_HOMOLOGADOS', 'REQUISITORIO_EXPEDIDO', 'PRECATORIO_AUTUADO'],
    });

    expect(r.itens.map((i) => i.id)).toEqual([pre.id]);
    expect(r.itens[0].fase).toBe('CALCULOS_HOMOLOGADOS');
  });

  it('e NÃO mostra o precatório expedido — a lista é fechada, não "tudo menos"', async () => {
    /* Por exclusão, uma fase nova no enum entraria sozinha neste módulo, e a
       primeira notícia seria o cliente vendo algo que ninguém decidiu pôr aqui.
       Mesmo raciocínio de `FASES_DISTRIBUIVEIS`. */
    const { org } = await semearOrganizacao();
    await baseMista(org.id);

    const r = await carteira.fila({
      usuario: interno(org.id),
      pagina: 1,
      porPagina: 50,
      semLote: true,
      fases: ['TRANSITO_EM_JULGADO', 'CALCULOS_HOMOLOGADOS', 'REQUISITORIO_EXPEDIDO', 'PRECATORIO_AUTUADO'],
    });

    expect(r.itens.every((i) => i.fase !== 'PRECATORIO_EXPEDIDO')).toBe(true);
  });

  it('o cliente só vê o que lhe foi LIBERADO, mesmo sem recorte de lote', async () => {
    /**
     * ⚠ A ASSERÇÃO DE SEGURANÇA DESTE ARQUIVO.
     *
     * `semLote: true` remove o recorte de EXIBIÇÃO. Ele não pode, nem por
     * acidente, remover o recorte de ACESSO — que é `escopoProcessos`, e é o que
     * troca "processos que a org possui" por "processos liberados a ela". Sem
     * esta distinção, o módulo entregaria a base inteira a qualquer cliente.
     */
    const { org } = await semearOrganizacao();
    const { pre } = await baseMista(org.id);
    const outro = await semearProcesso({
      organizationId: org.id,
      sigla: 'TJMT',
      fase: 'REQUISITORIO_EXPEDIDO',
      numeroPrecatorio: '5009999-99.2026.8.11.0041',
    });
    await prisma.processo.update({ where: { id: outro.id }, data: { exercicio: null } });

    const cliente = await semearCliente('Escritório com um só liberado');
    await liberarProcesso(cliente.org.id, pre.id);

    const r = await carteira.fila({
      usuario: {
        id: cliente.user.id,
        organizationId: cliente.org.id,
        papel: 'CLIENTE',
        tipo: 'CLIENTE',
      } as never,
      pagina: 1,
      porPagina: 50,
      semLote: true,
      fases: ['TRANSITO_EM_JULGADO', 'CALCULOS_HOMOLOGADOS', 'REQUISITORIO_EXPEDIDO', 'PRECATORIO_AUTUADO'],
    });

    /* O liberado, e SÓ ele — o do TJMT existe na base e não é dele. */
    expect(r.itens.map((i) => i.id)).toEqual([pre.id]);
  });

  it('sem `fases`, o módulo não vira a carteira inteira por engano', async () => {
    /* Array vazio ou ausente significa "não pedi recorte", e não "todas". O
       inverso — `in: []` — devolveria ZERO linhas, e a tela apareceria vazia sem
       ninguém saber se é filtro ou base. */
    const { org } = await semearOrganizacao();
    const { pre, precatorio } = await baseMista(org.id);

    const r = await carteira.fila({
      usuario: interno(org.id),
      pagina: 1,
      porPagina: 50,
      semLote: true,
      fases: [],
    });

    expect(r.itens.map((i) => i.id).sort()).toEqual([pre.id, precatorio.id].sort());
  });
});
