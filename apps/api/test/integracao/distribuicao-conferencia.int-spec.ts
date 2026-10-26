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
 * ── O CPF DO PRÉ-PRECATÓRIO PODE NÃO SER DE QUEM A PLANILHA DIZ ──
 *
 * Na base de precatórios o CPF vem do tribunal. Nos pré-precatórios ele é
 * EXTRAÍDO DE TEXTO: o dígito verificador prova que o número é bem formado, não
 * que seja daquele credor. O enriquecimento compara o nome da planilha com o do
 * titular real do CPF e grava o veredito em `Pessoa.conferenciaNome`.
 *
 * Medido em produção em 08/09/2026, logo depois da primeira rodada real: de
 * 1.169 pré-precatórios, 239 vieram `DIVERGE`. Sem a trava que estes casos
 * fixam, o sorteio de 01/10 entregaria esses 239 a um escritório pagante — que
 * ligaria para um estranho, e o estranho teria recebido tratamento de dado
 * pessoal que ninguém justificou.
 *
 * ── POR QUE O SEGUNDO CASO É O MAIS IMPORTANTE DESTE ARQUIVO ──
 *
 * A trava é lista de NEGAÇÃO, e a tentação óbvia é inverter para lista de
 * permissão ("só distribuir CONFERE"). Isso esvaziaria o produto: a comparação
 * de nome nasceu com os pré-precatórios e só roda no enriquecimento, então os
 * 12.425 precatórios dos TRFs — enriquecidos antes dela existir — estão TODOS
 * em `NAO_CONFERIDO` (amostra de 1.925, zero conferidos). O caso do
 * `NAO_CONFERIDO` distribuível é o que faz essa inversão falhar em vez de
 * chegar em produção como lote vazio no dia 1º.
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

async function titularDe(
  processoIds: string[],
  cpf: string,
  nome: string,
  conferenciaNome: 'NAO_CONFERIDO' | 'CONFERE' | 'DIVERGE',
) {
  const pessoa = await prisma.pessoa.create({
    data: { cpf, nome, nomeNormalizado: nome, conferenciaNome },
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

/** Pré-precatório: exercício nulo, fase anterior ao precatório expedido. */
const semearPre = (organizationId: string, valor: number) =>
  semearProcesso({ organizationId, valor, exercicio: null, fase: 'PRECATORIO_AUTUADO' });

describe('Distribuição × conferência de nome (CPF extraído de texto)', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('o processo cujo CPF DIVERGE do nome não entra no sorteio', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    /* Cota maior que a base: o motor tenta levar tudo, então o que ficar de fora
       ficou por regra e não por azar do `ORDER BY random()`. */
    await assinar(cliente.org.id, 10);

    const bons = [await semearPre(org.id, 100), await semearPre(org.id, 200)];
    const suspeitos = [await semearPre(org.id, 300), await semearPre(org.id, 400)];

    await titularDe(
      bons.map((p) => p.id),
      '39053344705',
      'MARIA DE SOUZA',
      'CONFERE',
    );
    await titularDe(
      suspeitos.map((p) => p.id),
      '11144477735',
      'JOAO DA SILVA',
      'DIVERGE',
    );

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    const liberados = await liberadosDe(cliente.org.id);
    expect(liberados.sort()).toEqual(bons.map((p) => p.id).sort());
    for (const p of suspeitos) expect(liberados).not.toContain(p.id);
  });

  it('NAO_CONFERIDO CONTINUA distribuível — é o estado da carteira inteira dos TRFs', async () => {
    /* Se alguém trocar a negação por permissão, é aqui que quebra. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const precatorio = await semearProcesso({ organizationId: org.id, valor: 500 });
    await titularDe([precatorio.id], '39053344705', 'MARIA DE SOUZA', 'NAO_CONFERIDO');

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(await liberadosDe(cliente.org.id)).toEqual([precatorio.id]);
  });

  it('⚠ PRÉ-PRECATÓRIO não conferido NÃO vai — o precatório expedido no mesmo estado vai', async () => {
    /* Decisão de 20/09/2026. Fora do expedido o CPF vem de TEXTO: "não
       conferido" é "ninguém verificou", e onde deu para verificar o método mais
       fraco do radar errava 61% das vezes. No expedido o CPF vem de campo
       oficial, e a base inteira dos TRFs está nesse estado por história. Os dois
       lados da regra no MESMO sorteio, para a fase ser a única diferença. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const expedido = await semearProcesso({ organizationId: org.id, valor: 500 });
    const preSemConferencia = await semearPre(org.id, 900);
    const preConferido = await semearPre(org.id, 100);
    await titularDe([expedido.id], '39053344705', 'MARIA DE SOUZA', 'NAO_CONFERIDO');
    await titularDe([preSemConferencia.id], '11144477735', 'JOAO', 'NAO_CONFERIDO');
    await titularDe([preConferido.id], '52998224725', 'ANA LIMA', 'CONFERE');

    const r = await distribuicao.gerarLote({ organizationId: cliente.org.id });

    const liberados = await liberadosDe(cliente.org.id);
    expect(liberados.sort()).toEqual([expedido.id, preConferido.id].sort());
    expect(liberados).not.toContain(preSemConferencia.id);
    /* E o gêmeo: a CONTAGEM (WhereInput) concorda com o SORTEIO (SQL cru). Três
       na base, dois entregues, um segurado — não sobra nada para prometer. */
    expect(r.restantesNaBase).toBe(0);
  });

  it('o bloqueado também não é CONTADO como disponível', async () => {
    /* O sorteio e a contagem são consultas diferentes — o SQL cru e o
       `WhereInput`. Travar só a primeira faria a tela prometer um fôlego de base
       que o motor nunca entregaria, e a diferença só apareceria meses depois,
       como lote curto sem explicação. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 1);

    const bom = await semearPre(org.id, 100);
    const suspeito = await semearPre(org.id, 200);
    await titularDe([bom.id], '39053344705', 'MARIA DE SOUZA', 'CONFERE');
    await titularDe([suspeito.id], '11144477735', 'JOAO DA SILVA', 'DIVERGE');

    const r = await distribuicao.gerarLote({ organizationId: cliente.org.id });

    expect(await liberadosDe(cliente.org.id)).toEqual([bom.id]);
    /* Dois na base, um bloqueado, um entregue: não sobra nada. Se o DIVERGE
       fosse contado, viria 1 e o painel prometeria mais um ciclo. */
    expect(r.restantesNaBase).toBe(0);
  });

  it('processo com dois titulares sai de circulação se UM deles diverge', async () => {
    /* Mesmo critério que a exclusão do titular já aplica: entre entregar o
       processo com uma parte errada e segurar o processo inteiro, o lado seguro
       do erro é segurar. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    await assinar(cliente.org.id, 10);

    const compartilhado = await semearPre(org.id, 900);
    const soDela = await semearPre(org.id, 100);

    await titularDe([compartilhado.id, soDela.id], '39053344705', 'MARIA DE SOUZA', 'CONFERE');
    await titularDe([compartilhado.id], '11144477735', 'JOAO DA SILVA', 'DIVERGE');

    await distribuicao.gerarLote({ organizationId: cliente.org.id });

    const liberados = await liberadosDe(cliente.org.id);
    expect(liberados).toContain(soDela.id);
    expect(liberados).not.toContain(compartilhado.id);
  });
});
