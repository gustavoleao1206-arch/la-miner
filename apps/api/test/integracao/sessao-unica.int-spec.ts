import request from 'supertest';
import { Logger, type INestApplication } from '@nestjs/common';
import { AuthService } from '../../src/modules/auth/application/auth.service';
import { MfaService } from '../../src/modules/auth/application/mfa.service';
import { TokenService } from '../../src/modules/auth/application/token.service';
import { gerarCodigo } from '../../src/modules/auth/application/totp';
import { criarAppDeTeste } from './app-de-teste';
import { prisma, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * UMA SESSÃO POR PESSOA.
 *
 * O CRM é vendido por PERFIS — o escritório paga por 5 e cria 5. Sem esta trava,
 * um login serviria a equipe inteira e o teto de assentos seria decorativo.
 *
 * O que se prova aqui não é "o refresh antigo foi marcado" — isso a revogação já
 * fazia. É que o ACCESS token da sessão anterior, que é auto-contido e valia até
 * expirar, para de valer na requisição SEGUINTE. E, tão importante quanto: que o
 * token do PRÓPRIO login não é derrubado junto.
 */
describe('Sessão única — entrar num lugar encerra o outro', () => {
  let app: INestApplication;
  let base: string;
  let tokenPara: (userId: string) => Promise<string>;

  const SENHA = 'SenhaForte#2026';

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

  /** Rota qualquer que exija autenticação — serve de sonda. */
  const sondar = (token: string) =>
    http().get(`${base}/carteira/tribunais`).set('Authorization', `Bearer ${token}`);

  async function usuarioComSenha() {
    const { org } = await semearOrganizacao();
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `sessao${Date.now()}${Math.floor(Math.random() * 1000)}@teste.local`,
        nome: 'Usuário de Sessão',
        papel: 'ADMIN',
        senhaHash: await AuthService.gerarHash(SENHA),
      },
      select: { id: true, email: true },
    });
  }

  function cookieDe(r: { headers: Record<string, unknown> }): string {
    const bruto = r.headers['set-cookie'] as string[] | undefined;
    const linha = (bruto ?? []).find((c) => c.startsWith('miner_refresh='));
    if (!linha) throw new Error('resposta não trouxe o cookie miner_refresh');
    return linha.split(';')[0];
  }

  /** Um login completo pela HTTP — o que um navegador faria. */
  async function entrar(email: string) {
    const r = await http().post(`${base}/auth/login`).send({ email, senha: SENHA }).expect(200);
    return { access: r.body.accessToken as string, cookie: cookieDe(r) };
  }

  // ── A regra ──

  it('entrar de outro computador derruba a sessão anterior', async () => {
    const u = await usuarioComSenha();

    const escritorio = await entrar(u.email);
    await sondar(escritorio.access).expect(200);

    const casa = await entrar(u.email);
    await sondar(casa.access).expect(200);

    /* O PONTO. Antes desta fase, os dois valiam ao mesmo tempo — e um login
       bastava para o escritório inteiro. */
    const r = await sondar(escritorio.access).expect(401);
    expect(r.body.erro).toBe('OUTRA_SESSAO');
    expect(JSON.stringify(r.body)).toMatch(/outro dispositivo/i);
  });

  /**
   * ⚠ A FRONTEIRA QUE JUSTIFICA O DESENHO INTEIRO.
   *
   * O caminho óbvio seria carimbar `sessoesRevogadasEm = agora` no login. Ele
   * não serve: `iat` do JWT tem resolução de SEGUNDOS e o carimbo tem
   * MILISSEGUNDOS, então um login às 10:00:03.417 emite um token com
   * iat = 10:00:03.000 — ANTERIOR ao próprio marco. O usuário entraria e seria
   * expulso no mesmo gesto, em ~999 de cada 1000 tentativas.
   *
   * Cinco entradas seguidas, cada uma sondada na hora: com o carimbo de tempo
   * este caso falharia quase sempre; com identidade de família não há relógio
   * envolvido.
   */
  it('o token que o PRÓPRIO login acabou de emitir vale imediatamente', async () => {
    const u = await usuarioComSenha();

    for (let i = 0; i < 5; i += 1) {
      const sessao = await entrar(u.email);
      await sondar(sessao.access).expect(200);
    }
  });

  it('a renovação normal não derruba a própria sessão', async () => {
    const u = await usuarioComSenha();
    let { cookie } = await entrar(u.email);

    /* Três rotações seguidas. A sessão única mora na FAMÍLIA, e a rotação a
       preserva — se ela criasse família nova, renovar seria "entrar de novo" e
       a pessoa se derrubaria sozinha a cada 15 minutos. */
    for (let i = 0; i < 3; i += 1) {
      const r = await http().post(`${base}/auth/refresh`).set('Cookie', cookie).expect(200);
      await sondar(r.body.accessToken).expect(200);
      cookie = cookieDe(r);
    }
  });

  /**
   * Duas abas do MESMO navegador são a MESMA sessão.
   *
   * O `sessionStorage` não atravessa abas, então a aba nova nasce sem access
   * token e renova pelo cookie — que é compartilhado. Ela cai na mesma família,
   * e a aba antiga continua valendo.
   *
   * Se "outra aba" derrubasse a sessão, a folha impressa da proposta e qualquer
   * link aberto ao lado expulsariam o usuário do sistema. O que a regra combate
   * é conta compartilhada entre PESSOAS, e essas estão em máquinas diferentes.
   */
  it('uma segunda aba do mesmo navegador entra na MESMA sessão', async () => {
    const u = await usuarioComSenha();
    const aba1 = await entrar(u.email);

    const aba2 = await http()
      .post(`${base}/auth/refresh`)
      .set('Cookie', aba1.cookie)
      .expect(200);

    await sondar(aba2.body.accessToken).expect(200);
    await sondar(aba1.access).expect(200);
  });

  // ── O log de segurança ──

  /**
   * ENTRAR DE OUTRO LUGAR NÃO É ROUBO — e o log não pode dizer que é.
   *
   * `abrirSessaoUnica` revoga os refresh da sessão anterior. Quando aquele
   * navegador renova, ele apresenta um token revogado, que é exatamente a
   * assinatura de um roubo. Sem a porta que vem ANTES da detecção de reuso, todo
   * login num segundo computador gravaria "Reuso de refresh token detectado" —
   * e o alarme deixaria de significar alguma coisa.
   */
  it('a renovação da sessão superada devolve OUTRA_SESSAO, sem alarme falso de reuso', async () => {
    const u = await usuarioComSenha();
    const antiga = await entrar(u.email);
    await entrar(u.email);

    const avisos = jest.spyOn(Logger.prototype, 'warn');
    try {
      const r = await http().post(`${base}/auth/refresh`).set('Cookie', antiga.cookie).expect(401);

      expect(r.body.erro).toBe('OUTRA_SESSAO');
      /* O filtro global loga todo 4xx — o que não pode aparecer é a palavra
         que denuncia roubo. */
      const dito = avisos.mock.calls.flat().join(' ');
      expect(dito).not.toMatch(/reuso/i);
    } finally {
      avisos.mockRestore();
    }
  });

  /* O contraponto: reuso de VERDADE (dentro da sessão atual) continua sendo
     tratado como roubo. Sem este caso, a correção acima poderia ter desligado a
     detecção inteira e ninguém notaria. */
  it('reuso dentro da sessão ATUAL continua derrubando a família', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);

    await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(200);

    const avisos = jest.spyOn(Logger.prototype, 'warn');
    try {
      const r = await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(401);
      expect(JSON.stringify(r.body)).toMatch(/segurança/i);
      expect(avisos.mock.calls.flat().join(' ')).toMatch(/reuso/i);
    } finally {
      avisos.mockRestore();
    }
  });

  // ── Sair ──

  /**
   * Sair passa a valer NA HORA.
   *
   * Antes, `logout` revogava a família e o access token seguia aceito por até
   * 15 minutos: quem tivesse uma cópia continuava dentro depois de o dono ter
   * clicado em "Sair". Zerar `familiaSessaoAtual` fecha essa janela.
   */
  it('sair mata o access token imediatamente, e não em 15 minutos', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);
    await sondar(s.access).expect(200);

    await http().post(`${base}/auth/logout`).set('Cookie', s.cookie).expect(204);

    const r = await sondar(s.access).expect(401);
    expect(r.body.erro).toBe('SESSAO_ENCERRADA');
  });

  /**
   * O logout tardio de uma sessão MORTA não pode derrubar a viva.
   *
   * O caso real: a pessoa entra de casa (o escritório é superado) e, no dia
   * seguinte, o navegador do escritório — que ainda tem o cookie — clica em
   * "Sair". Sem o `if` que compara a família, quem seria expulsa é ela, em casa.
   */
  it('sair de uma sessão já superada não derruba a que está viva', async () => {
    const u = await usuarioComSenha();
    const escritorio = await entrar(u.email);
    const casa = await entrar(u.email);

    await http().post(`${base}/auth/logout`).set('Cookie', escritorio.cookie).expect(204);

    await sondar(casa.access).expect(200);
    const marco = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(marco.familiaSessaoAtual).not.toBeNull();
  });

  // ── Os outros caminhos que abrem ou fecham sessão ──

  it('o segundo fator também abre sessão única', async () => {
    const u = await usuarioComSenha();
    const mfa = app.get(MfaService);
    const agora = () => Math.floor(Date.now() / 1000);

    /* Uma sessão ANTES de ligar o MFA — é ela que precisa cair. */
    const antes = await entrar(u.email);
    await sondar(antes.access).expect(200);

    const { segredo } = await mfa.iniciarCadastro(u.id);
    /* Confirma com o código do período anterior: confirmar gasta aquele
       contador, e o anti-replay recusaria o mesmo código no login. */
    await mfa.confirmarCadastro(u.id, gerarCodigo(segredo, agora() - 30));

    const passo1 = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: SENHA })
      .expect(200);
    expect(passo1.body.mfaRequerido).toBe(true);

    const passo2 = await http()
      .post(`${base}/auth/mfa/verificar`)
      .send({ desafio: passo1.body.desafio, codigo: gerarCodigo(segredo, agora()) })
      .expect(200);

    await sondar(passo2.body.accessToken).expect(200);
    /* Esquecer este caminho daria a quem tem segundo fator — justamente quem
       mais se protege — a sessão simultânea que o resto da plataforma não tem. */
    await sondar(antes.access).expect(401);
  });

  it('encerrar as sessões pelo administrador zera o marco', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);

    await tokens().revogarTodasDoUsuario(u.id);

    const marco = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(marco.familiaSessaoAtual).toBeNull();
    await sondar(s.access).expect(401);
  });

  /**
   * O INSTANTE DO DEPLOY.
   *
   * Quem estiver logado quando esta mudança subir tem um access token SEM `fam`.
   * Recusá-lo derrubaria todo mundo junto, no meio do expediente, sem motivo
   * aparente. Ele passa e expira em 15 minutos; do login seguinte em diante,
   * todos têm família.
   */
  it('token emitido ANTES da mudança (sem família) continua valendo', async () => {
    const u = await usuarioComSenha();
    await entrar(u.email); // marca uma família atual

    const antigo = await tokenPara(u.id); // assinado sem `fam`, como os de antes
    await sondar(antigo).expect(200);
  });

  /**
   * ⚠ O CASO QUE QUASE PASSOU: A SESSÃO QUE ATRAVESSA O DEPLOY.
   *
   * O teste acima NÃO cobre o estado real da publicação, e essa diferença
   * custou caro: ele chama `entrar()` antes, o que já preenche
   * `familiaSessaoAtual`. Na produção, quem está logado na hora do deploy tem a
   * coluna NULA (a migration não faz backfill) e um refresh VIVO.
   *
   * O que acontecia sem a adoção: o access antigo (sem `fam`) passava, expirava
   * em até 15 min, o front renovava, a rotação carimbava `fam` no token novo — e
   * a JwtStrategy o recusava contra a coluna nula. 401. E o front nem mandava
   * para o login, porque o refresh respondia 200: um laço de erro permanente,
   * para TODOS os usuários logados, quinze minutos depois de publicar.
   *
   * Aqui o estado é reproduzido exatamente: `emitirPar` cria a família sem
   * tocar no marco — que é o que o código de ANTES desta fase fazia.
   */
  it('a sessão que atravessa o deploy é ADOTADA na primeira renovação', async () => {
    const u = await usuarioComSenha();

    const antes = await tokens().emitirPar({
      sub: u.id,
      email: u.email,
      papel: 'ADMIN',
      org: (await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).organizationId,
    });

    /* O estado do deploy: família viva, marco NULO. */
    const marcoInicial = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(marcoInicial.familiaSessaoAtual).toBeNull();

    const renovado = await http()
      .post(`${base}/auth/refresh`)
      .set('Cookie', `miner_refresh=${antes.refreshToken}`)
      .expect(200);

    /* Sem a adoção, ESTA linha dava 401 — e o usuário ficava preso. */
    await sondar(renovado.body.accessToken).expect(200);

    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(depois.familiaSessaoAtual).not.toBeNull();

    /* E a trava passa a valer para essa sessão adotada, sem esperar relogin. */
    const outroLugar = await entrar(u.email);
    await sondar(outroLugar.access).expect(200);
    await sondar(renovado.body.accessToken).expect(401);
  });

  // ── O teto de ociosidade ──

  /** Envelhece a sessão mexendo no carimbo da última renovação. */
  async function envelhecer(cookie: string, horas: number) {
    const hash = require('node:crypto')
      .createHash('sha256')
      .update(cookie.replace('miner_refresh=', ''))
      .digest('hex');
    await prisma.refreshToken.update({
      where: { tokenHash: hash },
      data: { criadoEm: new Date(Date.now() - horas * 3_600_000) },
    });
  }

  /**
   * A SESSÃO NÃO ATRAVESSA A NOITE.
   *
   * A aba se pausa aos 30 minutos, mas quem decide isso é o navegador — para o
   * servidor a sessão seguia viva e o cookie seguia valendo. Notebook aberto na
   * sexta às 18h: na segunda, quem sentasse ali clicava em "Continuar
   * trabalhando" e entrava, sem senha e sem segundo fator.
   */
  it('sessão parada além do teto de 8h não renova mais', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);

    await envelhecer(s.cookie, 9);

    const r = await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(401);
    expect(r.body.erro).toBe('SESSAO_OCIOSA');
    expect(JSON.stringify(r.body)).toMatch(/falta de uso/i);
  });

  /**
   * O CONTRAPONTO INDISPENSÁVEL: sem ele, um bug que recusasse TUDO passaria
   * como "teto funcionando" — e ninguém mais renovaria sessão nenhuma.
   *
   * 7h é dentro do teto: quem parou para almoçar, para uma audiência ou para
   * uma tarde inteira continua dentro.
   */
  it('parada de 7h continua renovando — o teto é a noite, não o expediente', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);

    await envelhecer(s.cookie, 7);

    const r = await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(200);
    await sondar(r.body.accessToken).expect(200);
  });

  /**
   * Recusar a renovação não basta: o ACCESS token da sessão ociosa é
   * auto-contido e valeria até expirar. A família cai junto e o marco é zerado.
   */
  it('o teto mata a família inteira, não só a renovação', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);
    await sondar(s.access).expect(200);

    await envelhecer(s.cookie, 9);
    await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(401);

    await sondar(s.access).expect(401);
    const marco = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(marco.familiaSessaoAtual).toBeNull();
  });

  /**
   * ⚠ E O LOG NÃO PODE MENTIR.
   *
   * O cookie de uma noite reapresentado às 8h é o navegador acordando, não um
   * roubo. Se este caminho caísse na detecção de reuso, o log de segurança
   * ganharia um "Reuso de refresh token detectado" todo santo dia, para cada
   * pessoa do escritório — e alarme que toca sempre não significa mais nada.
   */
  it('ociosidade não dispara o alarme de reuso', async () => {
    const u = await usuarioComSenha();
    const s = await entrar(u.email);

    /* ⚠ ROTACIONA PRIMEIRO — é o que faz este caso valer alguma coisa.
       Sem isto o cookie apresentado nunca foi revogado, a detecção de reuso não
       teria motivo para tocar, e o teste passaria mesmo com o teto colocado
       DEPOIS dela: provaria nada sobre a ordem.
       Rotacionando, o cookie antigo fica revogado — e o cenário vira o real: o
       navegador restaurando uma aba de ontem com o cookie velho. Se a ordem
       estiver errada, isso vira "roubo detectado" no log. */
    await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(200);
    await envelhecer(s.cookie, 9);

    const avisos = jest.spyOn(Logger.prototype, 'warn');
    try {
      await http().post(`${base}/auth/refresh`).set('Cookie', s.cookie).expect(401);
      expect(avisos.mock.calls.flat().join(' ')).not.toMatch(/reuso/i);
    } finally {
      avisos.mockRestore();
    }
  });

  /**
   * Reuso detectado é ROUBO — e o ladrão não pode ficar 15 minutos dentro.
   *
   * O roubo típico é o ladrão usar a cópia PRIMEIRO: ele rotaciona, recebe um
   * par novo, e é o dono que dispara a detecção depois, apresentando o token que
   * virou velho. Revogar só os refresh deixava o ACCESS do ladrão valendo até
   * expirar — DEPOIS de o sistema já ter concluído que houve roubo.
   */
  it('a detecção de reuso mata também o access token da família', async () => {
    const u = await usuarioComSenha();
    const dono = await entrar(u.email);

    /* O "ladrão" usa a cópia primeiro e ganha uma sessão viva na mesma família. */
    const ladrao = await http()
      .post(`${base}/auth/refresh`)
      .set('Cookie', dono.cookie)
      .expect(200);
    await sondar(ladrao.body.accessToken).expect(200);

    /* O dono apresenta o token que já foi consumido: é aqui que o roubo aparece. */
    await http().post(`${base}/auth/refresh`).set('Cookie', dono.cookie).expect(401);

    await sondar(ladrao.body.accessToken).expect(401);
    const marco = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { familiaSessaoAtual: true },
    });
    expect(marco.familiaSessaoAtual).toBeNull();
  });
});
