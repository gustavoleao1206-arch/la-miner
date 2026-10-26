import { PrismaClient } from '@miner/database';

import { escopoGlobal, registrarSentinela } from '../../src/prisma/sentinela-escopo';
import { URL_DE_TESTE, encerrar, limparDados, observador, prisma, semearCliente } from './ambiente';

/**
 * A FIAÇÃO do sentinela, contra o Prisma de verdade.
 *
 * Os casos de unidade provam a DECISÃO (`avaliar`, `temEscopoDeOrganizacao`).
 * Nenhum deles prova que o middleware chega a ser chamado — e é exatamente aí
 * que este tipo de trava costuma morrer em silêncio: lista no formato errado,
 * registro depois da primeira consulta, `$use` que a versão do client não expõe.
 * Um sentinela que nunca dispara passa em qualquer suíte que só verifique
 * "não quebrou nada".
 *
 * Cliente PRÓPRIO, em modo BLOQUEAR explícito: o compartilhado de `ambiente.ts`
 * segue o PADRÃO do ambiente, e um teste que dependesse dele estaria medindo a
 * configuração do dia em vez do mecanismo. O padrão é conferido à parte, no
 * último caso.
 */
const bloqueador = new PrismaClient({
  /* `URL_DE_TESTE`, e NUNCA `process.env.DATABASE_URL`. Escrevi este arquivo com
     o fallback ingênuo (`DATABASE_URL_TEST ?? DATABASE_URL`) e ele leu 5.954
     pessoas REAIS do banco de desenvolvimento — as asserções de lista vazia
     denunciaram. A trava do `_test` mora em `ambiente.ts` e existe justamente
     para este erro; um cliente próprio precisa passar por ela também. */
  datasources: { db: { url: URL_DE_TESTE } },
});
registrarSentinela(bloqueador as never, 'bloquear', () => undefined);

describe('Sentinela de escopo — a fiação', () => {
  beforeEach(limparDados);
  afterAll(async () => {
    await bloqueador.$disconnect();
    await encerrar();
  });

  it('BARRA de verdade uma varredura sem escopo, e diz o que fazer', async () => {
    await expect(bloqueador.carteiraProcesso.findMany({ where: { estagio: 'NOVO' } })).rejects.toThrow(
      /SENTINELA DE ESCOPO: CarteiraProcesso\.findMany/,
    );
  });

  it('a mensagem ensina a saída, em vez de só reprovar', async () => {
    await expect(bloqueador.carteiraProcesso.count({})).rejects.toThrow(/escopoGlobal/);
  });

  it('DEIXA PASSAR a mesma consulta com escopo — e ela roda de verdade', async () => {
    const cliente = await semearCliente();
    await expect(
      bloqueador.carteiraProcesso.findMany({ where: { organizationId: cliente.org.id } }),
    ).resolves.toEqual([]);
  });

  it('deixa passar o escopo que mora DENTRO da relação, como `escopoProcessos` monta', async () => {
    const cliente = await semearCliente();
    await expect(
      bloqueador.processo.findMany({
        where: { liberacoes: { some: { organizationId: cliente.org.id } } },
      }),
    ).resolves.toEqual([]);
  });

  it('a consulta declarada global passa, e o Prisma nunca vê a marca', async () => {
    /* Se a marca vazasse para o Prisma, ele reclamaria de argumento
       desconhecido — então este caso prova as duas coisas de uma vez: a
       declaração funciona e ela é limpa antes do banco. */
    await expect(
      bloqueador.assinatura.findMany(escopoGlobal('cron varre todas as assinaturas', {})),
    ).resolves.toEqual([]);
  });

  it('modelo SEM dono não é assunto do sentinela', async () => {
    /* `Pessoa` é compartilhada entre todos os escritórios por decisão de
       produto. Barrar aqui quebraria a busca inteira. */
    await expect(bloqueador.pessoa.findMany({ where: { nome: { contains: 'X' } } })).resolves.toEqual([]);
  });

  it('o cliente dos SERVIÇOS bloqueia por padrão na suíte — a rede está fechada', async () => {
    /* Até 22/09/2026 este caso provava o contrário ("segue em AVISAR: nada
       quebra hoje"), que era a exigência do dono para LIGAR o detector sem
       mudar o comportamento de ninguém. Com as consultas legítimas marcadas e
       as falhas escopadas, o passo seguinte foi fechar: é por este cliente que
       o código da aplicação passa nos testes, e uma omissão nova reprova aqui. */
    await expect(prisma.carteiraProcesso.findMany({ where: { estagio: 'NOVO' } })).rejects.toThrow(
      /SENTINELA DE ESCOPO/,
    );
  });

  it('o OBSERVADOR das asserções enxerga a tabela inteira — e não vigia nada', async () => {
    /* A outra metade do desenho: o teste pergunta ao banco como observador
       onisciente ("não sobrou linha NENHUMA"), e isso não é código que atende
       cliente. Se este caso falhar, alguém pendurou o sentinela no cliente
       errado — e as ~50 asserções globais da suíte quebrariam juntas. */
    await expect(observador.carteiraProcesso.findMany({ where: { estagio: 'NOVO' } })).resolves.toEqual([]);
  });
});
