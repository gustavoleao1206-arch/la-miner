import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmService } from '../../src/modules/crm/crm.service';
import { prisma, observador, limparDados, semearOrganizacao, semearProcesso, encerrar } from './ambiente';

const crm = new CrmService(prisma as never);

describe('Tarefas — prazo é DIA, não instante', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * A razão de `prazo` ser `@db.Date` e não timestamp.
   *
   * "até 25/07" não pode mudar de valor conforme o fuso de quem abre a tela.
   * Guardado como timestamp, o mesmo bug que fazia data de nascimento aparecer
   * um dia antes em Brasília atingiria prazos — e prazo exibido no dia errado é
   * prazo perdido.
   */
  it('a coluna guarda exatamente o dia informado', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    const tarefa = await crm.criarTarefa(processo.id, autor, {
      titulo: 'Protocolar petição',
      prazo: '2026-07-25',
    });

    /* Lê como TEXTO direto do Postgres: qualquer conversão pelo driver poderia
       mascarar um deslocamento de fuso, que é exatamente o que se testa aqui. */
    const [{ d }] = await prisma.$queryRawUnsafe<{ d: string }[]>(
      `SELECT prazo::text AS d FROM tarefas_processo WHERE id = '${tarefa.id}'`,
    );
    expect(d).toBe('2026-07-25');

    // E volta como meia-noite UTC, para a tela recortar os 10 primeiros chars.
    expect(tarefa.prazo?.toISOString()).toMatch(/^2026-07-25T00:00:00/);
  });

  it('o tipo da coluna é DATE, não timestamp', async () => {
    const [{ tipo }] = await prisma.$queryRawUnsafe<{ tipo: string }[]>(
      `SELECT data_type AS tipo FROM information_schema.columns
        WHERE table_name = 'tarefas_processo' AND column_name = 'prazo'`,
    );
    expect(tipo).toBe('date');
  });

  it('prazo removível, e campo ausente não repõe', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const t = await crm.criarTarefa(processo.id, autor, { titulo: 'x', prazo: '2026-08-10' });

    const semPrazo = await crm.editarTarefa(processo.id, t.id, autor, { prazo: null });
    expect(semPrazo.prazo).toBeNull();

    /* `undefined` é "não mexa", `null` é "apague". Se os dois fossem tratados
       igual, editar só o título reporia ou apagaria o prazo sem ninguém pedir. */
    const soTitulo = await crm.editarTarefa(processo.id, t.id, autor, { titulo: 'outro' });
    expect(soTitulo.prazo).toBeNull();
    expect(soTitulo.titulo).toBe('outro');
  });
});

describe('Tarefas — conclusão', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('conclui gravando o INSTANTE, e reabrir limpa a data', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const t = await crm.criarTarefa(processo.id, autor, { titulo: 'x' });

    expect(t.concluidaEm).toBeNull();

    const feita = await crm.editarTarefa(processo.id, t.id, autor, { concluida: true });
    expect(feita.concluidaEm).toBeInstanceOf(Date);

    /* Reabrir zera a data de propósito: a tarefa volta a estar pendente, e uma
       data de conclusão pendurada numa tarefa aberta mentiria na listagem. */
    const reaberta = await crm.editarTarefa(processo.id, t.id, autor, { concluida: false });
    expect(reaberta.concluidaEm).toBeNull();
  });

  it('editar outro campo não mexe na data de conclusão', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const t = await crm.criarTarefa(processo.id, autor, { titulo: 'x' });

    const feita = await crm.editarTarefa(processo.id, t.id, autor, { concluida: true });
    const depois = await crm.editarTarefa(processo.id, t.id, autor, { titulo: 'renomeada' });

    expect(depois.concluidaEm?.getTime()).toBe(feita.concluidaEm?.getTime());
  });

  /**
   * Diferente da anotação de propósito: anotação é uma AFIRMAÇÃO assinada por
   * alguém; tarefa é trabalho combinado do time, e o caso normal é justamente
   * outra pessoa concluir o que foi atribuído a ela.
   */
  it('qualquer um do time conclui, mas só o criador (ou ADMIN) remove', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const t = await crm.criarTarefa(processo.id, autor, { titulo: 'x' });
    const colega = { ...autor, id: '00000000-0000-4000-8000-000000000000' };

    const feita = await crm.editarTarefa(processo.id, t.id, colega, { concluida: true });
    expect(feita.concluidaEm).not.toBeNull();

    await expect(
      crm.removerTarefa(processo.id, t.id, { ...colega, papel: 'OPERADOR' }),
    ).rejects.toThrow(ForbiddenException);

    await expect(crm.removerTarefa(processo.id, t.id, autor)).resolves.toEqual({ removida: true });
  });

  it('tarefa NÃO gera evento — título é texto livre e o log é append-only', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    const t = await crm.criarTarefa(processo.id, autor, { titulo: 'ligar para a filha' });
    await crm.editarTarefa(processo.id, t.id, autor, { concluida: true });

    expect(await observador.eventoProcesso.count({ where: { processoId: processo.id } })).toBe(0);
  });
});

describe('Tarefas — a fila de trabalho', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * O buraco que `minhasTarefas` fecha: uma tarefa sem responsável não aparece
   * para NINGUÉM. Existe, tem prazo, e fica invisível até alguém abrir por acaso
   * o processo certo — o pior tipo de pendência num escritório.
   */
  it('traz as minhas E as que ninguém assumiu', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.criarTarefa(p.id, autor, { titulo: 'minha', responsavelId: user.id });
    await crm.criarTarefa(p.id, autor, { titulo: 'órfã' });

    const agenda = await crm.minhasTarefas(autor);
    expect(agenda.tarefas.map((t) => t.titulo).sort()).toEqual(['minha', 'órfã']);
  });

  it('não traz tarefa atribuída a outra pessoa', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const outroUser = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'colega@teste.local',
        nome: 'Colega',
        papel: 'OPERADOR',
        senhaHash: 'x',
      },
      select: { id: true },
    });
    const p = await semearProcesso({ organizationId: org.id });

    await crm.criarTarefa(p.id, autor, { titulo: 'minha', responsavelId: user.id });
    await crm.criarTarefa(p.id, autor, { titulo: 'do colega', responsavelId: outroUser.id });

    const agenda = await crm.minhasTarefas(autor);
    expect(agenda.tarefas.map((t) => t.titulo)).toEqual(['minha']);
  });

  it('concluída sai da fila', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });
    const t = await crm.criarTarefa(p.id, autor, { titulo: 'x', responsavelId: user.id });

    expect((await crm.minhasTarefas(autor)).total).toBe(1);
    await crm.editarTarefa(p.id, t.id, autor, { concluida: true });
    expect((await crm.minhasTarefas(autor)).total).toBe(0);
  });

  /** Sem prazo não pode disputar o topo com o que vence amanhã. */
  it('ordena pelo prazo mais apertado, com sem-prazo por último', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.criarTarefa(p.id, autor, { titulo: 'sem prazo', responsavelId: user.id });
    await crm.criarTarefa(p.id, autor, { titulo: 'depois', prazo: '2026-12-01', responsavelId: user.id });
    await crm.criarTarefa(p.id, autor, { titulo: 'urgente', prazo: '2026-07-21', responsavelId: user.id });

    const agenda = await crm.minhasTarefas(autor);
    expect(agenda.tarefas.map((t) => t.titulo)).toEqual(['urgente', 'depois', 'sem prazo']);
  });

  it('não vaza tarefa de outra organização', async () => {
    const a = await semearOrganizacao('A');
    const b = await semearOrganizacao('B');
    const pB = await semearProcesso({ organizationId: b.org.id });
    await crm.criarTarefa(pB.id, b.autor, { titulo: 'só de B' });

    /* A tarefa de B não tem responsável — cai no ramo "órfã" da consulta, que é
       justamente onde o filtro por organização precisa segurar. */
    expect((await crm.minhasTarefas(a.autor)).total).toBe(0);
    expect((await crm.minhasTarefas(b.autor)).total).toBe(1);
  });
});

describe('Tarefas — validações', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('responsável de outra organização é recusado', async () => {
    const a = await semearOrganizacao('A');
    const b = await semearOrganizacao('B');
    const pA = await semearProcesso({ organizationId: a.org.id });

    await expect(
      crm.criarTarefa(pA.id, a.autor, { titulo: 'x', responsavelId: b.user.id }),
    ).rejects.toThrow(NotFoundException);
  });

  it('tarefa de outro processo não é alcançável pela URL deste', async () => {
    const { org, autor } = await semearOrganizacao();
    const p1 = await semearProcesso({ organizationId: org.id });
    const p2 = await semearProcesso({ organizationId: org.id });
    const noP1 = await crm.criarTarefa(p1.id, autor, { titulo: 'do p1' });

    await expect(
      crm.editarTarefa(p2.id, noP1.id, autor, { concluida: true }),
    ).rejects.toThrow(NotFoundException);
  });
});
