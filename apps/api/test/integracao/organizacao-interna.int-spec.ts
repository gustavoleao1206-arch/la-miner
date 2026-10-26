import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { criarAppDeTeste, criarUsuario } from './app-de-teste';
import { encerrar, limparDados, prisma, semearCliente, semearOrganizacao } from './ambiente';

/**
 * ── R-13 DA AUDITORIA LGPD: ADMIN NÃO É PROVA DE SER DA OPERAÇÃO ──
 *
 * Três rotas operam sobre a base INTEIRA de titulares por desenho — a exclusão
 * do art. 18 precisa alcançar todos os escritórios, e a trilha por CPF responde
 * "quem tocou o dado desta pessoa?". Elas estavam protegidas apenas por
 * `@Papeis('ADMIN')`.
 *
 * E `ADMIN` é coluna de `User`, e `User` pertence a uma organização qualquer. A
 * invariante "ADMIN só existe na organização interna" era convenção do código —
 * as três portas de criação de conta nascem com papel CLIENTE —, mas NADA no
 * banco a impunha. Um ADMIN criado por script, seed ou UPDATE dentro de uma
 * organização cliente lia (e apagava) a base inteira.
 *
 * Estes casos existem porque a defesa agora é regra, e regra sem teste volta a
 * ser convenção na primeira refatoração. O cenário montado é exatamente o que
 * era possível e não devia: um ADMIN DENTRO DE UMA ORGANIZAÇÃO CLIENTE.
 */
describe('Rotas da operação interna (R-13)', () => {
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

  const http = () => request(app.getHttpServer());
  const CPF = '39053344705';

  /** O cenário que não devia existir: ADMIN dentro de organização CLIENTE. */
  async function adminDeEscritorio() {
    const cliente = await semearCliente('Escritório com um ADMIN indevido');
    const u = await criarUsuario(cliente.org.id, 'ADMIN', 'externo');
    return { token: await tokenPara(u.id), orgId: cliente.org.id };
  }

  /** O legítimo: ADMIN da operação. */
  async function adminDaOperacao() {
    const { org } = await semearOrganizacao();
    const u = await criarUsuario(org.id, 'ADMIN', 'interno');
    return { token: await tokenPara(u.id), orgId: org.id };
  }

  it('ADMIN de escritório é RECUSADO nas rotas de titular', async () => {
    const { token } = await adminDeEscritorio();

    for (const rota of ['situacao', 'dados', 'excluir']) {
      const r = await http()
        .post(`${base}/titular/${rota}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cpf: CPF });
      expect(r.status).toBe(403);
      expect(r.body.mensagem ?? r.body.message).toMatch(/operação interna/i);
    }
  });

  it('ADMIN de escritório é RECUSADO na Central de Privacidade', async () => {
    const { token } = await adminDeEscritorio();

    await http().get(`${base}/titular/solicitacoes`).set('Authorization', `Bearer ${token}`).expect(403);
    await http()
      .post(`${base}/titular/solicitacoes`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cpf: CPF, tipo: 'EXCLUSAO' })
      .expect(403);
  });

  it('ADMIN de escritório é RECUSADO na trilha por CPF', async () => {
    /* Era o vazamento concreto: os blocos de `pessoa` e `enriquecimento` dessa
       rota consultam a base compartilhada de titulares, que não tem dono. Um
       ADMIN de escritório confirmava a existência de QUALQUER CPF e lia o nome
       e o histórico de consultas dele — inclusive de titular nunca liberado a
       ele. */
    const { token } = await adminDeEscritorio();

    await http()
      .post(`${base}/auditoria/trilha-cpf`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cpf: CPF })
      .expect(403);
  });

  it('mas o que é DELE continua acessível: a trilha de consultas do próprio escritório', async () => {
    /* A defesa não pode virar bloqueio geral. O admin do escritório perde o que
       nunca deveria ver e mantém o que audita a própria equipe — que já era
       recortado por organização. */
    const { token } = await adminDeEscritorio();

    await http().get(`${base}/auditoria/consultas`).set('Authorization', `Bearer ${token}`).expect(200);
    await http().get(`${base}/auditoria/resumo`).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('o ADMIN da operação passa — a rota continua funcionando para quem ela existe', async () => {
    const { token } = await adminDaOperacao();
    await prisma.pessoa.create({
      data: { cpf: CPF, nome: 'MARIA DE SOUZA', nomeNormalizado: 'MARIA DE SOUZA' },
    });

    await http()
      .post(`${base}/titular/situacao`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cpf: CPF })
      .expect(200);

    await http()
      .post(`${base}/auditoria/trilha-cpf`)
      .set('Authorization', `Bearer ${token}`)
      .send({ cpf: CPF })
      .expect(200);
  });
});
