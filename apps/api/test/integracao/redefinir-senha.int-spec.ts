import request from 'supertest';
import type { INestApplication } from '@nestjs/common';

import { AuthService } from '../../src/modules/auth/application/auth.service';
import { EMAIL_PORT, type EmailPort, type RedefinicaoSenha } from '../../src/modules/email/email.port';
import { criarAppDeTeste } from './app-de-teste';
import { encerrar, limparDados, prisma, semearOrganizacao } from './ambiente';

/**
 * ── ESQUECI MINHA SENHA ──
 *
 * Antes disto o botão existia no login e não fazia nada: nem rota, nem
 * handler. O primeiro cliente que esquecesse a senha viraria chamado de
 * suporte resolvido com UPDATE à mão no banco.
 *
 * Estas são as DUAS ÚNICAS rotas do sistema que devolvem acesso sem
 * credencial. Por isso o que se prova aqui não é "funciona", e sim o que NÃO
 * pode acontecer: link que serve duas vezes, link que vale para sempre, e
 * resposta que denuncia quem é cliente.
 */

const SENHA_ANTIGA = 'SenhaAntiga#2026';
const SENHA_NOVA = 'FraseLongaNova#2026';

/** Captura o link como o destinatário o receberia — o token só existe ali. */
class EspiaDeReset {
  recebidos: RedefinicaoSenha[] = [];
  instalar(app: INestApplication) {
    const porta = app.get<EmailPort>(EMAIL_PORT);
    jest
      .spyOn(porta, 'enviarRedefinicaoSenha')
      .mockImplementation(async (dados: RedefinicaoSenha) => {
        this.recebidos.push(dados);
      });
  }
  ultimoToken(): string {
    const link = this.recebidos.at(-1)?.link ?? '';
    return new URL(link).searchParams.get('token') ?? '';
  }
}

describe('Redefinição de senha', () => {
  let app: INestApplication;
  let base: string;
  const espia = new EspiaDeReset();

  beforeAll(async () => {
    const criado = await criarAppDeTeste();
    app = criado.app;
    base = criado.base;
  });

  afterAll(async () => {
    await app.close();
    await encerrar();
  });

  beforeEach(async () => {
    await limparDados();
    espia.recebidos = [];
    espia.instalar(app);
  });

  async function semearUsuario(extra: Record<string, unknown> = {}) {
    const { org } = await semearOrganizacao();
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `esqueci+${Math.random().toString(36).slice(2, 10)}@teste.local`,
        nome: 'Pessoa Esquecida',
        papel: 'ADMIN',
        senhaHash: await AuthService.gerarHash(SENHA_ANTIGA),
        emailConfirmadoEm: new Date(),
        ...extra,
      },
      select: { id: true, email: true },
    });
  }

  const pedir = (email: string) =>
    request(app.getHttpServer()).post(`${base}/auth/esqueci-senha`).send({ email });

  const redefinir = (token: string, senha: string) =>
    request(app.getHttpServer()).post(`${base}/auth/redefinir-senha`).send({ token, senha });

  const logar = (email: string, senha: string) =>
    request(app.getHttpServer()).post(`${base}/auth/login`).send({ email, senha });

  // ── O caminho que devolve a conta ──

  it('o link redefine a senha, e a ANTIGA para de valer', async () => {
    const u = await semearUsuario();

    await pedir(u.email).expect(204);
    const token = espia.ultimoToken();
    expect(token).toHaveLength(43); // 32 bytes em base64url

    await redefinir(token, SENHA_NOVA).expect(204);

    /* O que o cliente quer: entrar de novo. */
    const nova = await logar(u.email, SENHA_NOVA);
    expect(nova.status).toBeLessThan(300);

    /* E o que protege quem foi invadido: a senha velha morre junto. */
    await logar(u.email, SENHA_ANTIGA).expect(401);
  });

  it('derruba TODAS as sessões — inclusive a de quem tenha invadido a conta', async () => {
    const u = await semearUsuario();
    const familia = '22222222-2222-4222-8222-222222222222';
    await prisma.user.update({ where: { id: u.id }, data: { familiaSessaoAtual: familia } });
    await prisma.refreshToken.create({
      data: {
        userId: u.id,
        tokenHash: `hash-${u.id}`,
        familiaId: familia,
        expiraEm: new Date(Date.now() + 7 * 24 * 3_600_000),
      },
    });

    await pedir(u.email).expect(204);
    await redefinir(espia.ultimoToken(), SENHA_NOVA).expect(204);

    /* Recuperar a senha sem derrubar a sessão do invasor devolveria a conta
       para os DOIS. */
    const vivos = await prisma.refreshToken.count({
      where: { userId: u.id, revogadoEm: null },
    });
    expect(vivos).toBe(0);
  });

  it('destranca quem estava bloqueado por tentativas — foi errando que ele chegou aqui', async () => {
    const u = await semearUsuario({
      tentativasFalhas: 5,
      bloqueadoAte: new Date(Date.now() + 15 * 60_000),
    });

    await pedir(u.email).expect(204);
    await redefinir(espia.ultimoToken(), SENHA_NOVA).expect(204);

    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { tentativasFalhas: true, bloqueadoAte: true },
    });
    /* Sair daqui com a senha nova e a porta ainda trancada seria uma
       recuperação que não recupera. */
    expect(depois.tentativasFalhas).toBe(0);
    expect(depois.bloqueadoAte).toBeNull();
  });

  it('o clique no link CONFIRMA o e-mail — é a mesma prova de posse', async () => {
    const u = await semearUsuario({ emailConfirmadoEm: null });

    await pedir(u.email).expect(204);
    await redefinir(espia.ultimoToken(), SENHA_NOVA).expect(204);

    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { emailConfirmadoEm: true },
    });
    /* Quem clicou no link provou posse do e-mail. Exigir a confirmação DEPOIS
       disso seria pedir duas vezes o que já foi demonstrado uma. */
    expect(depois.emailConfirmadoEm).not.toBeNull();
  });

  // ── O que não pode acontecer ──

  it('o link serve UMA vez: o segundo uso é recusado', async () => {
    const u = await semearUsuario();
    await pedir(u.email).expect(204);
    const token = espia.ultimoToken();

    await redefinir(token, SENHA_NOVA).expect(204);
    await redefinir(token, 'OutraSenhaQualquer#9').expect(400);

    /* E a senha continua sendo a da PRIMEIRA redefinição. */
    const r = await logar(u.email, SENHA_NOVA);
    expect(r.status).toBeLessThan(300);
  });

  it('link vencido não redefine nada', async () => {
    const u = await semearUsuario();
    await pedir(u.email).expect(204);
    const token = espia.ultimoToken();

    await prisma.user.update({
      where: { id: u.id },
      data: { senhaResetExpiraEm: new Date(Date.now() - 1_000) },
    });

    await redefinir(token, SENHA_NOVA).expect(400);
    await logar(u.email, SENHA_ANTIGA).expect((r) => expect(r.status).toBeLessThan(300));
  });

  it('token forjado recebe a MESMA mensagem do vencido — diferença viraria oráculo', async () => {
    const u = await semearUsuario();
    await pedir(u.email).expect(204);
    const token = espia.ultimoToken();
    await prisma.user.update({
      where: { id: u.id },
      data: { senhaResetExpiraEm: new Date(Date.now() - 1_000) },
    });

    const vencido = await redefinir(token, SENHA_NOVA).expect(400);
    const forjado = await redefinir('t'.repeat(43), SENHA_NOVA).expect(400);

    expect(forjado.body.mensagem).toBe(vencido.body.mensagem);
  });

  it('e-mail que não existe responde IGUAL e não manda nada', async () => {
    const existente = await semearUsuario();

    const a = await pedir(existente.email).expect(204);
    const b = await pedir('nao-existe-em-lugar-nenhum@teste.local').expect(204);

    /* Byte a byte: é isso que impede a rota de virar um verificador de quais
       escritórios são clientes nossos. */
    expect(b.status).toBe(a.status);
    expect(JSON.stringify(b.body)).toBe(JSON.stringify(a.body));
    expect(espia.recebidos).toHaveLength(1);
  });

  it('usuário desativado não recebe link — desligar alguém não pode ser reversível por e-mail', async () => {
    const u = await semearUsuario({ ativo: false });

    await pedir(u.email).expect(204);

    expect(espia.recebidos).toHaveLength(0);
  });

  it('pedir de novo INVALIDA o link anterior', async () => {
    const u = await semearUsuario();
    await pedir(u.email).expect(204);
    const primeiro = espia.ultimoToken();

    await pedir(u.email).expect(204);
    const segundo = espia.ultimoToken();
    expect(segundo).not.toBe(primeiro);

    /* Quem pede duas vezes clica no e-mail mais recente; o antigo tem que
       morrer, senão dois links válidos convivem. */
    await redefinir(primeiro, SENHA_NOVA).expect(400);
    await redefinir(segundo, SENHA_NOVA).expect(204);
  });

  it('senha curta é recusada pela validação, sem consumir o link', async () => {
    const u = await semearUsuario();
    await pedir(u.email).expect(204);
    const token = espia.ultimoToken();

    await redefinir(token, 'curta').expect(400);

    /* O link sobrevive ao erro de digitação: recusar E queimar o token faria a
       pessoa pedir outro e-mail por causa de uma senha fraca. */
    await redefinir(token, SENHA_NOVA).expect(204);
  });
});
