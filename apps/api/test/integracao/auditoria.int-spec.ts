import { AuditoriaService } from '../../src/modules/auditoria/auditoria.service';
import { prisma, limparDados, semearOrganizacao, semearCliente, encerrar } from './ambiente';

const auditoria = new AuditoriaService(prisma as never);

/**
 * A trilha de auditoria, do ponto de vista do ISOLAMENTO entre organizações.
 *
 * `ConsultaCliente` não tem `organizationId` próprio: pertence à organização
 * PELO USUÁRIO que consultou. Toda leitura precisa reescrever esse laço, e é
 * exatamente aí que uma delas escapou.
 */
describe('Auditoria — escopo por organização', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /**
   * Registra N consultas em nome de um usuário — um minuto no PASSADO.
   *
   * ── POR QUE NÃO "AGORA" ──
   *
   * Sem data, o `resumo` usa a janela padrão, que termina em `new Date()` — e o
   * Node trunca no milissegundo, enquanto o `criadoEm` que o Postgres grava tem
   * MICROSSEGUNDOS. Com o banco local respondendo em menos de 1 ms, a consulta
   * inserida por último cai no mesmo milissegundo do fim da janela, e
   * 10.123456 > 10.123: ela fica de fora e o total vem 1 em vez de 2. Medido em
   * 22/09/2026: em 200 leituras, o relógio do banco ficou À FRENTE de um
   * `new Date()` tirado DEPOIS dele em 86; o caso falhava uma rodada em quatro.
   *
   * A correção é aqui, e não no serviço: em produção, entre gravar uma consulta
   * e alguém abrir o resumo passam segundos, não microssegundos. O que este
   * bloco testa é o ESCOPO por organização, e a data só precisa estar
   * seguramente dentro da janela.
   */
  async function consultar(userId: string, quantas: number, termo = 'MARIA') {
    const umMinutoAtras = new Date(Date.now() - 60_000);
    for (let i = 0; i < quantas; i++) {
      await prisma.consultaCliente.create({
        data: { userId, tipo: 'NOME', termo: `${termo} ${i}`, totalResultados: 1, criadoEm: umMinutoAtras },
      });
    }
  }

  /**
   * ── O VAZAMENTO QUE ESTAVA AQUI ──
   *
   * `resumo` monta um `where` do Prisma com `user: { organizationId }` e um
   * comentário dizendo que sem essa trava um ADMIN leria dado de outro tenant.
   * E então chamava `serieDiaria`, que rodava SQL CRU filtrando só por data — o
   * escopo ficava para trás na fronteira do Prisma.
   *
   * O gráfico diário contava as consultas da plataforma inteira: não vazava o
   * conteúdo, mas entregava o VOLUME de atividade de todos os clientes a
   * qualquer um deles, inclusive concorrentes entre si.
   */
  it('a série diária conta só a PRÓPRIA organização', async () => {
    const casa = await semearOrganizacao();
    const outro = await semearCliente('Concorrente');

    await consultar(casa.user.id, 2);
    await consultar(outro.user.id, 7);

    const r = await auditoria.resumo({} as never, casa.org.id);

    expect(r.totalConsultas).toBe(2);
    /* O ponto: a soma da SÉRIE tem de bater com o total. Antes dava 9 —
       o gráfico mostrava movimento que não era desta casa. */
    const somaDaSerie = r.serieDiaria.reduce((s, d) => s + d.total, 0);
    expect(somaDaSerie).toBe(2);
  });

  it('organização sem consulta nenhuma vê série zerada, não a dos outros', async () => {
    const casa = await semearOrganizacao();
    const outro = await semearCliente('Concorrente');
    await consultar(outro.user.id, 5);

    const r = await auditoria.resumo({} as never, casa.org.id);

    expect(r.totalConsultas).toBe(0);
    expect(r.serieDiaria.reduce((s, d) => s + d.total, 0)).toBe(0);
    /* A série continua tendo pontos (um por dia do período) — o gráfico não
       pode encolher o eixo só porque não houve movimento. */
    expect(r.serieDiaria.length).toBeGreaterThan(0);
  });
});

/**
 * A rota que a tela sempre chamou e que não existia.
 *
 * A falha era MUDA: o front tem `.catch(() => setUsuarios([]))` e o bloco do
 * filtro é condicional a `usuarios.length > 0`. O seletor "Usuário" nunca
 * aparecia, e nada denunciava — a capacidade existia inteira (o backend já
 * aceitava `?userId=`) e estava inalcançável.
 */
describe('Auditoria — opções do filtro "Usuário"', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  async function consultar(userId: string, quantas: number) {
    for (let i = 0; i < quantas; i++) {
      await prisma.consultaCliente.create({
        data: { userId, tipo: 'CPF', termo: `termo ${i}`, totalResultados: 1 },
      });
    }
  }

  it('lista quem consultou, do mais ativo para o menos', async () => {
    const { org } = await semearOrganizacao();
    const a = await prisma.user.create({
      data: { organizationId: org.id, email: `a${Date.now()}@t.local`, nome: 'ANA', papel: 'OPERADOR', senhaHash: 'x' },
      select: { id: true },
    });
    const b = await prisma.user.create({
      data: { organizationId: org.id, email: `b${Date.now()}@t.local`, nome: 'BRUNO', papel: 'OPERADOR', senhaHash: 'x' },
      select: { id: true },
    });

    await consultar(a.id, 2);
    await consultar(b.id, 5);

    const lista = await auditoria.usuariosComConsulta(org.id);

    expect(lista.map((u) => u.nome)).toEqual(['BRUNO', 'ANA']);
    expect(lista[0].consultas).toBe(5);
    expect(lista[1].consultas).toBe(2);
  });

  it('quem NUNCA consultou fica de fora', async () => {
    /* Listar todo mundo encheria o filtro de gente que nunca aparece na
       tabela — e num escritório grande esconderia quem de fato consulta. */
    const { org, user } = await semearOrganizacao();
    await prisma.user.create({
      data: { organizationId: org.id, email: `inerte${Date.now()}@t.local`, nome: 'INERTE', papel: 'OPERADOR', senhaHash: 'x' },
    });
    await consultar(user.id, 1);

    const lista = await auditoria.usuariosComConsulta(org.id);

    expect(lista).toHaveLength(1);
    expect(lista.map((u) => u.nome)).not.toContain('INERTE');
  });

  it('NÃO lista usuário de outra organização', async () => {
    /* Sem o escopo, o filtro entregaria nome e e-mail dos funcionários de
       outro cliente para quem abrisse a auditoria. */
    const casa = await semearOrganizacao();
    const outro = await semearCliente('Concorrente');

    await consultar(casa.user.id, 1);
    await consultar(outro.user.id, 3);

    const lista = await auditoria.usuariosComConsulta(casa.org.id);

    expect(lista).toHaveLength(1);
    expect(lista[0].id).toBe(casa.user.id);
    const cru = JSON.stringify(lista);
    expect(cru).not.toContain(outro.user.id);
  });

  it('sem consulta nenhuma devolve lista vazia, não erro', async () => {
    const { org } = await semearOrganizacao();
    expect(await auditoria.usuariosComConsulta(org.id)).toEqual([]);
  });

  it('não devolve CPF — é lista de operadores, não de titulares', async () => {
    const { org, user } = await semearOrganizacao();
    await prisma.consultaCliente.create({
      data: { userId: user.id, tipo: 'CPF', termo: '39053344705', cpfConsultado: '39053344705', totalResultados: 1 },
    });

    const cru = JSON.stringify(await auditoria.usuariosComConsulta(org.id));

    expect(cru).not.toContain('39053344705');
  });
});
