import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { TokenService } from '../../src/modules/auth/application/token.service';
import { AuthService } from '../../src/modules/auth/application/auth.service';
import { criarAppDeTeste } from './app-de-teste';
import { prisma, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * O fluxo de refresh ROTATIVO com detecção de reuso — o pedaço mais sensível da
 * autenticação. A garantia que ele oferece: um refresh token roubado é inútil
 * por mais de um uso, e o próprio uso duplicado denuncia o roubo e derruba a
 * sessão inteira. Um bug aqui é silencioso e caro; por isso a cobertura densa.
 */
describe('Refresh token rotativo', () => {
  let app: INestApplication;
  let base: string;
  let tokens: TokenService;

  beforeAll(async () => {
    ({ app, base } = await criarAppDeTeste());
    // Serviços REAIS do container: JwtService e ConfigService de verdade, com os
    // segredos do .env. Só o Prisma aponta para o banco de teste.
    tokens = app.get(TokenService);
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
  });
  beforeEach(async () => {
    await limparDados();
  });

  /** Emite um par inicial para um usuário novo, como um login faria. */
  async function primeiroPar() {
    const { user } = await semearOrganizacao();
    const par = await tokens.emitirPar({
      sub: user.id,
      email: `u${user.id.slice(0, 6)}@teste.local`,
      papel: 'ADMIN',
      org: user.organizationId,
    });
    return { user, par };
  }

  const hash = (t: string) =>
    require('node:crypto').createHash('sha256').update(t).digest('hex');

  // ── Rotação básica ──
  describe('rotação', () => {
    it('devolve um par NOVO e revoga o antigo', async () => {
      const { par } = await primeiroPar();
      const novo = await tokens.rotacionar(par.refreshToken);

      expect(novo.refreshToken).not.toBe(par.refreshToken);
      expect(novo.accessToken).toBeTruthy();

      const antigo = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash(par.refreshToken) },
      });
      expect(antigo.revogadoEm).not.toBeNull();
    });

    it('o novo token continua a MESMA família', async () => {
      const { par } = await primeiroPar();
      const original = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash(par.refreshToken) },
        select: { familiaId: true },
      });

      const novo = await tokens.rotacionar(par.refreshToken);
      const rotacionado = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash(novo.refreshToken) },
        select: { familiaId: true },
      });

      expect(rotacionado.familiaId).toBe(original.familiaId);
    });

    it('a corrente continua: rotacionar o token rotacionado funciona', async () => {
      const { par } = await primeiroPar();
      const segundo = await tokens.rotacionar(par.refreshToken);
      const terceiro = await tokens.rotacionar(segundo.refreshToken);

      expect(terceiro.refreshToken).not.toBe(segundo.refreshToken);
    });

    /**
     * REGRESSÃO de um bug real encontrado ao escrever estes testes.
     *
     * O refresh JWT assinava só `{ sub, familia }`, e o `iat` do JWT tem
     * resolução de SEGUNDOS. Login e refresh acontecem em milissegundos, então
     * os dois tokens caíam no mesmo segundo, saíam byte a byte idênticos, e o
     * `create` estourava o unique de `tokenHash` (P2002) — 500 no cliente, com o
     * token anterior já revogado e a sessão morta.
     *
     * Antes do `jti`, este teste falhava com P2002. Rodar N rotações em rajada
     * (todas no mesmo segundo) é a forma mais direta de trancar a regressão.
     */
    it('rotações em rajada no mesmo segundo não colidem', async () => {
      const { par } = await primeiroPar();
      let atual = par.refreshToken;
      for (let i = 0; i < 5; i++) {
        const novo = await tokens.rotacionar(atual);
        atual = novo.refreshToken;
      }
      // Chegou ao fim da corrente sem P2002.
      expect(atual).not.toBe(par.refreshToken);
    });

    /**
     * O token NUNCA é guardado em claro — só o SHA-256. Vazamento do banco não
     * pode entregar um refresh token utilizável.
     */
    it('o banco guarda só o hash, nunca o token em claro', async () => {
      const { par } = await primeiroPar();
      const registro = await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: hash(par.refreshToken) },
      });
      expect(registro.tokenHash).not.toBe(par.refreshToken);
      expect(registro.tokenHash).toHaveLength(64); // sha256 hex
      // e nenhuma coluna carrega o token bruto
      expect(JSON.stringify(registro)).not.toContain(par.refreshToken);
    });
  });

  // ── Detecção de reuso: o coração da defesa ──
  describe('detecção de reuso', () => {
    /**
     * Usar o mesmo refresh DUAS vezes é o sintoma de roubo: o dono usou uma,
     * o ladrão a outra. A segunda apresentação tem de falhar E derrubar a
     * família inteira, invalidando inclusive o token que a vítima acabou de
     * receber. Assim o roubo não rende sessão a ninguém.
     */
    it('usar o mesmo token duas vezes derruba a família inteira', async () => {
      const { par } = await primeiroPar();

      // Primeiro uso: legítimo, emite um token novo (o que a vítima teria).
      const daVitima = await tokens.rotacionar(par.refreshToken);

      // Segundo uso do MESMO token (o ladrão): tem de ser recusado.
      await expect(tokens.rotacionar(par.refreshToken)).rejects.toThrow(
        /Sessão encerrada por segurança/,
      );

      // E o token que a vítima recebeu no primeiro uso também morre.
      await expect(tokens.rotacionar(daVitima.refreshToken)).rejects.toThrow();

      // Toda a família está revogada.
      const familia = await prisma.refreshToken.findFirst({
        where: { tokenHash: hash(par.refreshToken) },
        select: { familiaId: true },
      });
      const ativos = await prisma.refreshToken.count({
        where: { familiaId: familia!.familiaId, revogadoEm: null },
      });
      expect(ativos).toBe(0);
    });

    it('token de assinatura inválida → 401, sem tocar em nada', async () => {
      await expect(tokens.rotacionar('nao.e.um.jwt')).rejects.toThrow(
        /inválido ou expirado/,
      );
    });

    /**
     * Um JWT com assinatura VÁLIDA mas que nunca foi emitido por nós (não está
     * no banco) não pode ser aceito. Cobre o cenário de um atacante que
     * descobriu o segredo de refresh e forja um token do zero.
     */
    it('token bem assinado mas desconhecido no banco → 401', async () => {
      const { user } = await semearOrganizacao();
      const jwt = app.get(require('@nestjs/jwt').JwtService);
      const config = app.get(require('@nestjs/config').ConfigService);
      const forjado = await jwt.signAsync(
        { sub: user.id, familia: 'familia-inventada' },
        { secret: config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: '7d' },
      );

      await expect(tokens.rotacionar(forjado)).rejects.toThrow(/não reconhecido/);
    });
  });

  // ── Expiração e usuário inativo ──
  describe('recusas de estado', () => {
    it('refresh expirado (no banco) → 401', async () => {
      const { par } = await primeiroPar();
      // O JWT ainda verifica; o que expira é o registro no banco.
      await prisma.refreshToken.update({
        where: { tokenHash: hash(par.refreshToken) },
        data: { expiraEm: new Date(Date.now() - 1000) },
      });

      await expect(tokens.rotacionar(par.refreshToken)).rejects.toThrow(/expirado/);
    });

    it('usuário desativado não rotaciona', async () => {
      const { user, par } = await primeiroPar();
      await prisma.user.update({ where: { id: user.id }, data: { ativo: false } });

      await expect(tokens.rotacionar(par.refreshToken)).rejects.toThrow(/inativo/);
    });
  });

  // ── Logout e troca de senha ──
  describe('revogação', () => {
    it('logout revoga a família: aquele token não rotaciona mais', async () => {
      const { par } = await primeiroPar();
      await tokens.revogarFamilia(par.refreshToken);

      /* Após o logout o token está revogado; apresentá-lo cai no ramo de reuso
         (revogadoEm != null) — recusa por segurança, que é o correto. */
      await expect(tokens.rotacionar(par.refreshToken)).rejects.toThrow();
    });

    it('logout de uma sessão NÃO derruba as outras do mesmo usuário', async () => {
      const { user } = await semearOrganizacao();
      const payload = {
        sub: user.id,
        email: 'u@teste.local',
        papel: 'ADMIN' as const,
        org: user.organizationId,
      };
      /* Duas famílias emitidas DIRETO pelo TokenService — o nível em que emitir
         dois pares continua legítimo (é o que a rotação faz a cada renovação).
         ⚠ NÃO confundir com dois LOGINS: a política de uma sessão por conta
         mora em `abrirSessaoUnica`, e é exercitada em `sessao-unica.int-spec.ts`.
         Pela HTTP, o segundo login mataria o primeiro. */
      const sessaoA = await tokens.emitirPar(payload);
      const sessaoB = await tokens.emitirPar(payload);

      await tokens.revogarFamilia(sessaoA.refreshToken);

      // A morreu, B continua viva.
      await expect(tokens.rotacionar(sessaoA.refreshToken)).rejects.toThrow();
      await expect(tokens.rotacionar(sessaoB.refreshToken)).resolves.toBeTruthy();
    });

    it('revogar todas do usuário derruba TODAS as famílias', async () => {
      const { user } = await semearOrganizacao();
      const payload = {
        sub: user.id,
        email: 'u@teste.local',
        papel: 'ADMIN' as const,
        org: user.organizationId,
      };
      const a = await tokens.emitirPar(payload);
      const b = await tokens.emitirPar(payload);

      await tokens.revogarTodasDoUsuario(user.id);

      await expect(tokens.rotacionar(a.refreshToken)).rejects.toThrow();
      await expect(tokens.rotacionar(b.refreshToken)).rejects.toThrow();
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revogadoEm: null } })).toBe(0);
    });
  });

  // ── Higiene ──
  it('limparExpirados remove só o que passou da retenção de 30 dias', async () => {
    const { user } = await semearOrganizacao();
    const payload = { sub: user.id, email: 'u@teste.local', papel: 'ADMIN' as const, org: user.organizationId };
    const recente = await tokens.emitirPar(payload);

    // Um token bem antigo, além da janela de 30 dias.
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: 'a'.repeat(64),
        familiaId: require('node:crypto').randomUUID(),
        expiraEm: new Date(Date.now() - 40 * 86_400_000),
      },
    });

    const removidos = await tokens.limparExpirados();
    expect(removidos).toBe(1);
    // O recente sobrevive.
    expect(await prisma.refreshToken.count({ where: { tokenHash: hash(recente.refreshToken) } })).toBe(1);
  });
});

/**
 * Os endpoints HTTP de autenticação. Complementam os testes de service acima:
 * aqui o alvo é o transporte — códigos de status, o corpo esperado e o
 * throttling declarado nas rotas.
 */
describe('Auth (HTTP)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    ({ app, base } = await criarAppDeTeste());
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
  });
  beforeEach(async () => {
    await limparDados();
  });

  const http = () => request(app.getHttpServer());

  /** Cria um usuário com senha REAL (argon2), para o login funcionar. */
  async function usuarioComSenha(senha: string) {
    const { org } = await semearOrganizacao();
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `login${Date.now()}@teste.local`,
        nome: 'Login',
        papel: 'ADMIN',
        senhaHash: await AuthService.gerarHash(senha),
      },
      select: { id: true, email: true },
    });
  }

  /** Extrai o cookie de refresh de um `set-cookie`, no formato `nome=valor`. */
  function cookieDe(resposta: { headers: Record<string, unknown> }): string {
    const bruto = resposta.headers['set-cookie'] as string[] | undefined;
    const linha = (bruto ?? []).find((c) => c.startsWith('miner_refresh='));
    if (!linha) throw new Error('resposta não trouxe o cookie miner_refresh');
    return linha.split(';')[0];
  }

  function linhaDoCookie(resposta: { headers: Record<string, unknown> }): string {
    const bruto = resposta.headers['set-cookie'] as string[] | undefined;
    return (bruto ?? []).find((c) => c.startsWith('miner_refresh=')) ?? '';
  }

  /**
   * O CORPO NÃO PODE TRAZER O REFRESH TOKEN.
   *
   * É a asserção central do B3. Se este campo voltar à resposta, o JavaScript
   * volta a enxergá-lo e um XSS volta a poder levá-lo embora — e o cookie
   * httpOnly, que continuaria sendo emitido, viraria teatro.
   */
  it('login → 200 com access no corpo e refresh SÓ no cookie httpOnly', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');

    const r = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);

    expect(r.body.accessToken).toBeTruthy();
    expect(r.body.expiraEm).toBeGreaterThan(0);
    expect(r.body.refreshToken).toBeUndefined();

    const cookie = linhaDoCookie(r);
    expect(cookie).toContain('HttpOnly');
    /* Escopado às rotas de auth: não acompanha as centenas de chamadas da
       carteira, então não aparece em log nem em proxy de quem depura outra
       coisa — e a superfície de CSRF encolhe para duas rotas. */
    expect(cookie).toContain('Path=/api/v1/auth');
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('login com senha errada → 401 (mensagem genérica)', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');

    /* Senha ERRADA mas com 8+ caracteres: precisa passar pelo LoginDto
       (MinLength 8) para chegar na verificação de credencial. Com menos de 8
       o DTO devolve 400 antes, e o teste validaria a coisa errada. */
    const r = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaErrada#0000' })
      .expect(401);
    // Não revela se o e-mail existe.
    expect(r.body.mensagem).toMatch(/Credenciais inválidas/);
  });

  it('senha curta demais → 400 no DTO, sem chegar na verificação', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');
    await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'curta' })
      .expect(400);
  });

  it('e-mail inexistente → 401 com a MESMA mensagem (sem enumeração)', async () => {
    const r = await http()
      .post(`${base}/auth/login`)
      .send({ email: 'nao-existe@teste.local', senha: 'qualquer' })
      .expect(401);
    expect(r.body.mensagem).toMatch(/Credenciais inválidas/);
  });

  it('o ciclo completo pela HTTP, só com o cookie: login → refresh → reuso falha', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');
    const login = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);

    const cookieAntigo = cookieDe(login);

    /* Sem corpo: o refresh vem do cookie. A rotação continua valendo — o cookie
       novo tem de ser DIFERENTE, senão não houve rotação nenhuma. */
    const refresh = await http()
      .post(`${base}/auth/refresh`)
      .set('Cookie', cookieAntigo)
      .expect(200);

    const cookieNovo = cookieDe(refresh);
    expect(cookieNovo).not.toBe(cookieAntigo);
    expect(refresh.body.accessToken).toBeTruthy();
    expect(refresh.body.refreshToken).toBeUndefined();

    // Reapresentar o cookie JÁ usado → 401 (reuso detectado, família revogada).
    await http().post(`${base}/auth/refresh`).set('Cookie', cookieAntigo).expect(401);

    /* E a família caiu junto: o cookie que era bom também morre. Sem isto, a
       detecção de reuso não estaria protegendo nada. */
    await http().post(`${base}/auth/refresh`).set('Cookie', cookieNovo).expect(401);
  });

  it('refresh sem cookie → 401, e não 400', async () => {
    /* Para quem chama, "não estou autenticado" e "minha sessão morreu" levam à
       mesma tela. Um 400 faria o front tratar como erro de programação e não
       redirecionar para o login. */
    await http().post(`${base}/auth/refresh`).expect(401);
  });

  it('refresh recusado APAGA o cookie, senão o front repete para sempre', async () => {
    const r = await http()
      .post(`${base}/auth/refresh`)
      .set('Cookie', 'miner_refresh=nao.e.um.token')
      .expect(401);

    const cookie = linhaDoCookie(r);
    /* Express expira o cookie mandando valor vazio e uma data no passado. */
    expect(cookie).toMatch(/miner_refresh=;/);
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
  });

  /**
   * O refresh NÃO pode mais entrar pelo corpo.
   *
   * Aceitá-lo "por compatibilidade" desfaria o B3 inteiro: um XSS que roubasse
   * o token de uma sessão antiga voltaria a poder usá-lo. `forbidNonWhitelisted`
   * no ValidationPipe recusa o campo — e este teste existe para que ninguém o
   * reintroduza sem perceber.
   */
  it('refresh pelo CORPO é recusado, mesmo com um token válido', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');
    const login = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);

    // O token real, extraído do cookie — a melhor arma que um atacante teria.
    const token = cookieDe(login).split('=').slice(1).join('=');

    await http()
      .post(`${base}/auth/refresh`)
      .send({ refreshToken: token })
      .expect((res) => {
        if (res.status === 200) {
          throw new Error('o refresh pelo corpo foi ACEITO — o B3 foi desfeito');
        }
      });
  });

  it('logout apaga o cookie e revoga a família', async () => {
    const u = await usuarioComSenha('SenhaForte#2026');
    const login = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);
    const cookie = cookieDe(login);

    const saida = await http().post(`${base}/auth/logout`).set('Cookie', cookie).expect(204);
    expect(linhaDoCookie(saida)).toMatch(/miner_refresh=;/);

    // O token não serve mais: sair encerra a sessão de verdade.
    await http().post(`${base}/auth/refresh`).set('Cookie', cookie).expect(401);
  });

  it('logout sem sessão ainda responde 204 — sair não pode falhar', async () => {
    await http().post(`${base}/auth/logout`).expect(204);
  });

  /**
   * Bloqueio de conta e rate limit são defesas SEPARADAS, e desde a correção do
   * `@Throttle` elas se sobrepõem: o teto de 5/min do login corta a requisição
   * antes de a 6ª chegar ao serviço.
   *
   * Isso é melhor, não pior — o atacante é barrado mais cedo —, mas muda o que
   * dá para observar por HTTP. Antes, o decorator apontava para um throttler
   * inexistente e era metadado morto; o limite real era 120/min, e as 6
   * requisições passavam.
   *
   * Então este teste passou a medir as duas camadas onde cada uma existe:
   * o EFEITO no banco (a conta ficou bloqueada) e a RECUSA na borda.
   */
  /**
   * O bloqueio por tentativas, exercitado NO SERVIÇO.
   *
   * Já foi um teste HTTP: 5 posts errados e um sexto com a senha certa. Deixou
   * de funcionar quando o `@Throttle` do login foi corrigido — ele apontava para
   * um throttler inexistente (`default`, enquanto os registrados são `curto` e
   * `medio`) e era metadado morto; o limite real do login era 120/min.
   *
   * Com o teto verdadeiro de 5/min, medir esta defesa por HTTP passou a depender
   * de quantas vezes os OUTROS testes do arquivo chamaram `/auth/login` antes —
   * o balde é por IP e todos vêm de 127.0.0.1. Resultado dependente de ordem de
   * execução é teste que mente cedo ou tarde.
   *
   * As duas defesas são independentes e ambas seguem cobertas:
   *  - o teto por IP, em `throttle.int-spec.ts`, numa app própria;
   *  - o bloqueio por conta, aqui, onde o contador de fato mora.
   */
  it('5 tentativas erradas bloqueiam a conta, e nem a senha certa entra', async () => {
    const auth = app.get(AuthService);
    const u = await usuarioComSenha('SenhaForte#2026');

    for (let i = 0; i < 5; i++) {
      await auth.login(u.email, 'SenhaErrada#0000').catch(() => undefined);
    }

    const bloqueado = await prisma.user.findUniqueOrThrow({
      where: { id: u.id },
      select: { tentativasFalhas: true, bloqueadoAte: true },
    });
    expect(bloqueado.tentativasFalhas).toBe(5);
    expect(bloqueado.bloqueadoAte).not.toBeNull();
    expect(bloqueado.bloqueadoAte!.getTime()).toBeGreaterThan(Date.now());

    /* A credencial CORRETA não abre a conta enquanto o bloqueio durar — é isto
       que separa "conta protegida" de "atacante só precisa acertar a senha". */
    await expect(auth.login(u.email, 'SenhaForte#2026')).rejects.toThrow(/bloqueada/i);
  });
});
