import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { criarAppDeTeste } from './app-de-teste';
import { limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * ERROS DO MULTIPART EM POST /importacao — 4xx, nunca 500.
 *
 * O multer entra por override no package.json da raiz: o
 * @nestjs/platform-express fixa a versão dele EXATA, e as que o Nest fixa
 * carregam aviso de negação de serviço. Só que o override e o Nest precisam
 * andar juntos:
 *
 *   • do multer 2.4.0 em diante, a mensagem de LIMIT_UNEXPECTED_FILE passou de
 *     "Unexpected field" para "Unexpected file field";
 *   • o @nestjs/platform-express até a 11.2.5 traduzia o erro do multer
 *     comparando a MENSAGEM, e só a partir da 11.2.6 compara o `code`.
 *
 * Medido com o multer 2.5.0 e o Nest 11.1.29: o arquivo enviado num campo com
 * outro nome respondia 500, com stack em nível ERROR no log. O primeiro caso
 * abaixo existe para quebrar se um dos dois for trocado sem o outro.
 */
describe('Importação: erros do upload (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let tokenPara: (userId: string) => Promise<string>;

  beforeAll(async () => {
    ({ app, base, tokenPara } = await criarAppDeTeste());
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
  });
  beforeEach(limparDados);

  const CSV = 'CPF do credor,Credor\n52998224725,MARIA DE SOUZA SANTOS\n';

  async function comoAdmin() {
    const { user } = await semearOrganizacao();
    return tokenPara(user.id);
  }

  function enviar(token: string, campo: string, nomeArquivo: string) {
    return request(app.getHttpServer())
      .post(`${base}/importacao?dryRun=true`)
      .set('Authorization', `Bearer ${token}`)
      .attach(campo, Buffer.from(CSV, 'utf-8'), nomeArquivo);
  }

  it('⚠ arquivo num campo que não é "arquivo" responde 400, e não 500', async () => {
    const token = await comoAdmin();

    const r = await enviar(token, 'planilha', 'carga.csv').expect(400);

    expect(String(r.body.mensagem)).toMatch(/Unexpected file field/);
  });

  it('a extensão recusada pelo fileFilter continua 400, com a mensagem da rota', async () => {
    const token = await comoAdmin();

    const r = await enviar(token, 'arquivo', 'carga.xls').expect(400);

    expect(String(r.body.mensagem)).toMatch(/\.xls/);
  });
});
