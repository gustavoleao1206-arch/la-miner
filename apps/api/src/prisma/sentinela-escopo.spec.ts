import { Prisma } from '@miner/database';

import {
  ACOES_EM_MASSA,
  MARCA_GLOBAL,
  MODELOS_TENANT,
  avaliar,
  escopoGlobal,
  modoDoAmbiente,
  temEscopoDeOrganizacao,
} from './sentinela-escopo';

/**
 * O sentinela é função pura de ponta a ponta — por isso estes casos rodam em
 * milissegundos, sem banco. A parte que toca o Prisma de verdade tem prova
 * própria em `test/integracao/sentinela-escopo.int-spec.ts`.
 */
describe('sentinela — quais modelos têm dono', () => {
  /**
   * Deriva do schema em vez de repetir a lista, e este caso é o que garante que
   * a derivação continua acontecendo. Uma lista à mão erra de duas formas
   * silenciosas: o modelo novo com `organizationId` que ninguém somou (fica
   * desprotegido) e o que perdeu a coluna e continua barrado (alarme falso).
   */
  it('sai do schema, não de uma lista escrita à mão', () => {
    const doSchema = Prisma.dmmf.datamodel.models
      .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
      .map((m) => m.name)
      .sort();

    expect([...MODELOS_TENANT].sort()).toEqual(doSchema);
    expect(doSchema.length).toBeGreaterThan(10);
  });

  it('usa PascalCase — é a forma que o middleware recebe', () => {
    /* Escrito em camelCase (`processoLiberado`, como se chama no client), o
       sentinela nunca dispararia: `params.model` chega `ProcessoLiberado`. E o
       silêncio passaria por "não quebrou nada" em qualquer teste distraído. */
    expect(MODELOS_TENANT.has('ProcessoLiberado')).toBe(true);
    expect(MODELOS_TENANT.has('processoLiberado')).toBe(false);
  });

  it('NÃO cobre as tabelas de titular, que não têm dono — e isso é desenho', () => {
    /* A base de pessoas é compartilhada entre todos os escritórios por decisão
       de produto: quem separa é a LIBERAÇÃO, não a coluna. Fixar aqui evita que
       alguém "conserte" a ausência delas achando que é esquecimento. */
    for (const semDono of ['Pessoa', 'Telefone', 'Email', 'Endereco', 'Enriquecimento']) {
      expect(MODELOS_TENANT.has(semDono)).toBe(false);
    }
  });
});

describe('sentinela — enxergar o escopo onde ele realmente mora', () => {
  it('acha no primeiro nível', () => {
    expect(temEscopoDeOrganizacao({ organizationId: 'x' })).toBe(true);
  });

  it('acha DENTRO de relação — é a forma de `escopoProcessos`', () => {
    /* `{ liberacoes: { some: { organizationId } } }` é o escopo do CLIENTE.
       Um detector que só olhasse o topo reprovaria a consulta mais correta do
       sistema. */
    expect(temEscopoDeOrganizacao({ liberacoes: { some: { organizationId: 'x' } } })).toBe(true);
  });

  it('acha dentro de AND, OR e NOT', () => {
    expect(temEscopoDeOrganizacao({ AND: [{ estagio: 'NOVO' }, { organizationId: 'x' }] })).toBe(true);
    expect(temEscopoDeOrganizacao({ OR: [{ organizationId: 'x' }, { organizationId: 'y' }] })).toBe(true);
    expect(temEscopoDeOrganizacao({ NOT: { organizationId: 'x' } })).toBe(true);
  });

  it('não confunde: filtro sem escopo é sem escopo', () => {
    expect(temEscopoDeOrganizacao({ estagio: 'NOVO', prioridade: 3 })).toBe(false);
    expect(temEscopoDeOrganizacao({ processo: { tribunalId: 'x' } })).toBe(false);
    expect(temEscopoDeOrganizacao(undefined)).toBe(false);
    expect(temEscopoDeOrganizacao(null)).toBe(false);
  });

  it('não caminha por array de escalares — seria custo por elemento, sem ganho', () => {
    /* `id: { in: [250 uuids] }` é o formato do cron de distribuição. Um uuid não
       contém filtro; percorrê-los é trabalho puro. */
    const muitos = { id: { in: Array.from({ length: 250 }, (_, i) => `uuid-${i}`) } };
    expect(temEscopoDeOrganizacao(muitos)).toBe(false);
  });

  it('objeto com ciclo não trava a requisição', () => {
    const a: Record<string, unknown> = { estagio: 'NOVO' };
    a.eu = a;
    expect(temEscopoDeOrganizacao(a)).toBe(false);
  });
});

describe('sentinela — o veredito', () => {
  it('ignora modelo sem dono, por mais aberta que seja a consulta', () => {
    expect(avaliar({ model: 'Pessoa', action: 'findMany', args: {} })).toBeNull();
  });

  it('ignora ação que não varre a tabela', () => {
    /* O padrão da casa é verificar-e-agir: confirma a org num `findFirst`
       escopado e só então chama `update({ where: { id } })`. Barrar `update`
       derrubaria CRM, negociação e cobrança para proteger do que a verificação
       anterior já cobriu. */
    expect(avaliar({ model: 'CarteiraProcesso', action: 'update', args: { where: { id: 'x' } } })).toBeNull();
    expect(avaliar({ model: 'CarteiraProcesso', action: 'findFirst', args: {} })).toBeNull();
  });

  it('ignora filtro ancorado na chave primária — não há o que proteger', () => {
    /* A autenticação atualiza `users` e `refresh_tokens` por `id` a cada
       requisição. Sem esta isenção o detector gritaria no caminho mais quente do
       sistema, e alarme falso constante é o que faz alguém desligá-lo. */
    expect(avaliar({ model: 'User', action: 'updateMany', args: { where: { id: 'x' } } })).toBeNull();
    expect(
      avaliar({ model: 'User', action: 'updateMany', args: { where: { id: { in: ['a', 'b'] } } } }),
    ).toBeNull();
  });

  it('a âncora vale só no primeiro nível — id de relação não é identidade da linha', () => {
    const v = avaliar({
      model: 'CarteiraProcesso',
      action: 'findMany',
      args: { where: { processo: { id: 'x' } } },
    });
    expect(v).toEqual({ global: false, escopada: false });
  });

  it('reprova varredura de tabela com dono, sem escopo', () => {
    const v = avaliar({ model: 'CarteiraProcesso', action: 'findMany', args: { where: { estagio: 'NOVO' } } });
    expect(v).toEqual({ global: false, escopada: false });
  });

  it('aprova a mesma varredura quando o escopo está lá', () => {
    const v = avaliar({
      model: 'CarteiraProcesso',
      action: 'findMany',
      args: { where: { organizationId: 'x', estagio: 'NOVO' } },
    });
    expect(v).toEqual({ global: false, escopada: true });
  });

  it('consulta declarada global passa, e o motivo viaja junto', () => {
    const args = escopoGlobal('cron de cobrança varre todas as assinaturas', { where: { status: 'ATIVA' } });
    expect(avaliar({ model: 'Assinatura', action: 'findMany', args })).toEqual({
      global: true,
      motivo: 'cron de cobrança varre todas as assinaturas',
    });
  });

  it('a marca é invisível para quem serializa os argumentos', () => {
    /* Não enumerável de propósito: o Prisma recebe os mesmos argumentos de
       sempre, e nenhum `JSON.stringify` de log vaza a marca. */
    const args = escopoGlobal('motivo', { where: { status: 'ATIVA' } });
    expect(Object.keys(args)).toEqual(['where']);
    expect(JSON.stringify(args)).toBe('{"where":{"status":"ATIVA"}}');
    expect((args as Record<symbol, unknown>)[MARCA_GLOBAL]).toBe('motivo');
  });
});

describe('sentinela — o modo', () => {
  it('BLOQUEIA por padrão na suíte — a rede fechou', () => {
    /* O passo 3 do plano escrito no módulo: cada consulta legítima ganhou
       `escopoGlobal`, as falhas ganharam escopo, e a suíte passou a reprovar a
       próxima omissão em vez de só registrá-la. Se este caso voltar a esperar
       'avisar', a rede reabriu — e isso precisa ser uma decisão, não um acidente. */
    expect(modoDoAmbiente({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe('bloquear');
  });

  it('fora da suíte segue AVISANDO — produção bloquear é decisão à parte', () => {
    /* Em produção um bloqueio é um 500, e o sentinela não distingue rota de
       cron. Ligar lá é `SENTINELA_ESCOPO=bloquear`, explícito. */
    expect(modoDoAmbiente({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('avisar');
    expect(modoDoAmbiente({} as NodeJS.ProcessEnv)).toBe('avisar');
  });

  it('a variável vence o padrão, inclusive para desligar', () => {
    expect(modoDoAmbiente({ NODE_ENV: 'test', SENTINELA_ESCOPO: 'desligado' } as NodeJS.ProcessEnv)).toBe('desligado');
    expect(modoDoAmbiente({ NODE_ENV: 'production', SENTINELA_ESCOPO: 'bloquear' } as NodeJS.ProcessEnv)).toBe('bloquear');
  });

  it('valor inválido não vira comportamento surpresa: cai no padrão', () => {
    expect(modoDoAmbiente({ NODE_ENV: 'production', SENTINELA_ESCOPO: 'sim' } as NodeJS.ProcessEnv)).toBe('avisar');
  });
});

describe('sentinela — a lista de ações', () => {
  it('cobre exatamente o que varre a tabela', () => {
    expect([...ACOES_EM_MASSA].sort()).toEqual([
      'aggregate',
      'count',
      'deleteMany',
      'findMany',
      'groupBy',
      'updateMany',
    ]);
  });
});
