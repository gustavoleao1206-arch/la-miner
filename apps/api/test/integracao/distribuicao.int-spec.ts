import { DistribuicaoService } from '../../src/modules/distribuicao/distribuicao.service';
import { CarteiraService } from '../../src/modules/carteira/carteira.service';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  encerrar,
} from './ambiente';

const distribuicao = new DistribuicaoService(prisma as never);
const carteira = new CarteiraService(prisma as never);

/**
 * Assina um plano de N processos por ciclo, já ATIVO.
 *
 * `inicioEm` existe porque a distribuição passou a recusar competência anterior
 * ao início da assinatura. Um teste que simula ciclos passados precisa de uma
 * assinatura que EXISTIA neles — antes, o cenário era incoerente e só passava
 * porque ninguém conferia a data.
 */
async function assinar(organizationId: string, processosPorCiclo: number, inicioEm?: Date) {
  const plano = await prisma.plano.create({
    data: {
      nome: `Plano ${processosPorCiclo}-${Math.random().toString(36).slice(2, 8)}`,
      processosPorCiclo,
      preco: 0,
    },
    select: { id: true },
  });
  await prisma.assinatura.create({
    data: { organizationId, planoId: plano.id, status: 'ATIVA', ...(inicioEm ? { inicioEm } : {}) },
  });
}

/** Primeiro dia do mês N meses a partir de hoje (negativo = passado). */
function mes(n: number): Date {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Um titular vinculado a vários processos — é o caso dos "irmãos". */
async function titularCom(processoIds: string[], seq: number) {
  const nome = `TITULAR ${seq}`;
  const pessoa = await prisma.pessoa.create({
    data: { cpf: String(seq).padStart(11, '0'), nome, nomeNormalizado: nome },
    select: { id: true },
  });
  for (const processoId of processoIds) {
    await prisma.processoPessoa.create({ data: { processoId, pessoaId: pessoa.id } });
  }
  return pessoa;
}

const liberadosDe = async (organizationId: string) =>
  (
    await prisma.processoLiberado.findMany({ where: { organizationId }, select: { processoId: true } })
  ).map((l) => l.processoId);

describe('Distribuição — o motor que enche a carteira do cliente', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * A régua é SORTEIO, e não mais "os de maior valor".
   *
   * A régua antiga tinha uma consequência que só aparece com vários clientes:
   * como não há exclusividade, todos sacam do mesmo poço — e ordenados por
   * valor, TODOS receberiam exatamente os mesmos processos, na mesma ordem, mês
   * a mês. Cinquenta escritórios ligando para os mesmos titulares na mesma
   * semana.
   *
   * Aferir aleatoriedade exige cuidado: um teste que exige conjuntos diferentes
   * pode falhar por azar. Com 40 processos e 8 sorteados, dois clientes tirarem
   * exatamente a mesma mão tem probabilidade perto de 1 em 76 milhões — e é
   * isso, e não "às vezes dá diferente", que o teste afirma.
   */
  it('sorteia: dois clientes com a MESMA base recebem carteiras diferentes', async () => {
    const { org } = await semearOrganizacao();
    const a = await semearCliente();
    const b = await semearCliente();
    await assinar(a.org.id, 8);
    await assinar(b.org.id, 8);
    for (let i = 0; i < 40; i++) {
      await semearProcesso({ organizationId: org.id, valor: 1000 - i });
    }

    await distribuicao.gerarLote({ organizationId: a.org.id });
    await distribuicao.gerarLote({ organizationId: b.org.id });

    const deA = (await liberadosDe(a.org.id)).sort();
    const deB = (await liberadosDe(b.org.id)).sort();
    expect(deA).toHaveLength(8);
    expect(deB).toHaveLength(8);
    expect(deA).not.toEqual(deB);
  });

  /**
   * SEM EXCLUSIVIDADE: o processo que saiu para um cliente continua disponível
   * para os outros. É decisão de produto — a base é a mesma para todo mundo, e
   * reservar processo por cliente esgotaria o poço em um punhado de assinaturas.
   */
  it('o mesmo processo pode ir para dois clientes diferentes', async () => {
    const { org } = await semearOrganizacao();
    const a = await semearCliente();
    const b = await semearCliente();
    await assinar(a.org.id, 1);
    await assinar(b.org.id, 1);
    const unico = await semearProcesso({ organizationId: org.id, valor: 100 });

    await distribuicao.gerarLote({ organizationId: a.org.id });
    await distribuicao.gerarLote({ organizationId: b.org.id });

    expect(await liberadosDe(a.org.id)).toEqual([unico.id]);
    expect(await liberadosDe(b.org.id)).toEqual([unico.id]);
  });

  /**
   * O valor deixou de filtrar. Antes havia a armadilha do `NULLS FIRST` do
   * Postgres — processo sem valor lançado liderava a distribuição —, e a defesa
   * era um `nulls: 'last'`. Com o sorteio, valor não entra na escolha: o que o
   * teste garante agora é que ninguém fica de fora por não ter valor.
   */
  it('processo sem valor lançado também é distribuído', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const semValor = await semearProcesso({ organizationId: org.id, valor: null });
    await semearProcesso({ organizationId: org.id, valor: 10 });

    await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(await liberadosDe(c.org.id)).toContain(semValor.id);
  });

  /** A regra do produto: o que já foi entregue nunca volta a concorrer. */
  it('o ciclo seguinte nunca repete o que já foi entregue', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    /* Assinatura que já existia nos dois ciclos simulados. Datas RELATIVAS: as
       fixas ("2026-07-10") viravam futuro dependendo do mês em que a suíte
       rodasse, e o teste passaria a falhar sozinho meses depois. */
    await assinar(c.org.id, 2, mes(-3));
    for (const valor of [900, 800, 700, 600]) {
      await semearProcesso({ organizationId: org.id, valor });
    }

    const primeiro = await distribuicao.gerarLote({
      organizationId: c.org.id,
      competencia: mes(-2),
    });
    const segundo = await distribuicao.gerarLote({
      organizationId: c.org.id,
      competencia: mes(-1),
    });

    expect(primeiro.liberados).toBe(2);
    expect(segundo.liberados).toBe(2);
    const ids = await liberadosDe(c.org.id);
    expect(ids).toHaveLength(4);
    /* O ponto: nenhum processo saiu duas vezes para o mesmo cliente. */
    expect(new Set(ids).size).toBe(4);
  });

  /**
   * Entregar metade dos precatórios de uma pessoa é entregar contexto pela
   * metade: o cliente ligaria para o titular achando que ele tem a receber X,
   * quando tem 3X — e a chance de fechar com aquela pessoa passa uma vez só.
   */
  it('os processos-irmãos do mesmo requerente vêm todos juntos', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    /* Cota que comporta tudo: aqui se afere o AGRUPAMENTO, não o teto. */
    await assinar(c.org.id, 5);
    const a1 = await semearProcesso({ organizationId: org.id, valor: 900 });
    const a2 = await semearProcesso({ organizationId: org.id, valor: 10 });
    const a3 = await semearProcesso({ organizationId: org.id, valor: 5 });
    const deOutro = await semearProcesso({ organizationId: org.id, valor: 1 });
    await titularCom([a1.id, a2.id, a3.id], 1);
    await titularCom([deOutro.id], 2);

    const r = await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(r.liberados).toBe(4);
    /* Os três do mesmo titular, juntos — e dois deles contados como parentesco. */
    expect(r.irmaosIncluidos).toBe(2);
    expect((await liberadosDe(c.org.id)).sort()).toEqual([a1.id, a2.id, a3.id, deOutro.id].sort());
  });

  /**
   * ── O QUE MUDOU COM O PLANO ÚNICO ──
   *
   * Os irmãos entravam EM CIMA do alvo, e o lote de 250 saía com 302. A
   * assinatura promete 250; o número na tela do cliente tem de ser esse. Agora a
   * cota é fechada CONTANDO os irmãos.
   *
   * O teste afirma a INVARIANTE, não um conjunto: com sorteio, qual grupo entra
   * varia — o que não varia é que o teto é respeitado e que ninguém chega
   * partido ao meio.
   */
  it('os irmãos entram DENTRO da cota, e o alvo nunca é ultrapassado', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 3);
    const grupo = [];
    for (let i = 0; i < 3; i++) {
      grupo.push(await semearProcesso({ organizationId: org.id, valor: 100 + i }));
    }
    await titularCom(grupo.map((p) => p.id), 1);
    for (let i = 0; i < 5; i++) {
      const avulso = await semearProcesso({ organizationId: org.id, valor: 10 + i });
      await titularCom([avulso.id], 10 + i);
    }

    const r = await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(r.liberados).toBeLessThanOrEqual(3);
    const ids = await liberadosDe(c.org.id);
    /* Ou o grupo inteiro entrou, ou nenhum dele — nunca uma parte. */
    const doGrupo = grupo.filter((p) => ids.includes(p.id)).length;
    expect([0, 3]).toContain(doGrupo);
  });

  /**
   * A exceção da exceção: um requerente com MAIS processos que a cota inteira.
   *
   * Pular esse grupo por não caber o deixaria preso na base para sempre — nenhum
   * mês teria espaço para ele. Então, quando nada foi escolhido ainda, ele entra
   * inteiro mesmo estourando o alvo. É o único caso em que `liberados > alvo`.
   */
  it('requerente com mais processos que a cota entra inteiro, e não pela metade', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const grupo = [];
    for (let i = 0; i < 3; i++) {
      grupo.push(await semearProcesso({ organizationId: org.id, valor: 100 + i }));
    }
    await titularCom(grupo.map((p) => p.id), 1);

    const r = await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(r.alvo).toBe(2);
    expect(r.liberados).toBe(3);
    expect((await liberadosDe(c.org.id)).sort()).toEqual(grupo.map((p) => p.id).sort());
  });

  /**
   * ── O ALERTA DE BASE ESGOTADA ──
   *
   * A base é finita e o cliente paga todo mês. Quando o poço dele seca, o motor
   * devolve "a base não tem processo novo" e segue: a assinatura continua ATIVA,
   * a fatura continua saindo, e o cliente passa a pagar sem receber. Antes disto
   * a única pista era uma linha de log numa rodada de cron das quatro da manhã.
   */
  describe('fôlego da assinatura', () => {
    it('base folgada não acende alerta nenhum', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 2);
      for (let i = 0; i < 20; i++) await semearProcesso({ organizationId: org.id, valor: 10 });

      const f = await distribuicao.folego();

      expect(f.naBase).toBe(20);
      expect(f.clientes[0]).toMatchObject({ ciclosRestantes: 10, situacao: 'OK' });
      expect(f.emAlerta).toBe(0);
    });

    it('quem já recebeu TUDO fica ESGOTADA — está pagando e não recebe mais nada', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 4);
      for (let i = 0; i < 4; i++) await semearProcesso({ organizationId: org.id, valor: 10 });

      await distribuicao.gerarLote({ organizationId: c.org.id });
      const f = await distribuicao.folego();

      expect(f.clientes[0]).toMatchObject({
        jaRecebeu: 4,
        restantesNaBase: 0,
        ciclosRestantes: 0,
        situacao: 'ESGOTADA',
      });
      expect(f.emAlerta).toBe(1);
    });

    /** O aviso que ainda dá para agir: o próximo lote já vem incompleto. */
    it('sobrando menos que a cota, a situação é ULTIMO_CICLO', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 10);
      for (let i = 0; i < 6; i++) await semearProcesso({ organizationId: org.id, valor: 10 });

      const f = await distribuicao.folego();

      expect(f.clientes[0]).toMatchObject({ restantesNaBase: 6, ciclosRestantes: 0, situacao: 'ULTIMO_CICLO' });
      expect(f.emAlerta).toBe(1);
    });

    /**
     * Três ciclos é o prazo para AGIR: importar uma carteira nova leva reunião,
     * planilha e conferência. Com um mês seria avisar tarde; com seis, o alerta
     * ficaria aceso o ano inteiro e o olho aprenderia a pulá-lo.
     */
    it('três ciclos ou menos já é PERTO_DO_FIM; quatro ainda é OK', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 10);
      for (let i = 0; i < 30; i++) await semearProcesso({ organizationId: org.id, valor: 10 });

      expect((await distribuicao.folego()).clientes[0]).toMatchObject({
        ciclosRestantes: 3,
        situacao: 'PERTO_DO_FIM',
      });

      // O trigésimo primeiro processo empurra para quatro ciclos.
      for (let i = 0; i < 10; i++) await semearProcesso({ organizationId: org.id, valor: 10 });
      expect((await distribuicao.folego()).clientes[0]).toMatchObject({
        ciclosRestantes: 4,
        situacao: 'OK',
      });
    });

    /**
     * O inadimplente APARECE na lista (a tela de clientes mostra o fôlego dele),
     * mas não acende alarme: ele não recebe lote enquanto não regularizar, então
     * a base dele acabar não é problema de ninguém hoje.
     */
    it('inadimplente entra na lista, mas não conta como alerta', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 4);
      for (let i = 0; i < 4; i++) await semearProcesso({ organizationId: org.id, valor: 10 });
      await distribuicao.gerarLote({ organizationId: c.org.id });
      await prisma.assinatura.update({
        where: { organizationId: c.org.id },
        data: { status: 'INADIMPLENTE' },
      });

      const f = await distribuicao.folego();

      expect(f.clientes).toHaveLength(1);
      expect(f.clientes[0].situacao).toBe('ESGOTADA');
      expect(f.emAlerta).toBe(0);
    });

    it('assinatura suspensa nem entra na conta', async () => {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      await assinar(c.org.id, 4);
      await semearProcesso({ organizationId: org.id, valor: 10 });
      await prisma.assinatura.update({
        where: { organizationId: c.org.id },
        data: { status: 'SUSPENSA' },
      });

      const f = await distribuicao.folego();

      expect(f.clientes).toHaveLength(0);
      expect(f.emAlerta).toBe(0);
    });

    /**
     * SEM EXCLUSIVIDADE: o fôlego de um cliente não encolhe porque outro
     * recebeu. É a consequência aritmética da regra — e é o que faz 12 mil
     * processos sustentarem 50 clientes pelos mesmos quatro anos que
     * sustentariam um.
     */
    it('o que um cliente recebe não consome o fôlego do outro', async () => {
      const { org } = await semearOrganizacao();
      const a = await semearCliente();
      const b = await semearCliente();
      await assinar(a.org.id, 2);
      await assinar(b.org.id, 2);
      for (let i = 0; i < 10; i++) await semearProcesso({ organizationId: org.id, valor: 10 });

      await distribuicao.gerarLote({ organizationId: a.org.id });
      const f = await distribuicao.folego();

      const deA = f.clientes.find((x) => x.organizationId === a.org.id)!;
      const deB = f.clientes.find((x) => x.organizationId === b.org.id)!;
      expect(deA.restantesNaBase).toBe(8);
      /* B não recebeu nada e continua com a base INTEIRA à disposição — mesmo
         com dois processos já entregues a A. */
      expect(deB.restantesNaBase).toBe(10);
    });
  });

  /** É o que torna seguro o cron ser diário e burro em vez de mensal. */
  it('rodar duas vezes na mesma competência não duplica nada', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    await semearProcesso({ organizationId: org.id, valor: 900 });
    await semearProcesso({ organizationId: org.id, valor: 800 });

    const primeira = await distribuicao.gerarLote({ organizationId: c.org.id });
    const segunda = await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(primeira.gerado).toBe(true);
    expect(segunda.gerado).toBe(false);
    expect(segunda.motivo).toMatch(/já foi gerado/);
    expect(await prisma.processoLiberado.count({ where: { organizationId: c.org.id } })).toBe(2);
    expect(await prisma.loteAssinatura.count()).toBe(1);
  });

  /** A alavanca da inadimplência mora aqui, não no gateway. */
  it('assinatura suspensa não recebe lote novo', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    await semearProcesso({ organizationId: org.id, valor: 900 });
    await prisma.assinatura.update({
      where: { organizationId: c.org.id },
      data: { status: 'SUSPENSA' },
    });

    const r = await distribuicao.gerarLote({ organizationId: c.org.id });

    expect(r.gerado).toBe(false);
    expect(r.motivo).toMatch(/SUSPENSA/);
    expect(await prisma.processoLiberado.count({ where: { organizationId: c.org.id } })).toBe(0);
  });

  it('a simulação diz o que faria e não escreve nada', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    await semearProcesso({ organizationId: org.id, valor: 900 });
    await semearProcesso({ organizationId: org.id, valor: 800 });

    const r = await distribuicao.gerarLote({ organizationId: c.org.id, dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.liberados).toBe(2);
    expect(await observador.processoLiberado.count()).toBe(0);
    expect(await prisma.loteAssinatura.count()).toBe(0);
  });

  /**
   * O fecho das Fases B e C: o que o MOTOR libera é exatamente o que o ESCOPO DE
   * LEITURA passa a enxergar. As duas metades do produto amarradas num teste só.
   */
  it('o que o motor libera é exatamente o que o cliente passa a enxergar', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    await assinar(c.org.id, 1);
    const um = await semearProcesso({ organizationId: org.id, valor: 900 });
    const outro = await semearProcesso({ organizationId: org.id, valor: 100 });

    // Antes do ciclo, a carteira do cliente está vazia.
    expect(await carteira.processo(um.id, c.escopo)).toBeNull();
    expect(await carteira.processo(outro.id, c.escopo)).toBeNull();

    await distribuicao.gerarLote({ organizationId: c.org.id });

    /* QUAL dos dois saiu é sorteio; o que se afere é a amarração entre as duas
       metades do produto. Fixar um id aqui tornaria o teste dependente da régua
       de seleção — que acabou de mudar uma vez e pode mudar de novo. */
    const [liberado] = await liberadosDe(c.org.id);
    const naoLiberado = liberado === um.id ? outro : um;

    expect(await carteira.processo(liberado, c.escopo)).not.toBeNull();
    expect(await carteira.processo(naoLiberado.id, c.escopo)).toBeNull();
    // E o dono continua vendo os dois.
    const dono = { tipo: 'INTERNA' as const, organizationId: org.id, papel: 'ADMIN' as const };
    expect(await carteira.processo(liberado, dono)).not.toBeNull();
    expect(await carteira.processo(naoLiberado.id, dono)).not.toBeNull();
  });

  /**
   * ── A COMPETÊNCIA É CERCADA DOS DOIS LADOS ──
   *
   * `competencia` vem de quem chama, para regerar um mês numa correção
   * operacional. Sem cerca, ela era uma torneira: cada competência tem lote e
   * checagem de duplicidade PRÓPRIOS, então doze chamadas com doze meses
   * futuros liberavam doze cotas de uma vez — cada uma passando por todas as
   * travas existentes, porque nenhuma delas olhava a data.
   *
   * Um ano de carteira entregue num dia, e nada parecendo errado.
   */
  describe('cerca da competência', () => {
    const mesesAFrente = (n: number) => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + n, 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    };

    it('competência no FUTURO é recusada', async () => {
      const { org } = await semearOrganizacao();
      for (let i = 0; i < 5; i++) await semearProcesso({ organizationId: org.id, valor: 1000 + i });
      const c = await semearCliente();
      await assinar(c.org.id, 2);

      await expect(
        distribuicao.gerarLote({ organizationId: c.org.id, competencia: mesesAFrente(1) }),
      ).rejects.toThrow(/futuro/i);

      /* Nada foi liberado — a recusa acontece ANTES de qualquer escrita. */
      expect(await prisma.processoLiberado.count({ where: { organizationId: c.org.id } })).toBe(0);
      expect(await prisma.loteAssinatura.count()).toBe(0);
    });

    it('a torneira fechou: doze meses à frente não viram doze cotas', async () => {
      const { org } = await semearOrganizacao();
      for (let i = 0; i < 30; i++) await semearProcesso({ organizationId: org.id, valor: 1000 + i });
      const c = await semearCliente();
      await assinar(c.org.id, 2);

      for (let mes = 1; mes <= 12; mes++) {
        await expect(
          distribuicao.gerarLote({ organizationId: c.org.id, competencia: mesesAFrente(mes) }),
        ).rejects.toThrow();
      }

      expect(await prisma.processoLiberado.count({ where: { organizationId: c.org.id } })).toBe(0);
    });

    it('competência ANTERIOR ao início da assinatura é recusada', async () => {
      /* Gerar janeiro para quem assinou em junho entrega a cota de um ciclo que
         nunca existiu. */
      const { org } = await semearOrganizacao();
      for (let i = 0; i < 5; i++) await semearProcesso({ organizationId: org.id, valor: 1000 + i });
      const c = await semearCliente();
      await assinar(c.org.id, 2);

      await expect(
        distribuicao.gerarLote({ organizationId: c.org.id, competencia: mesesAFrente(-6) }),
      ).rejects.toThrow(/anterior ao início/i);

      expect(await prisma.processoLiberado.count({ where: { organizationId: c.org.id } })).toBe(0);
    });

    it('o mês corrente continua passando — a cerca não pode barrar o uso normal', async () => {
      const { org } = await semearOrganizacao();
      for (let i = 0; i < 5; i++) await semearProcesso({ organizationId: org.id, valor: 1000 + i });
      const c = await semearCliente();
      await assinar(c.org.id, 2);

      const r = await distribuicao.gerarLote({
        organizationId: c.org.id,
        competencia: mesesAFrente(0),
      });

      expect(r.gerado).toBe(true);
      expect(r.liberados).toBeGreaterThan(0);
    });
  });
});
