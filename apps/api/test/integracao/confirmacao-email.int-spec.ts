import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { CadastroService } from '../../src/modules/cadastro/cadastro.service';
import { CobrancaService } from '../../src/modules/cobranca/cobranca.service';
import { ManualProvider } from '../../src/modules/cobranca/providers/manual.provider';
import { DistribuicaoService } from '../../src/modules/distribuicao/distribuicao.service';
import { AuthService } from '../../src/modules/auth/application/auth.service';
import type { ConfirmacaoCadastro, EmailPort } from '../../src/modules/email/email.port';
import type { CadastroDto } from '../../src/modules/cadastro/cadastro.dto';
import { prisma, limparDados, encerrar } from './ambiente';

/**
 * CONFIRMAÇÃO DE E-MAIL — o cadastro público deixa de aceitar e-mail sem prova
 * de posse.
 *
 * O que se prova aqui não é "um e-mail foi mandado": é a ORDEM. Com a exigência
 * ligada, a cobrança NÃO nasce no cadastro — nasce no clique do link. "Não
 * confirmou, não paga" é essa ordem, não um guard. E o cadastro vencido vira
 * RECICLÁVEL, que é o que impede um e-mail digitado errado de trancar o CNPJ
 * para sempre.
 */

/** Espião de e-mail: grava o que seria enviado, manda nada. */
class EmailEspia implements EmailPort {
  readonly nome = 'ESPIA';
  enviados: ConfirmacaoCadastro[] = [];
  async enviarConfirmacaoCadastro(dados: ConfirmacaoCadastro): Promise<void> {
    this.enviados.push(dados);
  }
  /* A porta ganhou a redefinição de senha; este espião não a exercita, mas
     precisa satisfazê-la — porta estreita só protege enquanto for cumprida. */
  async enviarRedefinicaoSenha(): Promise<void> {}
  /** O token em claro do último link — como o destinatário o receberia. */
  ultimoToken(): string {
    const link = this.enviados.at(-1)?.link ?? '';
    return new URL(link).searchParams.get('token') ?? '';
  }
}

/** Config de mentira com a exigência LIGADA (ou não) — só o que o fluxo lê. */
function configCom(ativa: boolean) {
  const valores: Record<string, unknown> = {
    CONFIRMACAO_EMAIL_ATIVA: ativa,
    CONFIRMACAO_EMAIL_VALIDADE_HORAS: 48,
    WEB_URL: 'https://app.laminer.com.br',
  };
  return {
    get: (chave: string, padrao?: unknown) => valores[chave] ?? padrao,
    getOrThrow: (chave: string) => {
      if (valores[chave] === undefined) throw new Error(`config ausente: ${chave}`);
      return valores[chave];
    },
  } as never;
}

const distribuicao = new DistribuicaoService(prisma as never);
const cobranca = new CobrancaService(
  prisma as never,
  configCom(true),
  new ManualProvider(),
  distribuicao,
);

function servicoCom(ativa: boolean) {
  const espia = new EmailEspia();
  const servico = new CadastroService(prisma as never, cobranca, configCom(ativa), espia);
  return { servico, espia };
}

async function planoAtivo() {
  return prisma.plano.create({
    data: {
      nome: `Plano ${Math.random().toString(36).slice(2, 8)}`,
      processosPorCiclo: 250,
      preco: 799,
    },
    select: { id: true },
  });
}

function dadosDe(planoId: string, sufixo = ''): CadastroDto {
  return {
    nomeEscritorio: `Escritório Teste${sufixo}`,
    documento: `${Date.now()}${Math.floor(Math.random() * 100)}`.slice(-14),
    telefone: '81999990000',
    nomeResponsavel: 'Dra. Ana Teste',
    email: `ana${sufixo}${Date.now()}@teste.local`,
    senha: 'SenhaForte#2026',
    planoId,
  } as CadastroDto;
}

describe('Confirmação de e-mail — o fluxo', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('com a exigência LIGADA, a cobrança NÃO nasce no cadastro', async () => {
    const { servico, espia } = servicoCom(true);
    const plano = await planoAtivo();

    const r = await servico.cadastrar(dadosDe(plano.id));

    expect(r.confirmacaoPendente).toBe(true);
    expect(r.urlPagamento).toBeNull();
    expect(r.faturaId).toBeNull();
    /* A ordem é a trava: ZERO faturas até o clique no link. */
    expect(await prisma.fatura.count()).toBe(0);

    const usuario = await prisma.user.findUniqueOrThrow({
      where: { email: r.email },
      select: { emailConfirmadoEm: true, emailConfirmacaoTokenHash: true },
    });
    expect(usuario.emailConfirmadoEm).toBeNull();
    expect(usuario.emailConfirmacaoTokenHash).not.toBeNull();

    /* O link foi "enviado", carrega o token em claro — e o banco só tem o
       hash: o que está gravado NÃO pode abrir o link. */
    expect(espia.enviados).toHaveLength(1);
    const token = espia.ultimoToken();
    expect(token.length).toBeGreaterThan(20);
    expect(usuario.emailConfirmacaoTokenHash).not.toBe(token);
  });

  it('o clique confirma, e SÓ ENTÃO a fatura nasce; o link é de uso único', async () => {
    const { servico, espia } = servicoCom(true);
    const plano = await planoAtivo();
    const r = await servico.cadastrar(dadosDe(plano.id));
    const token = espia.ultimoToken();

    const c = await servico.confirmarEmail(token);
    expect(c.email).toBe(r.email);
    expect(c.faturaId).not.toBeNull();
    expect(await prisma.fatura.count()).toBe(1);

    const usuario = await prisma.user.findUniqueOrThrow({
      where: { email: r.email },
      select: { emailConfirmadoEm: true, emailConfirmacaoTokenHash: true },
    });
    expect(usuario.emailConfirmadoEm).not.toBeNull();
    expect(usuario.emailConfirmacaoTokenHash).toBeNull();

    /* Segundo clique no MESMO link: a mesma mensagem de um token forjado —
       mensagem diferente aqui viraria oráculo. */
    await expect(servico.confirmarEmail(token)).rejects.toThrow(/inválido ou já utilizado/i);
    expect(await prisma.fatura.count()).toBe(1);
  });

  it('link vencido não confirma, e manda recomeçar', async () => {
    const { servico, espia } = servicoCom(true);
    const plano = await planoAtivo();
    const r = await servico.cadastrar(dadosDe(plano.id));

    await prisma.user.update({
      where: { email: r.email },
      data: { emailConfirmacaoExpiraEm: new Date(Date.now() - 60_000) },
    });

    await expect(servico.confirmarEmail(espia.ultimoToken())).rejects.toThrow(/venceu/i);
    expect(await prisma.fatura.count()).toBe(0);
  });

  it('com a exigência DESLIGADA, o comportamento é EXATAMENTE o de antes', async () => {
    const { servico, espia } = servicoCom(false);
    const plano = await planoAtivo();

    const r = await servico.cadastrar(dadosDe(plano.id));

    expect(r.confirmacaoPendente).toBe(false);
    /* Provedor MANUAL não gera link — mas a fatura TEM de existir já. */
    expect(r.faturaId).not.toBeNull();
    expect(await prisma.fatura.count()).toBe(1);
    expect(espia.enviados).toHaveLength(0);

    const usuario = await prisma.user.findUniqueOrThrow({
      where: { email: r.email },
      select: { emailConfirmadoEm: true },
    });
    expect(usuario.emailConfirmadoEm).not.toBeNull();
  });

  describe('reenvio', () => {
    it('regenera o token: o link antigo morre, o novo funciona', async () => {
      const { servico, espia } = servicoCom(true);
      const plano = await planoAtivo();
      const r = await servico.cadastrar(dadosDe(plano.id));
      const tokenAntigo = espia.ultimoToken();

      await servico.reenviarConfirmacao(r.email);
      expect(espia.enviados).toHaveLength(2);
      const tokenNovo = espia.ultimoToken();
      expect(tokenNovo).not.toBe(tokenAntigo);

      await expect(servico.confirmarEmail(tokenAntigo)).rejects.toThrow(/inválido/i);
      const c = await servico.confirmarEmail(tokenNovo);
      expect(c.email).toBe(r.email);
    });

    it('e-mail desconhecido não envia nada — e não lança', async () => {
      const { servico, espia } = servicoCom(true);
      await expect(servico.reenviarConfirmacao('ninguem@inexistente.local')).resolves.toBeUndefined();
      expect(espia.enviados).toHaveLength(0);
    });
  });

  describe('reciclagem do cadastro vencido', () => {
    /**
     * ⚠ A ARMADILHA QUE ISTO DESARMA.
     *
     * Sem a reciclagem, quem digita o próprio e-mail ERRADO cria uma conta que
     * nunca será confirmada e que tranca o CNPJ com 409 para sempre — e a
     * mensagem manda falar com o suporte. Vencido o link, o registro é casca
     * vazia (nada pago, ninguém entrou) e o novo cadastro passa POR CIMA.
     */
    it('cadastro vencido é reciclado: mesmo CNPJ, e-mail novo, sem 409', async () => {
      const { servico, espia } = servicoCom(true);
      const plano = await planoAtivo();
      const primeiro = dadosDe(plano.id, 'a');
      const r1 = await servico.cadastrar(primeiro);

      await prisma.user.update({
        where: { email: r1.email },
        data: { emailConfirmacaoExpiraEm: new Date(Date.now() - 60_000) },
      });

      /* O typo consertado: MESMO CNPJ, e-mail certo desta vez. */
      const segundo = { ...dadosDe(plano.id, 'b'), documento: primeiro.documento };
      const r2 = await servico.cadastrar(segundo);

      expect(r2.organizationId).toBe(r1.organizationId);
      expect(r2.confirmacaoPendente).toBe(true);
      /* Continua UM cadastro só — reciclou, não duplicou. */
      expect(await prisma.organization.count({ where: { tipo: 'CLIENTE' } })).toBe(1);

      /* E o novo dono confirma normalmente. */
      const c = await servico.confirmarEmail(espia.ultimoToken());
      expect(c.email).toBe(segundo.email.toLowerCase());
    });

    it('cadastro AINDA no prazo não é reciclado — 409 explicando a pendência', async () => {
      const { servico } = servicoCom(true);
      const plano = await planoAtivo();
      const primeiro = dadosDe(plano.id, 'a');
      await servico.cadastrar(primeiro);

      const segundo = { ...dadosDe(plano.id, 'b'), documento: primeiro.documento };
      /* Enquanto o link vale, o dono legítimo ainda pode confirmar — reciclar
         aqui permitiria sequestrar um cadastro recém-feito. */
      await expect(servico.cadastrar(segundo)).rejects.toThrow(/já existe/i);
    });

    it('dinheiro pago JAMAIS é reciclado por cima', async () => {
      const { servico, espia } = servicoCom(true);
      const plano = await planoAtivo();
      const primeiro = dadosDe(plano.id, 'a');
      const r1 = await servico.cadastrar(primeiro);

      /* Confirma e paga — e depois força o vencimento do token de novo (estado
         artificial, mas é a trava de fatura PAGA que está em teste). */
      await servico.confirmarEmail(espia.ultimoToken());
      const fatura = await prisma.fatura.findFirstOrThrow({ select: { id: true } });
      await cobranca.registrarPagamento(fatura.id);
      await prisma.user.update({
        where: { email: r1.email },
        data: { emailConfirmadoEm: null, emailConfirmacaoExpiraEm: new Date(Date.now() - 60_000) },
      });

      const segundo = { ...dadosDe(plano.id, 'b'), documento: primeiro.documento };
      await expect(servico.cadastrar(segundo)).rejects.toThrow(/já existe/i);
    });
  });
});

/**
 * O GUARD, pela HTTP inteira — com a exigência ligada NO AMBIENTE, porque o
 * guard lê o ConfigService do app de verdade.
 */
describe('Confirmação de e-mail — o guard (HTTP)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    /**
     * ⚠ A ORDEM AQUI É O TESTE INTEIRO.
     *
     * O `ConfigModule.forRoot` roda QUANDO `app.module` é importado — e um
     * import estático no topo deste arquivo executaria ANTES deste beforeAll.
     * Como CONFIRMACAO_EMAIL_ATIVA tem DEFAULT no zod, o snapshot validado
     * responderia `false` para sempre e o `process.env` setado depois nunca
     * seria lido (diferente de RENDER_GIT_COMMIT, que não tem default e por
     * isso cai no process.env vivo — foi o que escondeu esta armadilha no spec
     * da /versao). Por isso o import do app é DINÂMICO, depois do env.
     */
    process.env.CONFIRMACAO_EMAIL_ATIVA = 'true';
    const { criarAppDeTeste } = await import('./app-de-teste');
    ({ app, base } = await criarAppDeTeste());
  });
  afterAll(async () => {
    /* ⚠ LIMPAR É OBRIGATÓRIO: as outras suítes criam usuários direto no banco,
       com emailConfirmadoEm NULO — se a flag vazasse, o guard derrubaria as
       suítes seguintes inteiras com 403. */
    delete process.env.CONFIRMACAO_EMAIL_ATIVA;
    await app.close();
    await encerrar();
  });
  beforeEach(limparDados);

  const http = () => request(app.getHttpServer());

  async function usuarioComSenha(confirmado: boolean) {
    const org = await prisma.organization.create({
      data: { nome: 'Escritório G', tipo: 'CLIENTE', cnpj: `${Date.now()}`.slice(-14) },
      select: { id: true },
    });
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `guard${Date.now()}@teste.local`,
        nome: 'Guard Teste',
        papel: 'CLIENTE',
        gestor: true,
        senhaHash: await AuthService.gerarHash('SenhaForte#2026'),
        ...(confirmado ? { emailConfirmadoEm: new Date() } : {}),
      },
      select: { id: true, email: true },
    });
  }

  it('o LOGIN passa sem confirmação — recusar ali deixaria a pessoa sem tela', async () => {
    const u = await usuarioComSenha(false);
    const r = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);
    expect(r.body.accessToken).toBeTruthy();
  });

  it('sem confirmação, TODA rota autenticada fecha com o código estável', async () => {
    const u = await usuarioComSenha(false);
    const login = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);

    const r = await http()
      .get(`${base}/carteira/tribunais`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
    expect(r.body.erro).toBe('EMAIL_NAO_CONFIRMADO');
  });

  it('confirmado, passa', async () => {
    const u = await usuarioComSenha(true);
    const login = await http()
      .post(`${base}/auth/login`)
      .send({ email: u.email, senha: 'SenhaForte#2026' })
      .expect(200);

    await http()
      .get(`${base}/carteira/tribunais`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(200);
  });

  /**
   * ANTI-ENUMERAÇÃO: a resposta do reenvio é BYTE a byte a mesma, exista ou
   * não o e-mail. Esta rota é pública — diferença de corpo, aqui, seria um
   * oráculo da base de clientes.
   */
  it('o reenvio responde IGUAL para e-mail existente e inexistente', async () => {
    const u = await usuarioComSenha(false);

    const existente = await http()
      .post(`${base}/cadastro/reenviar-confirmacao`)
      .send({ email: u.email })
      .expect(200);
    const inexistente = await http()
      .post(`${base}/cadastro/reenviar-confirmacao`)
      .send({ email: 'ninguem@inexistente.local' })
      .expect(200);

    expect(existente.body).toEqual(inexistente.body);
  });
});
