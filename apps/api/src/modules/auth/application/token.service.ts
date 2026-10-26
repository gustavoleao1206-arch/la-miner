import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import type { Papel } from '@miner/database';

/**
 * Formato de TTL aceito pelo `jsonwebtoken`: "15m", "7d", "3600s".
 *
 * O @nestjs/jwt 11 passou a tipar `expiresIn` com o literal do pacote `ms`, e
 * uma `string` solta deixou de compilar. A saída NÃO é converter para segundos:
 * `ttlParaMs` cai em 7 dias quando não reconhece o formato, e um
 * `JWT_ACCESS_TTL` escrito errado transformaria o access token de 15 minutos
 * num de uma semana, em silêncio.
 *
 * Aqui a validação é explícita: formato inválido derruba a emissão com uma
 * mensagem que diz o que está errado — que é o que o `jsonwebtoken` fazia antes
 * de o tipo apertar, e o comportamento que se quer preservar.
 */
type TtlJwt = `${number}${'s' | 'm' | 'h' | 'd'}`;

function ttlParaJwt(ttl: string): TtlJwt {
  if (!/^\d+[smhd]$/.test(ttl)) {
    throw new Error(
      `TTL de token inválido: "${ttl}". Use um número seguido de s, m, h ou d (ex.: 15m, 7d).`,
    );
  }
  return ttl as TtlJwt;
}

/**
 * Códigos ESTÁVEIS de fim de sessão — o campo `erro` do corpo da resposta.
 *
 * O front usa o código, nunca o texto: casar por mensagem quebraria na primeira
 * revisão de redação, e é a mesma razão pela qual o `MFA_OBRIGATORIO` existe.
 * Quem lê: `apps/web/lib/api.ts`, que os transforma em `/login?motivo=…`.
 */
export const MOTIVO_OUTRA_SESSAO = 'OUTRA_SESSAO';
export const MOTIVO_SESSAO_ENCERRADA = 'SESSAO_ENCERRADA';
export const MOTIVO_SESSAO_OCIOSA = 'SESSAO_OCIOSA';

export interface PayloadJwt {
  sub: string; // userId
  email: string;
  papel: Papel;
  org: string; // organizationId
  /**
   * A família de refresh a que este access token pertence.
   *
   * É o que permite matar um access token JÁ EMITIDO quando outra sessão do
   * mesmo usuário assume: a JwtStrategy compara com `User.familiaSessaoAtual`.
   *
   * OPCIONAL de propósito. Os tokens emitidos antes do deploy desta mudança não
   * têm o campo, e `undefined` passa pela checagem — ninguém é derrubado pela
   * publicação. A trava passa a valer no primeiro login de cada um.
   */
  fam?: string;
}

export interface ParDeTokens {
  accessToken: string;
  refreshToken: string;
  expiraEm: number;
}

interface ContextoRequisicao {
  ip?: string;
  userAgent?: string;
}

/**
 * Emissão e rotação de tokens.
 *
 * Modelo de refresh rotativo com detecção de reuso:
 *  - cada refresh é usado UMA vez; ao ser usado, é revogado e um novo é emitido
 *    na mesma "família";
 *  - se um refresh JÁ REVOGADO for apresentado, isso significa que alguém
 *    obteve uma cópia — a família inteira é derrubada e o usuário precisa
 *    logar de novo.
 *
 * O token nunca é guardado em claro: o banco só tem o SHA-256.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private ttlParaMs(ttl: string): number {
    const m = /^(\d+)([smhd])$/.exec(ttl);
    if (!m) return 7 * 24 * 60 * 60 * 1000;
    const n = Number(m[1]);
    const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] ?? 1000;
    return n * mult;
  }

  async emitirPar(
    payload: PayloadJwt,
    ctx: ContextoRequisicao = {},
    // Tipado como string (e não o literal de randomUUID) porque a rotação
    // reaproveita o familiaId que veio do banco.
    familiaId: string = randomUUID(),
  ): Promise<ParDeTokens> {
    const accessTtl = this.config.getOrThrow<string>('JWT_ACCESS_TTL');
    const refreshTtl = this.config.getOrThrow<string>('JWT_REFRESH_TTL');

    /* A família VIAJA no access token. Sem ela, derrubar a sessão anterior num
       novo login dependeria de um carimbo de tempo — e `iat` tem resolução de
       segundos, o que recusaria o token que o próprio login acabou de emitir.
       Ver `abrirSessaoUnica`. */
    const accessToken = await this.jwt.signAsync(
      { ...payload, fam: familiaId },
      {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: ttlParaJwt(accessTtl),
      },
    );

    const refreshToken = await this.jwt.signAsync(
      /* `jti` único por token. Sem ele, o payload seria só `{ sub, familia }` e
         o `iat` do JWT tem resolução de SEGUNDOS: dois tokens da MESMA família
         emitidos no mesmo segundo — o que acontece quando o cliente faz refresh
         logo após o login — sairiam byte a byte idênticos, com o mesmo
         SHA-256, e o `create` abaixo estouraria o unique de `tokenHash` (P2002).
         O antigo já teria sido revogado, deixando a sessão morta com um 500.
         O `jti` é ignorado na rotação (que só lê `sub` e `familia`); serve só
         para tornar cada token distinto. */
      { sub: payload.sub, familia: familiaId, jti: randomUUID() },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: ttlParaJwt(refreshTtl),
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId: payload.sub,
        tokenHash: this.hashToken(refreshToken),
        familiaId,
        expiraEm: new Date(Date.now() + this.ttlParaMs(refreshTtl)),
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 500),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiraEm: Math.floor(this.ttlParaMs(accessTtl) / 1000),
    };
  }

  /**
   * Abre a ÚNICA sessão do usuário — e derruba a anterior.
   *
   * Chamada só pelos dois pontos onde alguém prova quem é: o login de uma etapa
   * e o segundo fator. NÃO fica dentro de `emitirPar`, porque a rotação também
   * passa por lá — e revogar a família que se está rotacionando encerraria a
   * sessão a cada renovação, de 15 em 15 minutos.
   *
   * ── POR QUE UMA FAMÍLIA, E NÃO `sessoesRevogadasEm` ──
   *
   * O caminho óbvio seria reusar `revogarTodasDoUsuario`, que já derruba tudo.
   * Ele não serve aqui: aquele método carimba `sessoesRevogadasEm = agora` com
   * MILISSEGUNDOS, e a JwtStrategy recusa todo token cujo `iat` seja anterior.
   * Como `iat` tem resolução de SEGUNDOS, um login às 10:00:03.417 emitiria um
   * token com iat = 10:00:03.000 — anterior ao próprio marco. O usuário entraria
   * e seria expulso no mesmo gesto, e insistir só repetiria.
   *
   * Comparar IDENTIDADE de família não tem essa borda: ou o token é da sessão
   * atual, ou não é.
   *
   * ── ORDEM: REVOGA ANTES DE EMITIR ──
   *
   * Se a emissão falhar depois da revogação, o usuário fica sem sessão nenhuma e
   * entra de novo. Na ordem inversa, uma falha deixaria as sessões antigas VIVAS
   * — quebrando justamente a garantia que este método existe para dar.
   */
  async abrirSessaoUnica(payload: PayloadJwt, ctx: ContextoRequisicao = {}): Promise<ParDeTokens> {
    const familiaId = randomUUID();

    /* As duas escritas numa transação: um marco de sessão apontando para uma
       família cujos tokens não foram revogados (ou o contrário) seria uma
       revogação pela metade, que é pior que nenhuma porque parece feita. */
    const [revogados] = await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub, revogadoEm: null },
        data: { revogadoEm: new Date() },
      }),
      this.prisma.user.update({
        where: { id: payload.sub },
        data: { familiaSessaoAtual: familiaId },
      }),
    ]);

    if (revogados.count > 0) {
      /* `log`, e não `warn`: entrar de outro computador é o uso normal do
         sistema, não um incidente. O alarme desta classe é o "reuso detectado",
         e misturar os dois esconderia o que importa. */
      this.logger.log(
        `Sessão anterior encerrada por novo login (userId=${payload.sub}, tokens=${revogados.count}).`,
      );
    }

    return this.emitirPar(payload, ctx, familiaId);
  }

  async rotacionar(refreshToken: string, ctx: ContextoRequisicao = {}): Promise<ParDeTokens> {
    let decodificado: { sub: string; familia: string };
    try {
      decodificado = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token inválido ou expirado');
    }

    const hash = this.hashToken(refreshToken);
    const registro = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: { user: true },
    });

    if (!registro) {
      throw new UnauthorizedException('Refresh token não reconhecido');
    }

    /**
     * ── SUPERADA POR OUTRO LOGIN — e isto NÃO é reuso ──
     *
     * Precisa vir ANTES da detecção de reuso, e a ordem é o ponto.
     *
     * `abrirSessaoUnica` revoga os refresh tokens da sessão anterior. Quando
     * aquele navegador tenta renovar, ele apresenta um token revogado — que é
     * exatamente a assinatura de um roubo. Sem esta porta, todo login num
     * segundo computador gravaria "Reuso de refresh token detectado" no log de
     * segurança. O alarme deixaria de significar alguma coisa: o dono do
     * escritório entrando de casa produziria a mesma linha que um invasor com
     * uma cópia do token, e o roubo de verdade chegaria no meio do ruído.
     *
     * A condição é `!== null &&`: só quando existe OUTRA sessão viva a
     * conclusão é "alguém entrou depois de você". Com `familiaSessaoAtual` nula
     * (logout, senha trocada, sessões encerradas) não há outra sessão a
     * apontar, e o caso segue para a detecção de reuso, como antes.
     *
     * Vale para token revogado E para token vivo de família antiga — o segundo
     * caso aparece quando dois logins correm ao mesmo tempo.
     */
    const familiaAtual = registro.user.familiaSessaoAtual;
    if (familiaAtual !== null && registro.familiaId !== familiaAtual) {
      throw new UnauthorizedException({
        message: 'Sua conta foi aberta em outro dispositivo. Entre novamente para continuar aqui.',
        error: MOTIVO_OUTRA_SESSAO,
      });
    }

    /**
     * ── O TETO DE OCIOSIDADE: A SESSÃO NÃO ATRAVESSA A NOITE ──
     *
     * A aba se pausa sozinha aos 30 minutos, mas quem decide isso é o
     * NAVEGADOR — para o servidor aquela sessão seguia viva e o cookie seguia
     * valendo. O cenário concreto: notebook aberto na sexta às 18h com a aba
     * pausada; na segunda, quem sentar ali clica em "Continuar trabalhando" e
     * ENTRA, sem senha e sem segundo fator. O cadeado da aba é uma cortina, não
     * uma porta. Aqui é a porta.
     *
     * ⚠ O TETO É SOBRE FICAR PARADO, NÃO SOBRE TEMPO LOGADO. `criadoEm` deste
     * registro é o instante da ÚLTIMA renovação daquela família, então quem está
     * trabalhando renova de 15 em 15 minutos e nunca chega perto do teto. Oito
     * horas paradas, na prática, é a noite: um login por manhã.
     *
     * Não precisou de coluna nova — o dado já estava aqui. A imprecisão é
     * conhecida e pequena: a renovação só acontece quando o access de 15 min
     * expira, então o carimbo fica no máximo 15 minutos atrasado em relação ao
     * uso real. Para um teto medido em horas, é ruído.
     *
     * ── POR QUE ANTES DA DETECÇÃO DE REUSO ──
     *
     * Mesma razão da porta de "outra sessão", logo acima: um cookie velho
     * reapresentado depois de uma noite é o navegador acordando, não um roubo.
     * Deixar cair no reuso encheria o log de alarme falso todo santo dia às 8h —
     * e alarme que toca sempre não significa mais nada. A família é revogada do
     * mesmo jeito, então a consequência de segurança é idêntica; o que muda é
     * que o log não mente.
     */
    const ociosaMs = this.config.get<number>('SESSAO_OCIOSA_HORAS', 8) * 3_600_000;
    if (Date.now() - registro.criadoEm.getTime() > ociosaMs) {
      this.logger.log(
        `Sessão encerrada por ociosidade (userId=${registro.userId}, familia=${registro.familiaId}).`,
      );
      await this.prisma.$transaction([
        this.prisma.refreshToken.updateMany({
          where: { familiaId: registro.familiaId, revogadoEm: null },
          data: { revogadoEm: new Date() },
        }),
        this.prisma.user.updateMany({
          where: { id: registro.userId, familiaSessaoAtual: registro.familiaId },
          data: { familiaSessaoAtual: null },
        }),
      ]);
      throw new UnauthorizedException({
        message: 'Sua sessão expirou por falta de uso. Entre novamente.',
        error: MOTIVO_SESSAO_OCIOSA,
      });
    }

    // ── Detecção de reuso ──────────────────────────────────────
    if (registro.revogadoEm) {
      this.logger.warn(
        `Reuso de refresh token detectado (userId=${registro.userId}, familia=${registro.familiaId}). Derrubando a família inteira.`,
      );
      /* O MARCO CAI JUNTO — e este era o único dos quatro pontos de revogação
         que esquecia dele.
         O roubo típico é o ladrão usar a cópia PRIMEIRO: ele rotaciona, recebe
         um par novo na mesma família, e é o dono que dispara a detecção depois,
         apresentando o token que virou velho. Revogar só os refresh deixaria o
         ACCESS do ladrão — auto-contido — valendo por até 15 minutos, dentro da
         conta, DEPOIS de o sistema já ter concluído que houve roubo.
         `updateMany` com a família no WHERE, e não `update` por id: é
         compare-and-set, e não derruba a sessão que um login concorrente tenha
         acabado de abrir. */
      await this.prisma.$transaction([
        this.prisma.refreshToken.updateMany({
          where: { familiaId: registro.familiaId, revogadoEm: null },
          data: { revogadoEm: new Date() },
        }),
        this.prisma.user.updateMany({
          where: { id: registro.userId, familiaSessaoAtual: registro.familiaId },
          data: { familiaSessaoAtual: null },
        }),
      ]);
      throw new UnauthorizedException('Sessão encerrada por segurança. Faça login novamente.');
    }

    if (registro.expiraEm < new Date()) {
      throw new UnauthorizedException('Refresh token expirado');
    }
    if (!registro.user.ativo) {
      throw new UnauthorizedException('Usuário inativo');
    }

    /**
     * Consome este token — com COMPARE-AND-SET, e não `update` por id.
     *
     * Entre a leitura lá em cima e esta linha cabe um login inteiro de outra
     * máquina. Com `update` por id, o token já revogado por aquele login era
     * simplesmente recarimbado, sem reclamar, e a rotação seguia adiante
     * emitindo um par NOVO e VIVO numa família que o sistema acabara de matar —
     * ressuscitando a sessão que a trava existe para encerrar.
     *
     * `revogadoEm: null` no WHERE faz a condição valer no banco: quem perdeu a
     * corrida recebe count = 0 e é mandado para o login, em vez de ganhar uma
     * sessão fantasma.
     */
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: registro.id, revogadoEm: null },
      data: { revogadoEm: new Date() },
    });
    if (count === 0) {
      throw new UnauthorizedException({
        message: 'Sua conta foi aberta em outro dispositivo. Entre novamente para continuar aqui.',
        error: MOTIVO_OUTRA_SESSAO,
      });
    }

    /**
     * ── A SESSÃO QUE ATRAVESSA O DEPLOY É ADOTADA AQUI ──
     *
     * Sem estas linhas, a compatibilidade prometida durava 15 minutos e virava
     * uma armadilha. Quem estivesse logado na hora da publicação tem a coluna
     * NULA (a migration não faz backfill) e um refresh VIVO. O access antigo,
     * sem `fam`, passa — até expirar. Aí o front renova, esta rotação carimba
     * `fam` no token novo, e a JwtStrategy o recusa contra a coluna nula: 401.
     *
     * E o front não salvava ninguém: o refresh responde 200, então ele não
     * conclui "sessão morta" nem manda para o login — a pessoa ficava num laço
     * 401 → refresh 200 → 401, numa tela que só erra, sem saber que bastava
     * entrar de novo. TODOS os usuários logados, ~15 min depois do deploy.
     *
     * ── POR QUE ADOTAR É SEGURO, E POR QUE AQUI ──
     *
     * A posição é o argumento. Neste ponto o token já passou pela detecção de
     * reuso, pela expiração e pelo compare-and-set — ou seja, ele está VIVO. E
     * os três lugares que zeram `familiaSessaoAtual` (logout, revogar todas,
     * redefinir senha) revogam os refresh na MESMA transação: depois de
     * qualquer um deles não sobra token vivo nenhum. Coluna nula + token vivo
     * só existe num caso, o da sessão que precede esta funcionalidade.
     *
     * De quebra, a trava passa a valer da primeira RENOVAÇÃO de cada um, e não
     * do primeiro login — mais cedo do que o desenho prometia.
     */
    if (familiaAtual === null) {
      await this.prisma.user.update({
        where: { id: registro.userId },
        data: { familiaSessaoAtual: registro.familiaId },
      });
    }

    return this.emitirPar(
      {
        sub: registro.user.id,
        email: registro.user.email,
        papel: registro.user.papel,
        org: registro.user.organizationId,
      },
      ctx,
      registro.familiaId,
    );
  }

  /** Logout: revoga a família do token apresentado (não todas as sessões). */
  async revogarFamilia(refreshToken: string): Promise<void> {
    const registro = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      select: { familiaId: true, userId: true },
    });
    if (!registro) return;

    /**
     * O marco da sessão só cai se for ESTA a sessão que está saindo — e a
     * condição vai no WHERE, não num `if`.
     *
     * O PORQUÊ DA CONDIÇÃO: sem ela, um logout tardio de uma sessão já superada
     * derrubaria a sessão VIVA. A pessoa entra no computador de casa e, no dia
     * seguinte, o navegador do escritório (que ainda tem o cookie) clica em
     * "Sair" — e quem é expulso é ela, em casa. O `updateMany` dos tokens é
     * inofensivo nesse caso, porque mexe numa família já revogada; zerar o
     * marco não seria.
     *
     * O PORQUÊ DO `updateMany`: a versão com `if` lia o valor, ia ao banco
     * revogar os tokens e só então comparava — e nessa janela cabe um login
     * inteiro. Bastava a pessoa entrar em casa entre a leitura e a escrita para
     * o logout do escritório zerar o marco da sessão RECÉM-ABERTA, derrubando
     * exatamente quem o `if` existia para proteger. Com a condição no WHERE a
     * comparação acontece no banco, na mesma instrução — é o padrão que o
     * `mfa.service.ts` já usa no consumo de código de recuperação, pela mesma
     * razão.
     *
     * Zerar (em vez de deixar apontando para uma família morta) é o que faz o
     * logout valer NA HORA para o access token: sem isto ele seguiria aceito
     * até expirar, por até 15 minutos, para quem quer que o tivesse copiado.
     */
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { familiaId: registro.familiaId, revogadoEm: null },
        data: { revogadoEm: new Date() },
      }),
      this.prisma.user.updateMany({
        where: { id: registro.userId, familiaSessaoAtual: registro.familiaId },
        data: { familiaSessaoAtual: null },
      }),
    ]);
  }

  /**
   * Revoga TODAS as sessões do usuário — de verdade, e na hora.
   *
   * ── O QUE ESTAVA FALTANDO ──
   *
   * Isto só revogava os REFRESH tokens. O access token é auto-contido e
   * continuava valendo até expirar: até 15 minutos de acesso para quem já
   * estava dentro. O chamador principal é a troca de senha, cujo comentário
   * afirmava derrubar "inclusive a de um invasor" — e não derrubava.
   *
   * O marco em `sessoesRevogadasEm` fecha isso: a JwtStrategy recusa qualquer
   * token emitido antes dele, usando a consulta ao usuário que ela já fazia.
   *
   * As duas escritas vão numa TRANSAÇÃO. Sem ela, o marco poderia gravar e a
   * revogação dos refresh falhar (ou o contrário) — e uma revogação pela
   * metade é pior que nenhuma, porque parece feita.
   */
  async revogarTodasDoUsuario(userId: string): Promise<{ sessoesEncerradas: number }> {
    const agora = new Date();

    const [tokens] = await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revogadoEm: null },
        data: { revogadoEm: agora },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          sessoesRevogadasEm: agora,
          /* E o marco de sessão junto. O carimbo de tempo já derrubaria tudo,
             mas deixar `familiaSessaoAtual` apontando para uma família morta
             seria um estado que mente: "há uma sessão aberta" onde não há. É
             disso que o `rotacionar` se serve para distinguir "outro login" de
             "reuso", e a resposta errada mandaria a pessoa para a tela errada. */
          familiaSessaoAtual: null,
        },
      }),
    ]);

    /* Conta FAMÍLIAS não é possível daqui sem outra consulta; o número de
       tokens revogados é o que se tem, e serve ao propósito de dizer se havia
       sessão viva. */
    return { sessoesEncerradas: tokens.count };
  }

  /**
   * Sessões vivas de um usuário, uma por família.
   *
   * Uma família = um dispositivo/navegador que fez login. Listar token a token
   * mostraria a mesma sessão várias vezes, porque a rotação cria um registro
   * novo a cada renovação — e um usuário de um dia teria dezenas de linhas
   * para a mesma aba aberta.
   */
  async sessoesDe(userId: string) {
    const tokens = await this.prisma.refreshToken.findMany({
      where: { userId, revogadoEm: null, expiraEm: { gt: new Date() } },
      select: { familiaId: true, ip: true, userAgent: true, criadoEm: true, expiraEm: true },
      orderBy: { criadoEm: 'desc' },
    });

    const porFamilia = new Map<string, (typeof tokens)[number]>();
    for (const t of tokens) {
      /* O mais RECENTE da família representa a sessão: é a última renovação,
         e é dela que saem o IP e o navegador atuais. */
      if (!porFamilia.has(t.familiaId)) porFamilia.set(t.familiaId, t);
    }

    return [...porFamilia.values()].map((t) => ({
      id: t.familiaId,
      ip: t.ip,
      /* Cortado: user-agent inteiro tem 200+ caracteres e a tela mostra numa
         linha. O suficiente para reconhecer o navegador. */
      dispositivo: t.userAgent?.slice(0, 120) ?? null,
      ultimaAtividadeEm: t.criadoEm,
      expiraEm: t.expiraEm,
    }));
  }

  /** Higiene: remove tokens expirados/revogados antigos. Chamado por cron. */
  async limparExpirados(): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: { expiraEm: { lt: new Date(Date.now() - 30 * 86_400_000) } },
    });
    return count;
  }
}
