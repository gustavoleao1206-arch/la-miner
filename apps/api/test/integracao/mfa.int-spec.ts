import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../../src/modules/auth/application/auth.service';
import { MfaService } from '../../src/modules/auth/application/mfa.service';
import { gerarCodigo } from '../../src/modules/auth/application/totp';
import { criarAppDeTeste } from './app-de-teste';
import { prisma, observador, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * O segundo fator, pelo caminho que o usuário percorre.
 *
 * O motor TOTP já é conferido contra os vetores da RFC em `totp.spec.ts`; aqui o
 * alvo é o que a RFC não decide — quando um código é gastado, o que acontece
 * quando alguém erra, e se o bilhete do meio do login vale como sessão.
 */
describe('MFA (segundo fator)', () => {
  let app: INestApplication;
  let base: string;
  let mfa: MfaService;

  const SENHA = 'SenhaForte#2026';

  beforeAll(async () => {
    ({ app, base } = await criarAppDeTeste());
    mfa = app.get(MfaService);
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
  });
  beforeEach(async () => {
    await limparDados();
  });

  const http = () => request(app.getHttpServer());

  async function usuarioComSenha() {
    const { org } = await semearOrganizacao();
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `mfa${Date.now()}${Math.floor(Math.random() * 1000)}@teste.local`,
        nome: 'Com MFA',
        papel: 'ADMIN',
        senhaHash: await AuthService.gerarHash(SENHA),
      },
      select: { id: true, email: true },
    });
  }

  const agora = () => Math.floor(Date.now() / 1000);

  /**
   * Cadastra e confirma o MFA, devolvendo o segredo em claro e os códigos.
   *
   * A confirmação usa o código do período ANTERIOR (-30s), e isso não é detalhe:
   * confirmar gasta o contador daquele período, e o anti-replay recusa qualquer
   * código do mesmo período ou mais antigo. Confirmando com o de trás, o do
   * INSTANTE ATUAL continua livre — que é o que os testes de login usam. Ter
   * tropeçado nisso é, por si, a demonstração de que o anti-replay funciona.
   */
  async function cadastrarMfa(userId: string) {
    const { segredo } = await mfa.iniciarCadastro(userId);
    const { codigos } = await mfa.confirmarCadastro(userId, gerarCodigo(segredo, agora() - 30));
    return { segredo, codigos };
  }

  // ── Cadastro ──────────────────────────────────────────────
  describe('cadastro', () => {
    it('o segredo é guardado CIFRADO — o banco não tem o valor em claro', async () => {
      /* A razão de existir do `segredo-cifrado.ts`: todo o sentido do segundo
         fator é sobreviver ao comprometimento do primeiro, e um dump com os
         segredos legíveis entregaria os dois de uma vez. */
      const u = await usuarioComSenha();
      const { segredo } = await mfa.iniciarCadastro(u.id);

      const linha = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { mfaSegredo: true },
      });
      expect(linha.mfaSegredo).toBeTruthy();
      expect(linha.mfaSegredo).not.toContain(segredo);
      expect(linha.mfaSegredo).toMatch(/^v1\./);
    });

    it('iniciar NÃO liga o MFA: só a confirmação liga', async () => {
      /* Sem esta separação, um QR mal escaneado só apareceria como problema no
         próximo login — com o usuário trancado do lado de fora e sem nenhum
         código de recuperação. */
      const u = await usuarioComSenha();
      await mfa.iniciarCadastro(u.id);

      expect((await mfa.situacao(u.id)).habilitado).toBe(false);
      expect((await mfa.situacao(u.id)).cadastroPendente).toBe(true);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);
      expect(login.body.mfaRequerido).toBe(false);
      expect(login.body.accessToken).toBeTruthy();
    });

    it('confirmar com código errado não liga nada', async () => {
      const u = await usuarioComSenha();
      await mfa.iniciarCadastro(u.id);

      await expect(mfa.confirmarCadastro(u.id, '000000')).rejects.toThrow(/inválido/i);
      expect((await mfa.situacao(u.id)).habilitado).toBe(false);
    });

    it('confirmar entrega 10 códigos de recuperação, guardados em HASH', async () => {
      const u = await usuarioComSenha();
      const { codigos } = await cadastrarMfa(u.id);

      expect(codigos).toHaveLength(10);
      expect(new Set(codigos).size).toBe(10);

      const guardados = await prisma.mfaCodigoRecuperacao.findMany({ where: { userId: u.id } });
      expect(guardados).toHaveLength(10);
      for (const g of guardados) {
        expect(g.codigoHash).toHaveLength(64); // sha256 hex
        expect(codigos).not.toContain(g.codigoHash);
      }
    });

    it('quem já tem MFA ativo não cadastra outro por cima', async () => {
      /* Se pudesse, quem alcançasse uma sessão aberta trocaria o segundo fator
         pelo SEU — e o dono perderia a conta sem ver erro nenhum. */
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);
      await expect(mfa.iniciarCadastro(u.id)).rejects.toThrow(/já está ativo/i);
    });
  });

  // ── Login em duas etapas ──────────────────────────────────
  describe('login', () => {
    it('senha certa NÃO abre sessão: devolve desafio, sem token e sem cookie', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);

      expect(login.body.mfaRequerido).toBe(true);
      expect(login.body.desafio).toBeTruthy();
      expect(login.body.accessToken).toBeUndefined();
      expect(login.headers['set-cookie']).toBeUndefined();
    });

    it('desafio + código do app → sessão completa, com o cookie de refresh', async () => {
      const u = await usuarioComSenha();
      const { segredo } = await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);

      const r = await http()
        .post(`${base}/auth/mfa/verificar`)
        .send({ desafio: login.body.desafio, codigo: gerarCodigo(segredo, agora()) })
        .expect(200);

      expect(r.body.accessToken).toBeTruthy();
      expect(r.body.refreshToken).toBeUndefined();
      const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) =>
        c.startsWith('miner_refresh='),
      );
      expect(cookie).toContain('HttpOnly');
    });

    /**
     * ⚠ A ASSERÇÃO MAIS IMPORTANTE DESTE ARQUIVO.
     *
     * O desafio é emitido para quem acertou a senha e ainda NÃO provou o segundo
     * fator. Se ele valer como access token, o MFA inteiro é contornável
     * ignorando a segunda tela — e a `JwtStrategy` autentica por `sub` e nem
     * olha os outros campos do payload, então isso não é hipótese remota.
     */
    it('o DESAFIO não vale como sessão numa rota protegida', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);

      await http()
        .get(`${base}/auth/eu`)
        .set('Authorization', `Bearer ${login.body.desafio}`)
        .expect(401);
    });

    /**
     * A segunda barreira, isolada: um desafio assinado com o segredo de ACESSO
     * (o que aconteceria se alguém "simplificasse" a derivação) ainda é recusado,
     * pelo claim `typ`.
     */
    it('mesmo assinado com o segredo de acesso, um token typ=mfa é recusado', async () => {
      const u = await usuarioComSenha();
      const jwt = app.get(JwtService);
      const config = app.get(ConfigService);

      const forjado = await jwt.signAsync(
        { sub: u.id, typ: 'mfa' },
        { secret: config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '5m' },
      );

      await http().get(`${base}/auth/eu`).set('Authorization', `Bearer ${forjado}`).expect(401);
    });

    it('desafio forjado ou de outro segredo → 401', async () => {
      const u = await usuarioComSenha();
      const { segredo } = await cadastrarMfa(u.id);

      await http()
        .post(`${base}/auth/mfa/verificar`)
        .send({ desafio: 'nao.e.um.jwt', codigo: gerarCodigo(segredo, agora()) })
        .expect(401);
    });

    it('código errado → 401 e conta uma tentativa falha', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);

      await http()
        .post(`${base}/auth/mfa/verificar`)
        .send({ desafio: login.body.desafio, codigo: '000000' })
        .expect(401);

      const depois = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { tentativasFalhas: true },
      });
      expect(depois.tentativasFalhas).toBe(1);
    });

    /**
     * O contador NÃO pode zerar no passo 1.
     *
     * Se zerasse, quem tivesse a senha (vazada, reusada de outro site) bateria no
     * código de seis dígitos para sempre: cada tentativa começaria pelo login,
     * limpando o contador antes de errar o código. O bloqueio por tentativas
     * ficaria inalcançável justamente para quem já passou da primeira barreira.
     */
    it('a senha correta não zera o contador enquanto o segundo fator não vier', async () => {
      const auth = app.get(AuthService);
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      await prisma.user.update({ where: { id: u.id }, data: { tentativasFalhas: 3 } });
      await auth.login(u.email, SENHA);

      const depois = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { tentativasFalhas: true, ultimoLoginEm: true },
      });
      expect(depois.tentativasFalhas).toBe(3);
      /* E o login não é dado por concluído: sem segundo fator, não houve login. */
      expect(depois.ultimoLoginEm).toBeNull();
      expect(await observador.auditLog.count({ where: { userId: u.id, acao: 'LOGIN' } })).toBe(0);
    });

    it('cinco códigos errados bloqueiam a conta', async () => {
      const auth = app.get(AuthService);
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      for (let i = 0; i < 5; i++) {
        const r = await auth.login(u.email, SENHA);
        if (!r.mfaRequerido) throw new Error('esperava desafio');
        await auth.verificarSegundoFator(r.desafio, '000000').catch(() => undefined);
      }

      const bloqueado = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { tentativasFalhas: true, bloqueadoAte: true },
      });
      expect(bloqueado.tentativasFalhas).toBe(5);
      expect(bloqueado.bloqueadoAte!.getTime()).toBeGreaterThan(Date.now());
    });

    it('conta bloqueada não entra nem com o código CERTO', async () => {
      const auth = app.get(AuthService);
      const u = await usuarioComSenha();
      const { segredo } = await cadastrarMfa(u.id);

      const r = await auth.login(u.email, SENHA);
      if (r.mfaRequerido === false) throw new Error('esperava desafio');

      /* Bloqueio aplicado ENTRE os dois passos: um desafio já emitido não pode
         ser a porta dos fundos de uma conta que travou. */
      await prisma.user.update({
        where: { id: u.id },
        data: { bloqueadoAte: new Date(Date.now() + 600_000) },
      });

      await expect(
        auth.verificarSegundoFator(r.desafio, gerarCodigo(segredo, agora())),
      ).rejects.toThrow(/bloqueada/i);
    });

    it('o login registra a auditoria só DEPOIS do segundo fator', async () => {
      const auth = app.get(AuthService);
      const u = await usuarioComSenha();
      const { segredo } = await cadastrarMfa(u.id);

      const r = await auth.login(u.email, SENHA);
      if (r.mfaRequerido === false) throw new Error('esperava desafio');
      await auth.verificarSegundoFator(r.desafio, gerarCodigo(segredo, agora()));

      expect(await observador.auditLog.count({ where: { userId: u.id, acao: 'LOGIN' } })).toBe(1);
    });
  });

  // ── Replay ────────────────────────────────────────────────
  it('o MESMO código não serve duas vezes', async () => {
    /* Um código vale por até 90 segundos, e sem o contador guardado funcionaria
       quantas vezes fosse apresentado nesse intervalo — quem interceptasse um
       código digitado teria uma janela real de uso. */
    const u = await usuarioComSenha();
    const { segredo } = await cadastrarMfa(u.id);
    const codigo = gerarCodigo(segredo, agora());

    expect(await mfa.conferir(u.id, codigo)).toBe(true);
    expect(await mfa.conferir(u.id, codigo)).toBe(false);
  });

  /**
   * ⚠ O MESMO CÓDIGO, AO MESMO TEMPO — e não em sequência.
   *
   * O caso acima passava com um anti-replay que só funcionava entre tentativas
   * SEQUENCIAIS: o código lia o contador, comparava em memória e só então
   * gravava. Duas requisições simultâneas leem as duas o valor antigo, nenhuma
   * enxerga a escrita da outra, e as duas são aceitas.
   *
   * E é assim que um código interceptado seria de fato reapresentado: junto com
   * o dono, para ganhar a corrida — não um minuto depois, quando o replay
   * sequencial já o teria barrado.
   *
   * `Promise.all` reproduz isso de forma determinística: as duas consultas de
   * leitura saem antes de qualquer escrita.
   */
  it('o MESMO código em duas requisições SIMULTÂNEAS só passa uma vez', async () => {
    const u = await usuarioComSenha();
    const { segredo } = await cadastrarMfa(u.id);
    const codigo = gerarCodigo(segredo, agora());

    const respostas = await Promise.all([
      mfa.conferir(u.id, codigo),
      mfa.conferir(u.id, codigo),
    ]);

    /* Uma entra, a outra não. Qual das duas é indiferente. */
    expect(respostas.filter(Boolean)).toHaveLength(1);
  });

  /* O contraponto indispensável: sem ele, um bug que recusasse TUDO passaria
     como "anti-replay funcionando" — e ninguém mais entraria com o segundo
     fator. Períodos diferentes são códigos diferentes e os dois valem. */
  it('o código do período SEGUINTE continua valendo depois do anterior', async () => {
    const u = await usuarioComSenha();
    const { segredo } = await cadastrarMfa(u.id);

    expect(await mfa.conferir(u.id, gerarCodigo(segredo, agora()))).toBe(true);
    expect(await mfa.conferir(u.id, gerarCodigo(segredo, agora() + 30))).toBe(true);
  });

  /**
   * CONTADOR SUMIDO NÃO TRANCA NINGUÉM DO LADO DE FORA.
   *
   * O estado é inalcançável pelo fluxo normal — `confirmarCadastro` grava o
   * contador na mesma transação em que liga o MFA. Este caso existe pela
   * assimetria do estrago: se um dia ele acontecer (restauração de backup,
   * script de manutenção, migração futura), a comparação estrita recusaria
   * TODO código e a pessoa ficaria presa fora da própria conta, sem erro que
   * explicasse por quê.
   *
   * Uma trava pode errar para o lado de pedir o código de novo. Não pode errar
   * para o lado de nunca deixar entrar.
   */
  it('com o contador zerado à mão, o segundo fator ainda deixa entrar', async () => {
    const u = await usuarioComSenha();
    const { segredo } = await cadastrarMfa(u.id);

    await prisma.user.update({
      where: { id: u.id },
      data: { mfaUltimoContador: null },
    });

    expect(await mfa.conferir(u.id, gerarCodigo(segredo, agora()))).toBe(true);
    /* E a proteção volta a valer no mesmo instante. */
    expect(await mfa.conferir(u.id, gerarCodigo(segredo, agora()))).toBe(false);
  });

  // ── Códigos de recuperação ────────────────────────────────
  describe('códigos de recuperação', () => {
    it('entram no lugar do código do app', async () => {
      const u = await usuarioComSenha();
      const { codigos } = await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);

      const r = await http()
        .post(`${base}/auth/mfa/verificar`)
        .send({ desafio: login.body.desafio, codigo: codigos[0] })
        .expect(200);
      expect(r.body.accessToken).toBeTruthy();
    });

    it('são de uso ÚNICO', async () => {
      const u = await usuarioComSenha();
      const { codigos } = await cadastrarMfa(u.id);

      expect(await mfa.conferir(u.id, codigos[0])).toBe(true);
      expect(await mfa.conferir(u.id, codigos[0])).toBe(false);
      /* A linha FICA, marcada como usada: apagá-la esconderia que um código foi
         gasto, que é o que se quer enxergar depois de uma suspeita. */
      expect(await prisma.mfaCodigoRecuperacao.count({ where: { userId: u.id } })).toBe(10);
      expect((await mfa.situacao(u.id)).codigosDisponiveis).toBe(9);
    });

    it('aceita como o usuário digita: minúsculas, sem traço, com espaços', async () => {
      const u = await usuarioComSenha();
      const { codigos } = await cadastrarMfa(u.id);
      const digitado = ` ${codigos[0].toLowerCase().replace('-', ' ')} `;

      expect(await mfa.conferir(u.id, digitado)).toBe(true);
    });

    /**
     * O hash é único na TABELA inteira, não por usuário. Sem conferir o dono, o
     * código de um usuário abriria a conta de outro.
     */
    it('o código de um usuário NÃO abre a conta de outro', async () => {
      const a = await usuarioComSenha();
      const b = await usuarioComSenha();
      const { codigos } = await cadastrarMfa(a.id);
      await cadastrarMfa(b.id);

      expect(await mfa.conferir(b.id, codigos[0])).toBe(false);
      /* E não foi consumido do dono legítimo. */
      expect(await mfa.conferir(a.id, codigos[0])).toBe(true);
    });

    it('renovar invalida o jogo anterior', async () => {
      const u = await usuarioComSenha();
      const { segredo, codigos } = await cadastrarMfa(u.id);

      const { codigos: novos } = await mfa.renovarCodigos(u.id, gerarCodigo(segredo, agora()));
      expect(novos).toHaveLength(10);
      expect(await mfa.conferir(u.id, codigos[0])).toBe(false);
      expect(await mfa.conferir(u.id, novos[0])).toBe(true);
    });
  });

  // ── Desativação ───────────────────────────────────────────
  describe('desativar', () => {
    it('exige a SENHA, não um código do app', async () => {
      /* O cenário a proteger é o telefone perdido com a sessão aberta: quem o
         achou tem o app autenticador em mãos. A senha é o fator que ele não tem. */
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      await expect(mfa.desativar(u.id, 'senha-errada')).rejects.toThrow(/senha incorreta/i);
      expect((await mfa.situacao(u.id)).habilitado).toBe(true);
    });

    it('com a senha certa, limpa segredo e códigos', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);

      await mfa.desativar(u.id, SENHA);

      const depois = await prisma.user.findUniqueOrThrow({
        where: { id: u.id },
        select: { mfaSegredo: true, mfaConfirmadoEm: true, mfaUltimoContador: true },
      });
      expect(depois.mfaSegredo).toBeNull();
      expect(depois.mfaConfirmadoEm).toBeNull();
      expect(depois.mfaUltimoContador).toBeNull();
      expect(await prisma.mfaCodigoRecuperacao.count({ where: { userId: u.id } })).toBe(0);
      expect(await observador.auditLog.count({ where: { userId: u.id, acao: 'MFA_DESATIVADO' } })).toBe(1);
    });

    it('e o login volta a ser de uma etapa', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);
      await mfa.desativar(u.id, SENHA);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);
      expect(login.body.mfaRequerido).toBe(false);
      expect(login.body.accessToken).toBeTruthy();
    });
  });

  // ── Política ──────────────────────────────────────────────
  describe('política de obrigatoriedade', () => {
    /* A política sai de um único ponto (`MfaService.politica`), lido a cada
       chamada — inclusive pelo guard. Trocá-la aqui é um spy, e não uma segunda
       aplicação com outro ambiente: o que se quer exercitar é a MESMA instância
       que serve as rotas. */
    const comPolitica = async (valor: 'admin' | 'todos', fn: () => Promise<void>) => {
      const spy = jest.spyOn(mfa, 'politica').mockReturnValue(valor);
      try {
        await fn();
      } finally {
        spy.mockRestore();
      }
    };

    it('`nenhum` (o padrão) não exige de ninguém', () => {
      expect(mfa.exigidoPara('ADMIN', false)).toBe(false);
      expect(mfa.exigidoPara('CLIENTE', true)).toBe(false);
    });

    it('`admin` alcança o ADMIN da plataforma e o gestor do cliente', async () => {
      await comPolitica('admin', async () => {
        expect(mfa.exigidoPara('ADMIN', false)).toBe(true);
        expect(mfa.exigidoPara('CLIENTE', true)).toBe(true);
        expect(mfa.exigidoPara('CLIENTE', false)).toBe(false);
        expect(mfa.exigidoPara('OPERADOR', false)).toBe(false);
      });
    });

    /**
     * O guard barra quem está em falta — MAS não pode barrar as rotas de
     * cadastro, ou a política trancaria a porta pelo lado de dentro e ninguém
     * conseguiria cumpri-la.
     */
    it('quem está em falta é barrado, mas alcança o próprio cadastro', async () => {
      const u = await usuarioComSenha();
      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);
      const token = login.body.accessToken;

      await comPolitica('admin', async () => {
        const barrado = await http()
          .get(`${base}/carteira/resumo`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        /* O front casa por ESTE campo. Casar por texto de mensagem quebraria na
           primeira revisão de redação. */
        expect(barrado.body.erro).toBe('MFA_OBRIGATORIO');

        /* As rotas de saída continuam abertas — sem isto, a política seria uma
           porta trancada por dentro. */
        await http().get(`${base}/auth/eu`).set('Authorization', `Bearer ${token}`).expect(200);
        await http()
          .post(`${base}/auth/mfa/cadastrar`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      });
    });

    it('cumprida a exigência, o acesso volta', async () => {
      const u = await usuarioComSenha();
      const { segredo } = await cadastrarMfa(u.id);

      const login = await http()
        .post(`${base}/auth/login`)
        .send({ email: u.email, senha: SENHA })
        .expect(200);
      const verificado = await http()
        .post(`${base}/auth/mfa/verificar`)
        .send({ desafio: login.body.desafio, codigo: gerarCodigo(segredo, agora()) })
        .expect(200);

      await comPolitica('admin', async () => {
        await http()
          .get(`${base}/carteira/resumo`)
          .set('Authorization', `Bearer ${verificado.body.accessToken}`)
          .expect(200);
      });
    });

    it('quem é obrigado não consegue desativar', async () => {
      const u = await usuarioComSenha();
      await cadastrarMfa(u.id);
      await comPolitica('todos', async () => {
        await expect(mfa.desativar(u.id, SENHA)).rejects.toThrow(/política/i);
      });
    });
  });
});
