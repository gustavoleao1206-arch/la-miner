import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Inject, Injectable, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { hash, verify } from '@node-rs/argon2';
import type { User } from '@miner/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { TokenService, type ParDeTokens } from './token.service';
import { EMAIL_PORT, type EmailPort } from '../../email/email.port';
import { MfaService } from './mfa.service';
import {
  DESAFIO_TTL,
  TIPO_DESAFIO,
  segredoDoDesafio,
  type PayloadDesafio,
} from './desafio-mfa';

/** Parâmetros argon2id — OWASP 2024 (19 MiB, 2 iterações). */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MINUTOS = 15;

interface ContextoRequisicao {
  ip?: string;
  userAgent?: string;
}

/**
 * O login passou a ter DUAS saídas possíveis.
 *
 * Sem segundo fator, nada mudou: sai o par de tokens. Com segundo fator ativo,
 * a senha correta não abre a sessão — sai um DESAFIO, que só vira sessão depois
 * de `verificarSegundoFator`.
 *
 * União discriminada em vez de campos opcionais no mesmo objeto: assim o
 * compilador obriga quem consome a tratar os dois casos. Um `accessToken?` teria
 * deixado passar um `if` esquecido, e o esquecimento seria justamente "entrou
 * sem o segundo fator".
 */
export type ResultadoLogin =
  | ({ mfaRequerido: false } & ParDeTokens)
  | { mfaRequerido: true; desafio: string };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mfa: MfaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  static async gerarHash(senha: string): Promise<string> {
    return hash(senha, ARGON2);
  }

  async login(email: string, senha: string, ctx: ContextoRequisicao = {}): Promise<ResultadoLogin> {
    const usuario = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });

    // Mensagem idêntica para usuário inexistente e senha errada — não revela
    // quais e-mails existem na base.
    const credenciaisInvalidas = new UnauthorizedException('Credenciais inválidas');

    if (!usuario) {
      // Gasta o mesmo tempo de um verify real para não permitir enumeração por timing.
      await verify(
        '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3Xk1ZQhBqfKPPJ0kEXXvVQvR1PZKKz0YQ8TjZ1kQZ0k',
        senha,
      ).catch(() => false);
      throw credenciaisInvalidas;
    }

    if (usuario.bloqueadoAte && usuario.bloqueadoAte > new Date()) {
      const faltam = Math.ceil((usuario.bloqueadoAte.getTime() - Date.now()) / 60_000);
      throw new ForbiddenException(`Conta bloqueada. Tente novamente em ${faltam} minuto(s).`);
    }

    const senhaCorreta = await verify(usuario.senhaHash, senha).catch(() => false);

    if (!senhaCorreta) {
      const tentativas = usuario.tentativasFalhas + 1;
      const bloquear = tentativas >= MAX_TENTATIVAS;

      await this.prisma.user.update({
        where: { id: usuario.id },
        data: {
          tentativasFalhas: tentativas,
          bloqueadoAte: bloquear ? new Date(Date.now() + BLOQUEIO_MINUTOS * 60_000) : null,
        },
      });

      if (bloquear) {
        this.logger.warn(`Conta bloqueada por tentativas: ${usuario.email} (ip=${ctx.ip})`);
      }
      throw credenciaisInvalidas;
    }

    if (!usuario.ativo) {
      throw new ForbiddenException('Usuário inativo');
    }

    /**
     * ── PARA AQUI QUEM TEM SEGUNDO FATOR ──
     *
     * E, principalmente: o contador de tentativas NÃO é zerado ainda, nem se
     * grava `ultimoLoginEm`, nem se registra LOGIN na auditoria. Nada disso
     * aconteceu — a pessoa provou um fator de dois.
     *
     * Zerar aqui teria consequência concreta: quem tivesse a senha (vazada,
     * reusada de outro site) poderia bater no código de seis dígitos para
     * sempre, porque cada tentativa começaria pelo login e limparia o contador
     * antes de errar o código. O bloqueio por tentativas viraria inalcançável
     * exatamente para quem já passou da primeira barreira.
     */
    if (await this.temSegundoFator(usuario.id)) {
      return { mfaRequerido: true, desafio: await this.emitirDesafio(usuario.id) };
    }

    await this.concluirLogin(usuario, ctx);

    return {
      mfaRequerido: false,
      /* `abrirSessaoUnica`, e não `emitirPar`: entrar aqui DERRUBA a sessão
         anterior. É a trava contra o login compartilhado — o plano vende perfis,
         e sem ela um só bastaria para o escritório inteiro. */
      ...(await this.tokens.abrirSessaoUnica(
        {
          sub: usuario.id,
          email: usuario.email,
          papel: usuario.papel,
          org: usuario.organizationId,
        },
        ctx,
      )),
    };
  }

  /**
   * Passo 2 do login: o código do app (ou um de recuperação).
   *
   * O desafio prova que a senha foi conferida há menos de cinco minutos; o
   * código prova o segundo fator. Só os dois juntos emitem sessão.
   */
  async verificarSegundoFator(
    desafio: string,
    codigo: string,
    ctx: ContextoRequisicao = {},
  ): Promise<ParDeTokens> {
    let payload: PayloadDesafio;
    try {
      payload = await this.jwt.verifyAsync<PayloadDesafio>(desafio, {
        secret: segredoDoDesafio(this.config.getOrThrow<string>('JWT_ACCESS_SECRET')),
      });
    } catch {
      /* Expirado ou forjado levam à mesma tela: recomeçar o login. */
      throw new UnauthorizedException('Desafio inválido ou expirado. Faça login novamente.');
    }
    if (payload.typ !== TIPO_DESAFIO) {
      throw new UnauthorizedException('Desafio inválido');
    }

    const usuario = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException('Usuário inválido ou inativo');
    }

    /* O bloqueio é reconferido AQUI. Um desafio já emitido não pode ser a porta
       dos fundos de uma conta que travou entre os dois passos. */
    if (usuario.bloqueadoAte && usuario.bloqueadoAte > new Date()) {
      const faltam = Math.ceil((usuario.bloqueadoAte.getTime() - Date.now()) / 60_000);
      throw new ForbiddenException(`Conta bloqueada. Tente novamente em ${faltam} minuto(s).`);
    }

    if (!(await this.mfa.conferir(usuario.id, codigo))) {
      /* Código errado conta como tentativa falha, no MESMO contador da senha:
         cinco erros bloqueiam a conta. Sem isto, o segundo fator seria a única
         parte do login sem teto — e a de seis dígitos. */
      const tentativas = usuario.tentativasFalhas + 1;
      const bloquear = tentativas >= MAX_TENTATIVAS;
      await this.prisma.user.update({
        where: { id: usuario.id },
        data: {
          tentativasFalhas: tentativas,
          bloqueadoAte: bloquear ? new Date(Date.now() + BLOQUEIO_MINUTOS * 60_000) : null,
        },
      });
      if (bloquear) {
        this.logger.warn(`Conta bloqueada por códigos MFA errados: ${usuario.email} (ip=${ctx.ip})`);
      }
      throw new UnauthorizedException('Código inválido');
    }

    await this.concluirLogin(usuario, ctx);

    /* O OUTRO ponto onde uma sessão nasce. Esquecê-lo daria a quem tem segundo
       fator — justamente quem mais se protege — a sessão simultânea que o resto
       da plataforma não tem. */
    return this.tokens.abrirSessaoUnica(
      {
        sub: usuario.id,
        email: usuario.email,
        papel: usuario.papel,
        org: usuario.organizationId,
      },
      ctx,
    );
  }

  private async temSegundoFator(userId: string): Promise<boolean> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaConfirmadoEm: true },
    });
    return u?.mfaConfirmadoEm != null;
  }

  private async emitirDesafio(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, typ: TIPO_DESAFIO },
      {
        secret: segredoDoDesafio(this.config.getOrThrow<string>('JWT_ACCESS_SECRET')),
        expiresIn: DESAFIO_TTL,
      },
    );
  }

  /** O que marca um login REALMENTE concluído — com todos os fatores. */
  private async concluirLogin(
    usuario: Pick<User, 'id' | 'organizationId'>,
    ctx: ContextoRequisicao,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id: usuario.id },
      data: { tentativasFalhas: 0, bloqueadoAte: null, ultimoLoginEm: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: usuario.organizationId,
        userId: usuario.id,
        acao: 'LOGIN',
        entidade: 'User',
        entidadeId: usuario.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 500),
      },
    });
  }

  async refresh(refreshToken: string, ctx: ContextoRequisicao = {}): Promise<ParDeTokens> {
    return this.tokens.rotacionar(refreshToken, ctx);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revogarFamilia(refreshToken);
  }

  async trocarSenha(userId: string, senhaAtual: string, senhaNova: string): Promise<void> {
    const usuario = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const ok = await verify(usuario.senhaHash, senhaAtual).catch(() => false);
    if (!ok) throw new UnauthorizedException('Senha atual incorreta');

    await this.prisma.user.update({
      where: { id: userId },
      data: { senhaHash: await AuthService.gerarHash(senhaNova) },
    });

    // Troca de senha derruba todas as sessões — inclusive a de um invasor.
    await this.tokens.revogarTodasDoUsuario(userId);

    await this.prisma.auditLog.create({
      data: {
        organizationId: usuario.organizationId,
        userId,
        acao: 'TROCA_SENHA',
        entidade: 'User',
        entidadeId: userId,
      },
    });
  }

  // ── Esqueci minha senha ──

  /** Minutos de validade do link. Curto de propósito: reset TOMA uma conta. */
  private get resetValidadeMinutos(): number {
    return Number(this.config.get('SENHA_RESET_VALIDADE_MINUTOS', 60));
  }

  /**
   * PEDIDO de redefinição.
   *
   * ── NÃO EXISTE RESPOSTA DIFERENTE PARA E-MAIL QUE NÃO EXISTE ──
   *
   * Devolve `void` sempre, e o controller responde a MESMA coisa nos dois
   * casos. Distinguir aqui transformaria esta rota pública num verificador de
   * cadastro: um atacante com uma lista de e-mails descobriria, sem senha
   * nenhuma, quais escritórios são clientes — e isso é informação comercial e
   * pessoal que não temos o direito de vazar.
   *
   * Pela mesma razão a falha de ENVIO também não sobe: um provedor fora do ar
   * viraria "este e-mail existe, mas não consegui mandar". Vira log.
   */
  async solicitarRedefinicao(email: string, ctx: { ip?: string; userAgent?: string }): Promise<void> {
    const alvo = email.toLowerCase().trim();
    const usuario = await this.prisma.user.findFirst({
      where: { email: alvo, ativo: true },
      select: { id: true, nome: true, organizationId: true },
    });
    if (!usuario) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.user.update({
      where: { id: usuario.id },
      data: {
        /* Só o SHA-256 mora no banco: um dump não redefine senha nenhuma. */
        senhaResetTokenHash: createHash('sha256').update(token).digest('hex'),
        senhaResetExpiraEm: new Date(Date.now() + this.resetValidadeMinutos * 60_000),
      },
    });

    /* Pedir de novo INVALIDA o link anterior (a coluna é uma só). É o que se
       espera: quem clica no e-mail mais recente não pode receber "link
       inválido" porque pediu duas vezes. */
    const base = this.config.get<string>('WEB_URL', 'http://localhost:3000').replace(/\/$/, '');
    try {
      await this.email.enviarRedefinicaoSenha({
        para: alvo,
        nome: usuario.nome,
        link: `${base}/redefinir-senha?token=${token}`,
        validadeMinutos: this.resetValidadeMinutos,
      });
    } catch (erro) {
      this.logger.error(
        `Falha ao enviar redefinição de senha para ${alvo}: ${(erro as Error).message}`,
      );
    }

    await this.prisma.auditLog.create({
      data: {
        organizationId: usuario.organizationId,
        userId: usuario.id,
        acao: 'SENHA_RESET_SOLICITADO',
        entidade: 'User',
        entidadeId: usuario.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 500),
      },
    });
  }

  /**
   * O RESGATE em si.
   *
   * Token inválido, vencido e já usado recebem a MESMA mensagem — diferenciar
   * viraria oráculo, exatamente como na confirmação de e-mail.
   */
  async redefinirSenha(
    token: string,
    senhaNova: string,
    ctx: { ip?: string; userAgent?: string },
  ): Promise<void> {
    const hashDoToken = createHash('sha256').update(token).digest('hex');
    const usuario = await this.prisma.user.findFirst({
      where: { senhaResetTokenHash: hashDoToken },
      select: { id: true, organizationId: true, senhaResetExpiraEm: true, ativo: true },
    });

    const vencido = !usuario?.senhaResetExpiraEm || usuario.senhaResetExpiraEm < new Date();
    if (!usuario || !usuario.ativo || vencido) {
      throw new BadRequestException('Link inválido ou expirado. Peça um novo.');
    }

    /**
     * COMPARE-AND-SET: o token é consumido no MESMO update que troca a senha, e
     * o WHERE ainda exige o hash. Duas requisições com o mesmo link — o clique
     * duplo de quem tem internet lenta, ou dois pedidos simultâneos — só uma
     * atravessa; a segunda encontra a coluna nula e cai no erro acima.
     */
    const { count } = await this.prisma.user.updateMany({
      where: { id: usuario.id, senhaResetTokenHash: hashDoToken },
      data: {
        senhaHash: await AuthService.gerarHash(senhaNova),
        senhaResetTokenHash: null,
        senhaResetExpiraEm: null,
        /* Quem recuperou a senha PROVOU posse do e-mail — a mesma prova que o
           link de confirmação pede. Deixar a conta pendente depois disso seria
           exigir duas vezes o que já foi demonstrado uma. */
        emailConfirmadoEm: new Date(),
        /* Reset zera o bloqueio por tentativas: quem esqueceu a senha errou
           várias vezes ANTES de pedir o link, e sairia daqui com a senha nova e
           a porta ainda trancada. */
        tentativasFalhas: 0,
        bloqueadoAte: null,
      },
    });
    if (count === 0) throw new BadRequestException('Link inválido ou expirado. Peça um novo.');

    /* TODA sessão cai — inclusive a de quem eventualmente invadiu a conta. É a
       metade do "recuperar" que dá o acesso de VOLTA a quem é dono. */
    await this.tokens.revogarTodasDoUsuario(usuario.id);

    await this.prisma.auditLog.create({
      data: {
        organizationId: usuario.organizationId,
        userId: usuario.id,
        acao: 'SENHA_RESET_CONCLUIDO',
        entidade: 'User',
        entidadeId: usuario.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 500),
      },
    });
  }
}
