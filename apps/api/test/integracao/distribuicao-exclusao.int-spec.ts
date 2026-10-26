import { DistribuicaoService } from '../../src/modules/distribuicao/distribuicao.service';
import { TitularService } from '../../src/modules/titular/titular.service';
import {
  prisma,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  encerrar,
} from './ambiente';

const distribuicao = new DistribuicaoService(prisma as never);
const titular = new TitularService(prisma as never);

/**
 * ── R-00 DA AUDITORIA LGPD ──
 *
 * Pedir exclusão não pode significar apenas "perder o telefone". Até aqui
 * significava exatamente isso: `TitularService.excluir` apagava contato,
 * payload do provedor e todo o texto livre do CRM — e o sorteio mensal seguia
 * entregando o precatório da mesma pessoa a escritórios NOVOS, com nome, CPF,
 * número do requisitório e valor. A exclusão retirava o contato e AMPLIAVA a
 * exposição, porque cada nova liberação é mais um controlador recebendo o dado
 * de quem já disse que não queria.
 *
 * Eliminar de vez é impossível aqui, e por um motivo declarado no próprio
 * serviço: CPF e nome vêm do precatório, que é ato público publicado pelo
 * tribunal. O que resta devido, quando a eliminação não cabe, é o BLOQUEIO
 * (art. 18, IV) — parar de tratar. É isso que estes casos fixam.
 *
 * ── POR QUE ESTE ARQUIVO É SEPARADO DE `distribuicao.int-spec.ts` ──
 *
 * Aquele arquivo responde "o motor enche a carteira corretamente?". Este
 * responde "o motor respeita quem saiu?". São perguntas de donos diferentes —
 * a primeira é do comercial, a segunda é do jurídico — e misturá-las faria o
 * dia em que alguém mexer na cota apagar, sem perceber, a garantia da LGPD.
 */

/** Assinatura ATIVA com cota de N processos por ciclo. */
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

/** Um titular ligado a um ou mais processos. `cpf` precisa ser único na tabela. */
async function titularDe(processoIds: string[], cpf: string, nome: string) {
  const pessoa = await prisma.pessoa.create({
    data: { cpf, nome, nomeNormalizado: nome },
    select: { id: true },
  });
  for (const processoId of processoIds) {
    await prisma.processoPessoa.create({ data: { processoId, pessoaId: pessoa.id } });
  }
  return pessoa;
}

const liberadosDe = async (organizationId: string) =>
  (
    await prisma.processoLiberado.findMany({
      where: { organizationId },
      select: { processoId: true },
    })
  ).map((l) => l.processoId);

describe('Distribuição × exclusão do titular (LGPD art. 18)', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('quem pediu exclusão NÃO entra no sorteio', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    /* Cota MAIOR que a base inteira: sem isso o teste passaria por sorte, com o
       processo do excluído simplesmente não tendo sido sorteado naquela rodada.
       Pedindo 10 de 4 disponíveis, o motor tenta levar tudo — e o que ficar de
       fora ficou por regra, não por acaso. */
    await assinar(cliente.org.id, 10);

    const dela = [
      await semearProcesso({ organizationId: org.id, valor: 100 }),
      await semearProcesso({ organizationId: org.id, valor: 200 }),
    ];
    const dele = [
      await semearProcesso({ organizationId: org.id, valor: 300 }),
      await semearProcesso({ organizationId: org.id, valor: 400 }),
    ];
    await titularDe(
      dela.map((p) => p.id),
      '39053344705',
      'MARIA DE SOUZA',
    );
    const excluido = await titularDe(
      dele.map((p) => p.id),
      '11144477735',
      'JOAO DA SILVA',
    );
    await prisma.pessoa.update({
      where: { id: excluido.id },
      data: {
        statusEnriquecimento: 'EXCLUIDO',
        exclusaoEm: new Date(),
        exclusaoMotivo: 'pedido do titular',
      },
    });

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    const liberados = await liberadosDe(cliente.org.id);
    expect(liberados.sort()).toEqual(dela.map((p) => p.id).sort());
    for (const p of dele) expect(liberados).not.toContain(p.id);
  });

  it('atender a exclusão RETIRA o processo das carteiras que já o receberam', async () => {
    const { org, user } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const processo = await semearProcesso({ organizationId: org.id, valor: 500 });
    await titularDe([processo.id], '39053344705', 'MARIA DE SOUZA');

    await distribuicao.gerarLote({ organizationId: cliente.org.id });
    /* O estado ANTES importa: sem esta asserção, um bug que impedisse a
       liberação desde o início faria o caso passar sem provar nada. */
    expect(await liberadosDe(cliente.org.id)).toEqual([processo.id]);

    await titular.excluir('39053344705', 'pedido do titular por e-mail', user.id);

    expect(await liberadosDe(cliente.org.id)).toEqual([]);
  });

  it('o escritório com CONTRATO ASSINADO mantém o processo; o sem contrato perde', async () => {
    /* O recorte que impede a LGPD de destruir uma relação que a própria pessoa
       escolheu. Proposta ACEITA é contrato: ela procurou aquele escritório e
       assinou. O pedido de exclusão é contra o tratamento que ela NÃO escolheu
       — ser distribuída a escritórios novos —, não contra o acordo dela.
       Este serviço já preserva a proposta ACEITA e as parcelas dela; revogar o
       acesso e guardar o contrato seria guardar prova de algo que ninguém mais
       consegue ver. */
    const { org, user } = await semearOrganizacao();
    const comContrato = await semearCliente('Escritório com contrato');
    const semContrato = await semearCliente('Escritório sem contrato');
    await assinar(comContrato.org.id, 10);
    await assinar(semContrato.org.id, 10);

    const processo = await semearProcesso({ organizationId: org.id, valor: 700 });
    await titularDe([processo.id], '39053344705', 'MARIA DE SOUZA');

    await distribuicao.gerarLote({ organizationId: comContrato.org.id });
    await distribuicao.gerarLote({ organizationId: semContrato.org.id });
    expect(await liberadosDe(comContrato.org.id)).toEqual([processo.id]);
    expect(await liberadosDe(semContrato.org.id)).toEqual([processo.id]);

    await prisma.propostaNegociacao.create({
      data: {
        processoId: processo.id,
        organizationId: comContrato.org.id,
        autorId: comContrato.user.id,
        rodada: 1,
        modalidade: 'CESSAO',
        status: 'ACEITA',
      },
    });

    await titular.excluir('39053344705', 'pedido do titular', user.id);

    expect(await liberadosDe(comContrato.org.id)).toEqual([processo.id]);
    expect(await liberadosDe(semContrato.org.id)).toEqual([]);
  });

  it('processo com mais de um titular sai de circulação se UM deles pediu exclusão', async () => {
    /* O lado seguro do erro, e é uma escolha, não um efeito colateral: o
       processo com dois requerentes some da distribuição por causa de um só.
       O outro titular perde a chance de ser procurado — mas a alternativa é
       continuar entregando o dado de quem pediu para sair, e entre as duas a
       lei não deixa dúvida sobre qual erro é aceitável. O mesmo critério que
       `TitularService` já aplica ao apagar texto livre de processo compartilhado. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const compartilhado = await semearProcesso({ organizationId: org.id, valor: 900 });
    const soDela = await semearProcesso({ organizationId: org.id, valor: 100 });

    await titularDe([compartilhado.id, soDela.id], '39053344705', 'MARIA DE SOUZA');
    const excluido = await titularDe([compartilhado.id], '11144477735', 'JOAO DA SILVA');
    await prisma.pessoa.update({
      where: { id: excluido.id },
      data: { statusEnriquecimento: 'EXCLUIDO', exclusaoEm: new Date() },
    });

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    const liberados = await liberadosDe(cliente.org.id);
    expect(liberados).toContain(soDela.id);
    expect(liberados).not.toContain(compartilhado.id);
  });
});
