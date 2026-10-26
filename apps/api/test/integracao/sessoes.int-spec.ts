import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { TokenService } from '../../src/modules/auth/application/token.service';
import { criarAppDeTeste, criarUsuario } from './app-de-teste';
import { prisma, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * Revogação de sessão.
 *
 * O que se prova aqui não é "os refresh tokens foram marcados" — isso já
 * funcionava. É que o ACCESS token, que é auto-contido e valia até expirar,
 * passa a ser recusado na hora.
 *
 * Sem isso, "encerrei as sessões" era uma promessa cumprida 15 minutos depois,
 * e a troca de senha — o que se faz ao suspeitar de invasão — deixava o
 * invasor dentro por esse tempo.
 */
describe('Sessões — revogação com efeito imediato', () => {
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
  const tokens = () => app.get(TokenService);

  /** Uma rota qualquer que exija autenticação — serve de sonda. */
  const sondar = (token: string) =>
    http().get(`${base}/carteira/tribunais`).set('Authorization', `Bearer ${token}`);

  it('o access token JÁ EMITIDO deixa de valer na hora', async () => {
    const { user } = await semearOrganizacao();
    const token = await tokenPara(user.id);

    // Vale antes.
    await sondar(token).expect(200);

    await tokens().revogarTodasDoUsuario(user.id);

    /* O ponto do teste. Antes, este mesmo token seguia valendo por até 15
       minutos — a revogação só alcançava o refresh. */
    const r = await sondar(token).expect(401);
    expect(JSON.stringify(r.body)).toMatch(/Sess[aã]o encerrada/i);
  });

  it('um token emitido DEPOIS da revogação vale normalmente', async () => {
    /* O contraponto indispensável: sem ele, um bug que recusasse tudo
       passaria como "revogação funcionando" — e ninguém mais entraria. */
    const { user } = await semearOrganizacao();
    await tokens().revogarTodasDoUsuario(user.id);

    /* `iat` tem resolução de SEGUNDOS: um token emitido no mesmo segundo da
       revogação cai junto, de propósito (é o lado seguro do erro). A espera
       reproduz o caso real — o usuário loga depois de ser avisado. */
    await new Promise((r) => setTimeout(r, 1100));

    const novo = await tokenPara(user.id);
    await sondar(novo).expect(200);
  });

  it('revogar um usuário não derruba os outros', async () => {
    const { org, user } = await semearOrganizacao();
    const outro = await criarUsuario(org.id, 'OPERADOR');
    const tokenAlvo = await tokenPara(user.id);
    const tokenOutro = await tokenPara(outro.id);

    await tokens().revogarTodasDoUsuario(user.id);

    await sondar(tokenAlvo).expect(401);
    await sondar(tokenOutro).expect(200);
  });

  it('os refresh tokens caem junto — sessão não volta pela renovação', async () => {
    const { user } = await semearOrganizacao();
    const par = await tokens().emitirPar({
      sub: user.id,
      email: 'x@t.local',
      papel: 'ADMIN',
      org: user.organizationId,
    });

    const r = await tokens().revogarTodasDoUsuario(user.id);
    expect(r.sessoesEncerradas).toBe(1);

    /* Sem isto, bastaria renovar para ganhar um access token novo e válido —
       a revogação duraria até o próximo refresh. */
    await expect(tokens().rotacionar(par.refreshToken)).rejects.toThrow();
  });
});

/**
 * As rotas administrativas: encerrar sem mexer na conta, e ver o que há aberto.
 *
 * Até aqui as únicas saídas eram DESATIVAR (que impede de voltar) ou REDEFINIR
 * A SENHA (que obriga a receber uma nova). Nenhuma serve para "derrube os
 * acessos e me explique depois".
 */
describe('Sessões — rotas administrativas', () => {
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

  it('ADMIN encerra as sessões de um OPERADOR, e a conta continua ativa', async () => {
    const { org, user } = await semearOrganizacao();
    const alvo = await criarUsuario(org.id, 'OPERADOR');
    const tokenAdmin = await tokenPara(user.id);
    const tokenAlvo = await tokenPara(alvo.id);

    const r = await http()
      .post(`${base}/usuarios/${alvo.id}/encerrar-sessoes`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .expect(200);

    expect(r.body.aviso).toMatch(/imediato/i);

    // A sessão caiu...
    await http()
      .get(`${base}/carteira/tribunais`)
      .set('Authorization', `Bearer ${tokenAlvo}`)
      .expect(401);

    // ...e a CONTA segue ativa: é essa a diferença para "desativar".
    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: alvo.id },
      select: { ativo: true },
    });
    expect(depois.ativo).toBe(true);
  });

  it('a ação fica na trilha de auditoria', async () => {
    const { org, user } = await semearOrganizacao();
    const alvo = await criarUsuario(org.id, 'OPERADOR');

    await http()
      .post(`${base}/usuarios/${alvo.id}/encerrar-sessoes`)
      .set('Authorization', `Bearer ${await tokenPara(user.id)}`)
      .expect(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { acao: 'SESSOES_ENCERRADAS' },
      select: { userId: true, entidadeId: true },
    });
    /* Quem tirou quem de dentro — é o que se reconstrói depois. */
    expect(log.userId).toBe(user.id);
    expect(log.entidadeId).toBe(alvo.id);
  });

  it('não dá para derrubar as sessões de quem tem MAIS permissão', async () => {
    /* Mesma trava do A6. Não é escalada de privilégio, mas é negação de
       serviço contra quem está acima — e impedir não custa nada. */
    const { org } = await semearOrganizacao();
    const gestor = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `gestor${Date.now()}@t.local`,
        nome: 'GESTOR',
        papel: 'OPERADOR',
        gestor: true,
        senhaHash: 'x',
      },
      select: { id: true },
    });
    const admin = await criarUsuario(org.id, 'ADMIN', 'alvo');

    await http()
      .post(`${base}/usuarios/${admin.id}/encerrar-sessoes`)
      .set('Authorization', `Bearer ${await tokenPara(gestor.id)}`)
      .expect(403);
  });

  it('usuário de outra organização responde 404, não 403', async () => {
    /* 404 e não 403: dizer "proibido" confirmaria que o id existe, e isso é
       enumeração de usuários de outro tenant. */
    const casa = await semearOrganizacao();
    const outra = await semearOrganizacao('Outra Casa');
    const alvo = await criarUsuario(outra.org.id, 'OPERADOR');

    await http()
      .post(`${base}/usuarios/${alvo.id}/encerrar-sessoes`)
      .set('Authorization', `Bearer ${await tokenPara(casa.user.id)}`)
      .expect(404);
  });

  it('a listagem mostra UMA linha por dispositivo, não por renovação', async () => {
    const { org, user } = await semearOrganizacao();
    const alvo = await criarUsuario(org.id, 'OPERADOR');
    const tokens = app.get(TokenService);

    /* Uma sessão que renovou duas vezes: três registros, uma família. */
    const par = await tokens.emitirPar({
      sub: alvo.id,
      email: 'a@t.local',
      papel: 'OPERADOR',
      org: org.id,
    });
    const p2 = await tokens.rotacionar(par.refreshToken);
    await tokens.rotacionar(p2.refreshToken);

    const r = await http()
      .get(`${base}/usuarios/${alvo.id}/sessoes`)
      .set('Authorization', `Bearer ${await tokenPara(user.id)}`)
      .expect(200);

    expect(await prisma.refreshToken.count({ where: { userId: alvo.id } })).toBe(3);
    /* Sem o agrupamento, a mesma aba apareceria três vezes — e um usuário de
       um dia teria dezenas de linhas. */
    expect(r.body).toHaveLength(1);
  });

  it('sem sessão aberta, a lista vem vazia', async () => {
    const { org, user } = await semearOrganizacao();
    const alvo = await criarUsuario(org.id, 'OPERADOR');

    const r = await http()
      .get(`${base}/usuarios/${alvo.id}/sessoes`)
      .set('Authorization', `Bearer ${await tokenPara(user.id)}`)
      .expect(200);

    expect(r.body).toEqual([]);
  });
});
