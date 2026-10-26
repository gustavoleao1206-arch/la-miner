import { DistribuicaoService } from '../../src/modules/distribuicao/distribuicao.service';
import {
  prisma,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  encerrar,
} from './ambiente';

const distribuicao = new DistribuicaoService(prisma as never);

/**
 * ── PROCESSO NA BASE, FORA DO SORTEIO ──
 *
 * Em 03/10/2026 a reavaliação dos radares de 16–30/09 achou 1.050 processos
 * cujo devedor não é a Fazenda (banco, empresa, reclamação trabalhista contra
 * particular). Decisão do dono: não apagar — sair do sorteio. A marca é
 * `Processo.foraDaDistribuicao`, lida em DOIS lugares que precisam concordar:
 * o `WhereInput` (contagem, irmãos, fôlego) e o SQL cru de `sortear()`.
 */

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

async function titularConferido(processoIds: string[], cpf: string, nome: string) {
  const pessoa = await prisma.pessoa.create({
    data: { cpf, nome, nomeNormalizado: nome, conferenciaNome: 'CONFERE' },
    select: { id: true },
  });
  for (const processoId of processoIds) {
    await prisma.processoPessoa.create({ data: { processoId, pessoaId: pessoa.id } });
  }
}

const marcarFora = (id: string) =>
  prisma.processo.update({ where: { id }, data: { foraDaDistribuicao: 'DEVEDOR_NAO_E_FAZENDA' } });

const liberadosDe = async (organizationId: string) =>
  (
    await prisma.processoLiberado.findMany({
      where: { organizationId },
      select: { processoId: true },
    })
  ).map((l) => l.processoId);

const semearPre = (organizationId: string, valor: number) =>
  semearProcesso({ organizationId, valor, exercicio: null, fase: 'PRECATORIO_AUTUADO' });

describe('Distribuição × processo marcado fora da distribuição', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('o marcado não é sorteado nem CONTADO como disponível', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    /* Cota maior que a base: o que ficar de fora ficou por regra, não por azar. */
    await assinar(cliente.org.id, 10);

    const fazenda = await semearPre(org.id, 100);
    const naoFazenda = await semearPre(org.id, 4_400_000_000);
    await titularConferido([fazenda.id], '39053344705', 'MARIA DE SOUZA');
    await titularConferido([naoFazenda.id], '11144477735', 'JOAO DA SILVA');
    await marcarFora(naoFazenda.id);

    const r = await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(await liberadosDe(cliente.org.id)).toEqual([fazenda.id]);
    /* O gêmeo: a contagem (WhereInput) concorda com o sorteio (SQL cru). Se o
       marcado fosse contado, sobraria 1 e o painel prometeria um ciclo que o
       motor nunca entregaria. */
    expect(r.restantesNaBase).toBe(0);
  });

  it('o marcado não entra como IRMÃO do titular sorteado', async () => {
    /* Os irmãos passam pelo WhereInput, não pelo SQL cru: é o caminho por onde
       um processo segurado poderia entrar pela porta dos fundos. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const fazenda = await semearPre(org.id, 100);
    const irmaoMarcado = await semearPre(org.id, 200);
    await titularConferido([fazenda.id, irmaoMarcado.id], '39053344705', 'MARIA DE SOUZA');
    await marcarFora(irmaoMarcado.id);

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(await liberadosDe(cliente.org.id)).toEqual([fazenda.id]);
  });

  it('não é retroativo: o que já foi liberado continua com quem recebeu', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const pre = await semearPre(org.id, 100);
    await titularConferido([pre.id], '39053344705', 'MARIA DE SOUZA');
    await distribuicao.gerarLote({ organizationId: cliente.org.id });
    expect(await liberadosDe(cliente.org.id)).toEqual([pre.id]);

    await marcarFora(pre.id);

    expect(await liberadosDe(cliente.org.id)).toEqual([pre.id]);
  });
});
