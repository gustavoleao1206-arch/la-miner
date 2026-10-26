import { EnriquecimentoProcessor } from '../../src/modules/fila/enriquecimento.processor';
import { prisma, limparDados, encerrar } from './ambiente';

/**
 * O DINHEIRO É REGISTRADO ANTES DO TRABALHO QUE PODE FALHAR.
 *
 * ── O DEFEITO QUE ESTES CASOS TRANCAM ──
 *
 * A consulta ao provedor é o único ato irreversível do job. Ela acontecia, e só
 * DEPOIS vinha uma transação grande — criar o enriquecimento, atualizar a
 * pessoa, gravar telefones, e-mails e endereços — com o incremento do contador
 * de consumo ainda mais tarde, fora dela.
 *
 * Qualquer tropeço no meio dessa transação derrubava por rollback a única prova
 * de que o dinheiro tinha sido gasto, e impedia o contador de subir. O erro
 * subia, o BullMQ retentava (`attempts: 3`), a guarda de idempotência procurava
 * a prova, não achava, e o provedor era PAGO OUTRA VEZ. Até três cobranças para
 * a mesma pessoa — e o painel de consumo marcando zero para as três.
 *
 * ── POR QUE ISSO ERA PIOR QUE PERDER DINHEIRO ──
 *
 * O teto diário conta o que foi GRAVADO. Quem falha não grava. A trava de custo
 * afrouxava exatamente quando as coisas davam errado, que é quando ela precisa
 * apertar. Elevá-la de 500 para 2000 antes da importação dos pré-precatórios
 * teria ampliado esse vão, não fechado.
 *
 * ── COMO O CASO FORÇA A FALHA ──
 *
 * O provedor falso devolve um endereço com `uf` de 6 letras. `Endereco.uf` é
 * `VarChar(2)`: o Postgres levanta 22001 na hora do INSERT — dentro da segunda
 * transação, depois de a consulta já ter sido paga. É o gatilho real, não uma
 * exceção plantada: era assim que o dado torto do provedor derrubava o job.
 *
 * (O mapper agora descarta `uf` que não tenha 2 letras, então este dado não
 * chega mais vindo da Contactra. O provedor falso entrega `PessoaEnriquecida`
 * pronta, pulando o mapper de propósito — o que se testa aqui é a resistência
 * do processor a QUALQUER escrita que falhe, não só a essa.)
 */
describe('O registro do gasto sobrevive à falha da gravação', () => {
  beforeEach(async () => {
    await limparDados();
    /* `limparDados` não trunca `api_usage` — ela guarda consumo, não dado de
       teste. Aqui ela precisa zerar, porque o que se mede é o incremento. */
    await prisma.apiUsage.deleteMany({});
  });
  afterAll(encerrar);

  /** Provedor falso que CONTA quantas vezes foi chamado — é a asserção central. */
  function provedorContado(opcoes: {
    status?: 'SUCESSO' | 'SEM_DADOS' | 'ERRO';
    ufQuebrada?: boolean;
  }) {
    const estado = { chamadas: 0 };
    const provider = {
      nome: 'CONTACTRA',
      consultarPorCpf: async () => {
        estado.chamadas += 1;
        return {
          status: opcoes.status ?? 'SUCESSO',
          pessoa: {
            nome: 'MARIA DE SOUZA SANTOS',
            telefones: [{ ddd: '81', numero: '999998888' }],
            emails: [],
            enderecos: opcoes.ufQuebrada
              ? [{ cidade: 'Recife', uf: 'ABCDEF', cep: '50000000' }]
              : [],
          },
          dadosBrutos: { origem: 'teste' },
          custoCreditos: 0.2,
          latenciaMs: 10,
        };
      },
    };
    return { provider, estado };
  }

  function processorCom(provider: unknown) {
    return new EnriquecimentoProcessor(
      prisma as never,
      { get: (_c: string, padrao?: unknown) => padrao } as never,
      provider as never,
      { garantirDisponibilidade: async () => undefined } as never,
    );
  }

  async function umaPessoa() {
    return prisma.pessoa.create({
      data: { cpf: '52998224725', nome: 'MARIA DE SOUZA SANTOS', nomeNormalizado: 'MARIA DE SOUZA SANTOS' },
      select: { id: true },
    });
  }

  const consumo = () =>
    prisma.apiUsage.aggregate({ _sum: { chamadas: true }, where: { provider: 'CONTACTRA' } });

  it('⚠ contatos quebram, mas a consulta paga fica REGISTRADA e CONTABILIZADA', async () => {
    const p = await umaPessoa();
    const { provider, estado } = provedorContado({ ufQuebrada: true });

    await expect(processorCom(provider).process({ data: { pessoaId: p.id }, id: 'j1' } as never))
      .rejects.toThrow();

    expect(estado.chamadas).toBe(1);

    /* As duas provas do gasto, que o rollback antes levava junto. */
    const enriquecimentos = await prisma.enriquecimento.count({ where: { pessoaId: p.id } });
    expect(enriquecimentos).toBe(1);

    const totalizado = await consumo();
    expect(totalizado._sum.chamadas).toBe(1);
  });

  it('⚠ e a retentativa NÃO paga de novo — era aqui que a fatura dobrava', async () => {
    const p = await umaPessoa();
    const { provider, estado } = provedorContado({ ufQuebrada: true });
    const processor = processorCom(provider);

    await expect(processor.process({ data: { pessoaId: p.id }, id: 'j2' } as never)).rejects.toThrow();
    expect(estado.chamadas).toBe(1);

    /* O BullMQ chamaria `process` de novo com o mesmo job. Antes, a guarda não
       achava nada (o rollback tinha apagado) e o provedor era pago outra vez. */
    const segunda = await processor.process({ data: { pessoaId: p.id }, id: 'j2' } as never);

    expect(estado.chamadas).toBe(1);
    expect(segunda.status).toBe('JA_SINCRONIZADO_HOJE');

    const totalizado = await consumo();
    expect(totalizado._sum.chamadas).toBe(1);
  });

  it('o caminho feliz continua gravando tudo — a correção não custou função', async () => {
    const p = await umaPessoa();
    const { provider } = provedorContado({});

    const r = await processorCom(provider).process({ data: { pessoaId: p.id }, id: 'j3' } as never);

    expect(r.status).toBe('SUCESSO');
    expect(await prisma.telefone.count({ where: { pessoaId: p.id } })).toBe(1);
    const pessoa = await prisma.pessoa.findUniqueOrThrow({
      where: { id: p.id },
      select: { statusEnriquecimento: true, conferenciaNome: true },
    });
    expect(pessoa.statusEnriquecimento).toBe('SINCRONIZADO');
    expect(pessoa.conferenciaNome).toBe('CONFERE');
    expect((await consumo())._sum.chamadas).toBe(1);
  });
});

/**
 * A GUARDA PERGUNTA "FOI COBRADO?", NÃO "DEU CERTO?".
 *
 * `SEM_DADOS` é uma consulta feita, respondida e faturada igual a uma que achou
 * a pessoa — a Contactra cobra por consultar, não por encontrar. A guarda
 * filtrava `status: 'SUCESSO'` e deixava esse caso passar direto para uma nova
 * cobrança.
 *
 * Isso não é hipótese remota nos pré-precatórios: ali o CPF foi extraído do
 * TEXTO da publicação, então "CPF sem cadastro no provedor" é justamente a
 * população mais provável.
 */
describe('A guarda de idempotência cobre toda consulta faturada', () => {
  beforeEach(async () => {
    await limparDados();
    await prisma.apiUsage.deleteMany({});
  });
  afterAll(encerrar);

  function provedorContado(status: 'SUCESSO' | 'SEM_DADOS' | 'ERRO') {
    const estado = { chamadas: 0 };
    const provider = {
      nome: 'CONTACTRA',
      consultarPorCpf: async () => {
        estado.chamadas += 1;
        return {
          status,
          pessoa: status === 'SUCESSO' ? { nome: 'X', telefones: [], emails: [], enderecos: [] } : undefined,
          dadosBrutos: {},
          custoCreditos: 0.2,
          latenciaMs: 10,
        };
      },
    };
    return { provider, estado };
  }

  function processorCom(provider: unknown) {
    return new EnriquecimentoProcessor(
      prisma as never,
      { get: (_c: string, padrao?: unknown) => padrao } as never,
      provider as never,
      { garantirDisponibilidade: async () => undefined } as never,
    );
  }

  async function umaPessoa() {
    return prisma.pessoa.create({
      data: { cpf: '52998224725', nome: 'FULANO', nomeNormalizado: 'FULANO' },
      select: { id: true },
    });
  }

  it('⚠ SEM_DADOS hoje BLOQUEIA uma segunda cobrança', async () => {
    const p = await umaPessoa();
    const { provider, estado } = provedorContado('SEM_DADOS');
    const processor = processorCom(provider);

    await processor.process({ data: { pessoaId: p.id }, id: 'a1' } as never);
    expect(estado.chamadas).toBe(1);

    const segunda = await processor.process({ data: { pessoaId: p.id }, id: 'a2' } as never);

    expect(segunda.status).toBe('JA_SINCRONIZADO_HOJE');
    expect(estado.chamadas).toBe(1);
  });

  it('ERRO hoje NÃO bloqueia — ali o provedor pode nem ter sido alcançado', async () => {
    /* A distinção é deliberada. `ERRO` é timeout de rede, 5xx, conexão recusada:
       é exatamente o caso que as três tentativas do BullMQ existem para
       resolver. Bloqueá-lo trocaria um gasto duplicado por uma pessoa que nunca
       chega a ser enriquecida. */
    const p = await umaPessoa();
    const { provider, estado } = provedorContado('ERRO');
    const processor = processorCom(provider);

    await processor.process({ data: { pessoaId: p.id }, id: 'b1' } as never);
    await processor.process({ data: { pessoaId: p.id }, id: 'b2' } as never);

    expect(estado.chamadas).toBe(2);
  });
});
