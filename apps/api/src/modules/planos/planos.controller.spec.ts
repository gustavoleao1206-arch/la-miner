import { Prisma } from '@miner/database';
import { PlanosController } from './planos.controller';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * A vitrine é a única rota pública que lê uma tabela de negócio. As duas
 * propriedades que este arquivo tranca:
 *
 *   1. o dinheiro chega ao navegador EXATO, em centavos inteiros;
 *   2. a rota devolve uma lista de campos ESCOLHIDA, não a linha inteira.
 *
 * A segunda é a que envelhece bem. Enquanto `planos` tiver seis colunas, um
 * `select: *` pareceria inofensivo; o estrago aparece no dia em que alguém
 * acrescentar `margem`, `custoOperacional` ou `assinantesAtivos` e a página de
 * vendas passar a publicar isso sem que ninguém tenha decidido publicar.
 * Por isso o teste crava a lista de campos pedida ao Prisma, e não só o
 * formato da resposta: é a diferença entre testar o que sai hoje e testar a
 * defesa.
 */

function controllerCom(planos: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(planos);
  const prisma = { plano: { findMany } } as unknown as PrismaService;
  return { controller: new PlanosController(prisma), findMany };
}

const PLANO_UNICO = {
  id: '11111111-1111-1111-1111-111111111111',
  nome: 'Miner 250',
  descricao: '250 precatórios por mês.',
  processosPorCiclo: 250,
  preco: new Prisma.Decimal('799.00'),
  intervaloMeses: 1,
};

describe('PlanosController — a vitrine pública', () => {
  it('devolve o preço em centavos INTEIROS, sem erro de ponto flutuante', async () => {
    const { controller } = controllerCom([PLANO_UNICO]);

    const [plano] = await controller.listar();

    /* 79900 e não 79899.99999999999. O `toBe` é proposital: `toBeCloseTo`
       aceitaria justamente o defeito que este teste existe para pegar. */
    expect(plano.precoCentavos).toBe(79900);
    expect(Number.isInteger(plano.precoCentavos)).toBe(true);
  });

  /**
   * ── OS VALORES DESTA TABELA NÃO SÃO DECORATIVOS ──
   *
   * A primeira versão deste teste usava 799,90 e passava mesmo com a defesa
   * REMOVIDA — descoberto ao trocar o `Decimal.mul` por `Number(preco) * 100`
   * de propósito e ver a suíte seguir verde. Acontece que `799.9 * 100` dá
   * exatamente 79990 em ponto flutuante: o preço do plano é, por acaso, um dos
   * que NÃO quebram.
   *
   * Um teste assim é pior que nenhum: afirma proteger o dinheiro e não protege.
   * Os valores abaixo foram escolhidos por medição, e cada um erra de um jeito
   * diferente — para baixo, para cima, e em ordem de grandeza distinta.
   */
  it.each([
    ['19.99', 1999, 1998.9999999999998],
    ['8.20', 820, 819.9999999999999],
    ['1.10', 110, 110.00000000000001],
    ['0.07', 7, 7.000000000000001],
  ])(
    'R$ %s vira %i centavos — o float daria %d',
    async (valor, esperado, oQueOFloatDaria) => {
      const { controller } = controllerCom([{ ...PLANO_UNICO, preco: new Prisma.Decimal(valor) }]);

      const [plano] = await controller.listar();

      expect(plano.precoCentavos).toBe(esperado);
      /* Crava também o que o caminho errado produziria: se um dia o V8 mudar e
         essa multiplicação virar exata, este `not.toBe` fica trivialmente
         verdadeiro em vez de silenciosamente inútil — e o `toBe` acima
         continua sendo a asserção que vale. */
      expect(plano.precoCentavos).not.toBe(oQueOFloatDaria);
    },
  );

  it('NÃO devolve o campo `preco` cru — só a versão em centavos', async () => {
    /* Dois formatos do mesmo dinheiro na mesma resposta é convite a
       divergência: um dia a interface lê o errado. */
    const { controller } = controllerCom([PLANO_UNICO]);

    const [plano] = await controller.listar();

    expect(plano).not.toHaveProperty('preco');
    expect(plano).toHaveProperty('precoCentavos');
  });

  it('pede ao banco APENAS os campos de vitrine', async () => {
    const { controller, findMany } = controllerCom([PLANO_UNICO]);

    await controller.listar();

    const { select } = findMany.mock.calls[0][0];
    /* Igualdade exata, não `toMatchObject`: acrescentar um campo ao `select`
       tem que ser uma decisão consciente que quebra este teste, e não algo que
       passa despercebido numa revisão. */
    expect(Object.keys(select).sort()).toEqual(
      ['descricao', 'id', 'intervaloMeses', 'nome', 'preco', 'processosPorCiclo'].sort(),
    );
  });

  it('filtra por ativo — plano desativado não aparece na vitrine', async () => {
    /* Desativar é parar de VENDER, não apagar: quem já assina depende da linha
       para a fatura continuar sendo emitida. O filtro é o que separa as duas
       coisas. */
    const { controller, findMany } = controllerCom([]);

    await controller.listar();

    expect(findMany.mock.calls[0][0].where).toEqual({ ativo: true });
  });

  it('ordena do mais barato para o mais caro', async () => {
    const { controller, findMany } = controllerCom([]);

    await controller.listar();

    expect(findMany.mock.calls[0][0].orderBy).toEqual({ preco: 'asc' });
  });

  it('devolve lista vazia sem quebrar quando não há plano ativo', async () => {
    /* O caso do dia do lançamento, antes de o primeiro plano ser cadastrado —
       e o caso de produção hoje, onde a tabela está vazia. A landing precisa
       renderizar mesmo assim. */
    const { controller } = controllerCom([]);

    await expect(controller.listar()).resolves.toEqual([]);
  });
});
