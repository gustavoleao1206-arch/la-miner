import {
  DistribuicaoService,
  FASES_DISTRIBUIVEIS,
} from '../../src/modules/distribuicao/distribuicao.service';
import { prisma, limparDados, semearOrganizacao, semearProcesso, encerrar } from './ambiente';

const distribuicao = new DistribuicaoService(prisma as never);

/** As cinco fases do enum, na ordem cronológica em que foram declaradas. */
const TODAS_AS_FASES = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
  'PRECATORIO_EXPEDIDO',
] as const;

async function assinar(organizationId: string, processosPorCiclo: number) {
  const plano = await prisma.plano.create({
    data: {
      nome: `Plano ${processosPorCiclo}-${Math.random().toString(36).slice(2, 8)}`,
      processosPorCiclo,
      preco: 0,
    },
    select: { id: true },
  });
  await prisma.assinatura.create({
    data: { organizationId, planoId: plano.id, status: 'ATIVA' },
  });
}

/**
 * A FASE DO PROCESSO × O SORTEIO DOS 250.
 *
 * ── O PROBLEMA QUE ESTA COLUNA RESOLVE ──
 *
 * Não existe passo humano entre "importação concluída" e "cliente recebeu": o
 * sorteio roda por cron e a entrega dispara no pagamento confirmado. Enquanto a
 * base era só de precatórios expedidos, isso não tinha custo. Com
 * pré-precatórios na MESMA tabela, importar passaria a vender na madrugada
 * seguinte — inclusive oportunidades sem valor apurado.
 *
 * ── O QUE ESTES CASOS DEFENDEM, JÁ QUE HOJE A LISTA PERMITE TUDO ──
 *
 * Decisão do dono: pré-precatório entra no sorteio. Então `FASES_DISTRIBUIVEIS`
 * é o enum inteiro e o filtro não recusa nada hoje. Um teste ingênuo — "crie um
 * processo de fase X, veja que ele é sorteado" — passaria mesmo se o filtro
 * fosse apagado dos dois lados, e não valeria nada.
 *
 * O que estes casos aferem — e o que eles NÃO aferem, que importa igual:
 *
 *  ✔ Nenhuma fase some do sorteio por engano. Um valor escrito errado dentro de
 *    `FASES_DISTRIBUIVEIS` não daria erro em lugar nenhum: o Postgres compararia
 *    com texto que nunca casa e aquela fase deixaria de ser entregue, calada.
 *    O primeiro caso pega isso na comparação da lista; o segundo, no número.
 *  ✔ A lista é FIXADA, então estreitá-la — "só entrego o que já tem
 *    requisitório" — reprova o teste e obriga quem mexeu a confirmar que quis.
 *
 *  ✘ NÃO pegam a remoção do filtro de fase do SQL cru de `sortear()`. Conferi
 *    apagando a linha: os três casos continuam verdes. E está certo que
 *    continuem — com a lista permitindo tudo, filtrar ou não dá no mesmo
 *    resultado. Um teste que "pegasse" isso hoje estaria testando a forma do
 *    código, não o comportamento.
 *
 *    ⚠ NO DIA EM QUE A LISTA FOR ESTREITADA, esse buraco deixa de ser inócuo e
 *    vira o defeito mais provável desta mudança: o Prisma recusaria a fase e o
 *    SQL cru a entregaria. Quem tirar uma fase daqui precisa acrescentar, no
 *    mesmo commit, um caso afirmando que ela NÃO é sorteada — é ele que passa a
 *    guardar as duas metades.
 *
 * O risco de as metades divergirem é baixo por construção, não por vigilância:
 * as duas leem a MESMA constante. O que sobra é a linha do SQL existir.
 */
describe('Distribuição × fase do processo', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('a lista de fases distribuíveis é a decisão do dono, fixada aqui', () => {
    /* Lista de PERMISSÃO, nunca de exclusão: fase nova acrescentada ao enum
       nasce FORA do sorteio, e alguém precisa vir aqui assumir a escolha. Se
       este caso falhar, a pergunta certa é "quem decidiu, e o cliente sabe?". */
    expect([...FASES_DISTRIBUIVEIS]).toEqual([...TODAS_AS_FASES]);
  });

  it('o SQL cru do sorteio enxerga as cinco fases — nenhuma some por erro de digitação', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearOrganizacao('Escritório Cliente');
    await prisma.organization.update({ where: { id: cliente.org.id }, data: { tipo: 'CLIENTE' } });
    await assinar(cliente.org.id, 5);

    /* Um processo por fase, e nada mais na base: assim o sorteio de 5 tem de
       devolver exatamente um de cada. Se o valor de uma fase estiver escrito
       errado no SQL cru, ela não casa, vêm 4, e este caso reprova. */
    const porFase = new Map<string, string>();
    for (const fase of TODAS_AS_FASES) {
      const p = await semearProcesso({ organizationId: org.id, fase });
      porFase.set(fase, p.id);
    }

    const r = await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(r.gerado).toBe(true);
    expect(r.liberados).toBe(5);

    const liberados = await prisma.processoLiberado.findMany({
      where: { organizationId: cliente.org.id },
      select: { processo: { select: { fase: true } } },
    });
    const fasesEntregues = liberados.map((l) => l.processo.fase).sort();
    expect(fasesEntregues).toEqual([...TODAS_AS_FASES].sort());
  });

  it('a contagem do Prisma e o sorteio do SQL cru concordam sobre o que resta', async () => {
    /* As duas metades do filtro duplicado, comparadas pelo NÚMERO. `restantesNaBase`
       usa PROCESSO_DISTRIBUIVEL (Prisma); o sorteio usa a cópia à mão. Divergir
       aqui significa que uma das duas está filtrando fase que a outra deixa
       passar — e o sintoma em produção seria uma carteira que não enche até o
       alvo, sem nada no log. */
    const { org } = await semearOrganizacao();
    const cliente = await semearOrganizacao('Escritório Cliente 2');
    await prisma.organization.update({ where: { id: cliente.org.id }, data: { tipo: 'CLIENTE' } });
    await assinar(cliente.org.id, 3);

    for (const fase of TODAS_AS_FASES) {
      await semearProcesso({ organizationId: org.id, fase });
    }

    /* `restantesNaBase` sai do próprio retorno e é contado pelo PRISMA, depois
       de o SQL cru ter sorteado. Se as duas metades discordassem sobre fase, o
       número não fecharia com o que foi liberado. */
    const r = await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(r.liberados).toBe(3);
    expect(r.restantesNaBase).toBe(2);
  });
});
