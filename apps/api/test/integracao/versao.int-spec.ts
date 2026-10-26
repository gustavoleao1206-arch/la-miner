import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { criarAppDeTeste, criarUsuario } from './app-de-teste';
import { limparDados, semearOrganizacao, semearCliente, encerrar } from './ambiente';

/**
 * A rota que diz QUAL CÓDIGO está rodando.
 *
 * Duas coisas precisam ser verdade ao mesmo tempo, e cada uma tem uma armadilha
 * própria: o valor tem de CHEGAR até a resposta (o zod descarta o que não
 * declara), e a rota NÃO pode ser pública (a classe vizinha é `@Publico()`, e a
 * herança de metadado é silenciosa).
 */
describe('Versão do build', () => {
  let app: INestApplication;
  let base: string;
  let tokenPara: (userId: string) => Promise<string>;

  const SHA = 'abc1234def5678901234567890abcdef12345678';

  beforeAll(async () => {
    /* ANTES de montar a app: o ConfigModule lê `process.env` na compilação do
       módulo, e depois serve de um objeto em cache. */
    process.env.RENDER_GIT_COMMIT = SHA;
    ({ app, base, tokenPara } = await criarAppDeTeste());
  });
  afterAll(async () => {
    delete process.env.RENDER_GIT_COMMIT;
    await app.close();
    await encerrar();
  });
  beforeEach(limparDados);

  const http = () => request(app.getHttpServer());

  /**
   * O caminho inteiro, do ambiente até a resposta.
   *
   * Prova o que só a cadeia montada prova: a variável entra pelo ConfigModule,
   * atravessa a validação de ambiente e sai no corpo. É o caso que denunciaria
   * um dia em que a validação passasse a ser `.strict()` — aí a chave seria de
   * fato descartada, e esta rota mentiria "não sei" com o valor bem ali.
   */
  it('o commit do ambiente chega na resposta', async () => {
    const { user } = await semearOrganizacao();

    const r = await http()
      .get(`${base}/versao`)
      .set('Authorization', `Bearer ${await tokenPara(user.id)}`)
      .expect(200);

    expect(r.body.commit).toBe(SHA);
    expect(r.body.curto).toBe('abc1234');
    expect(r.body.ambiente).toBe('test');
    /* Um instante no passado, não no futuro: é quando o processo subiu. */
    expect(new Date(r.body.noArDesde).getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * A ARMADILHA DO `@Publico()`.
   *
   * O `HealthController` vizinho é público na CLASSE, e `PUBLICO_KEY` é
   * resolvido com `getAllAndOverride([handler, classe])` — um método que não
   * declare a chave herda o valor da classe, e `@Papeis('ADMIN')` não desfaz
   * isso. Se um dia alguém "simplificar" mudando esta rota para dentro daquele
   * controller, o commit de produção passa a ser público. Este caso é o que
   * denuncia.
   */
  it('sem token → 401: a rota NÃO é pública', async () => {
    await http().get(`${base}/versao`).expect(401);
  });

  it('OPERADOR não vê a versão', async () => {
    const { org } = await semearOrganizacao();
    const op = await criarUsuario(org.id, 'OPERADOR');

    await http()
      .get(`${base}/versao`)
      .set('Authorization', `Bearer ${await tokenPara(op.id)}`)
      .expect(403);
  });

  it('CLIENTE não vê a versão', async () => {
    const c = await semearCliente();

    await http()
      .get(`${base}/versao`)
      .set('Authorization', `Bearer ${await tokenPara(c.user.id)}`)
      .expect(403);
  });
});
