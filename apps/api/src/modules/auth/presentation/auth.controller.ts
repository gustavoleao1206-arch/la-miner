import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AuthService } from '../application/auth.service';
import { MfaService } from '../application/mfa.service';
import {
  CodigoMfaDto,
  DesativarMfaDto,
  LoginDto,
  LoginRespostaDto,
  RedefinirSenhaDto,
  SolicitarRedefinicaoDto,
  TrocarSenhaDto,
  TokensRespostaDto,
  VerificarMfaDto,
  ZerarMfaDto,
} from './auth.dto';
import {
  definirCookieRefresh,
  lerCookieRefresh,
  limparCookieRefresh,
} from './cookie-refresh';
import {
  Papeis,
  Publico,
  SemMfa,
  UsuarioAtual,
  type UsuarioAutenticado,
} from '../../../common/decorators/papeis.decorator';
import { OrganizacaoInternaGuard } from '../../../common/guards/organizacao-interna.guard';

/**
 * ── O REFRESH TOKEN NÃO PASSA MAIS PELO CORPO ──
 *
 * Ele entra e sai por um cookie httpOnly (ver `cookie-refresh.ts`). O front não
 * o vê, não o guarda e não o envia — e um XSS não tem como levá-lo embora.
 *
 * Consequência de contrato: `login` e `refresh` devolvem SÓ o access token.
 * Quem consumir a API fora do navegador precisa guardar o cookie (todo cliente
 * HTTP sério faz isso com um cookie jar).
 *
 * Consequência de migração: sessões abertas antes desta mudança têm o refresh
 * no sessionStorage e nenhum cookie. Elas caem no próximo refresh e o usuário
 * loga de novo — uma vez.
 */
@ApiTags('Autenticação')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly config: ConfigService,
  ) {}

  private contexto(req: Request) {
    return {
      ip: req.ip ?? req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
    };
  }

  /** Grava o cookie e devolve ao corpo apenas o que o front pode ver. */
  private responder(res: Response, par: { accessToken: string; refreshToken: string; expiraEm: number }) {
    definirCookieRefresh(res, par.refreshToken, this.config);
    return { accessToken: par.accessToken, expiraEm: par.expiraEm };
  }

  @Publico()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  /* Limite estreito: login é o alvo natural de força bruta.
     ⚠ O nome do throttler PRECISA existir. Os registrados em app.module.ts se
     chamam `curto` e `medio`; escrever `default` gravava a chave
     THROTTLER:LIMITdefault, que o guard nunca procura — o decorator era
     metadado morto e o login aceitava os 120/min do limite global. Sobrescrever
     `medio` deixa o teto real em 15/min; `curto` (10/s) segue valendo como
     proteção de rajada.
     ── POR QUE 15, E NÃO 5 ──
     O balde é por `req.ip`, e um escritório atrás de NAT apresenta UM IP para
     todo mundo. O produto acabou de passar a VENDER 5 perfis por assinatura
     (`usuariosPorPlano`), e a sessão única obriga cada pessoa a ter o seu — ou
     seja, o padrão esperado passou a ser cinco logins do mesmo IP na mesma
     janela, tipicamente às 9h. Com 5/min o quinto colega tomava 429 no primeiro
     dia de uso normal, e o suporte receberia "o sistema não deixa entrar".
     A defesa contra força bruta DIRIGIDA a uma conta não mora aqui e não
     enfraquece: são `tentativasFalhas`/`bloqueadoAte` (5 erros bloqueiam), que
     contam por USUÁRIO. Este balde existe contra varredura de senhas em muitas
     contas de um mesmo ponto, e 15/min continua inviabilizando isso. */
  @Throttle({ medio: { limit: 15, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Autentica; devolve os tokens ou o desafio do segundo fator',
    description:
      'Com MFA ativo, a senha correta NÃO abre sessão: a resposta traz ' +
      '`mfaRequerido: true` e um desafio, que vai para /auth/mfa/verificar.',
  })
  @ApiResponse({ status: 200, type: LoginRespostaDto })
  @ApiResponse({ status: 401, description: 'Credenciais inválidas' })
  @ApiResponse({ status: 403, description: 'Conta bloqueada ou inativa' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    /* `passthrough: true`: mexo no cabeçalho, mas quem serializa a resposta
       continua sendo o Nest — sem isso a requisição ficaria pendurada. */
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginRespostaDto> {
    const r = await this.auth.login(dto.email, dto.senha, this.contexto(req));

    /* Sem cookie e sem token neste ramo. O desafio prova só que a senha estava
       certa; sessão nenhuma foi aberta. */
    if (r.mfaRequerido) return { mfaRequerido: true, desafio: r.desafio };

    return { mfaRequerido: false, ...this.responder(res, r) };
  }

  @Publico()
  @Post('mfa/verificar')
  @HttpCode(HttpStatus.OK)
  /* O mesmo teto do login, e pelo mesmo motivo de NAT explicado lá: é aqui que
     se bate num código de seis dígitos, e o bloqueio por tentativas (5 erros)
     corre em paralelo, na conta. */
  @Throttle({ medio: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: 'Passo 2 do login: confere o código do app ou de recuperação' })
  @ApiResponse({ status: 200, type: TokensRespostaDto })
  async verificarMfa(
    @Body() dto: VerificarMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokensRespostaDto> {
    return this.responder(
      res,
      await this.auth.verificarSegundoFator(dto.desafio, dto.codigo, this.contexto(req)),
    );
  }

  @Publico()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ medio: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rotaciona o refresh token (lido do cookie httpOnly)',
    description:
      'Não recebe corpo: o refresh vem do cookie. Cada refresh só pode ser usado uma vez. ' +
      'Apresentar um token já usado é tratado como roubo: a família inteira é revogada.',
  })
  @ApiResponse({ status: 200, type: TokensRespostaDto })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokensRespostaDto> {
    const token = lerCookieRefresh(req);
    /* Sem cookie é 401, e não 400: para quem chama, "não estou autenticado" e
       "minha sessão morreu" são a mesma situação e levam à mesma tela. Um 400
       faria o cliente tratar como erro de programação e não redirigir. */
    if (!token) throw new UnauthorizedException('Sessão ausente ou expirada');

    /* Se a rotação falhar (token revogado, expirado, reuso detectado), o cookie
       tem de MORRER. Deixá-lo no navegador faria o front repetir um refresh que
       nunca vai funcionar a cada 401. */
    try {
      return this.responder(res, await this.auth.refresh(token, this.contexto(req)));
    } catch (e) {
      limparCookieRefresh(res, this.config);
      throw e;
    }
  }

  @Publico()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Encerra a sessão (revoga a família do token)',
    description: 'Não recebe corpo: o refresh vem do cookie, que é apagado na resposta.',
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = lerCookieRefresh(req);
    /* O cookie sai SEMPRE, mesmo sem token válido: sair tem de funcionar
       inclusive quando a sessão já estava quebrada. */
    limparCookieRefresh(res, this.config);
    if (token) await this.auth.logout(token);
  }

  /* Qualquer autenticado — mas declarado, não presumido. */
  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  /* Isenta da política: é por aqui que o front descobre QUEM está logado, e ele
     precisa disso justamente na tela que pede o cadastro do segundo fator. */
  @SemMfa()
  @Get('eu')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Dados do usuário autenticado' })
  eu(@UsuarioAtual() usuario: UsuarioAutenticado): UsuarioAutenticado {
    return usuario;
  }

  // ───────────────────────── Segundo fator ─────────────────────────
  //
  // Todas isentas da política (@SemMfa): quando o ambiente EXIGE MFA, é por
  // estas rotas que quem ainda não cadastrou consegue cumprir a exigência. Sem a
  // isenção, a política trancaria a porta pelo lado de dentro.

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @SemMfa()
  @Get('mfa')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Situação do segundo fator para o usuário logado' })
  situacaoMfa(@UsuarioAtual('id') userId: string) {
    return this.mfa.situacao(userId);
  }

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @SemMfa()
  @Post('mfa/cadastrar')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Passo 1: gera o segredo e a URI do QR code',
    description: 'Ainda NÃO ativa o MFA — é preciso confirmar com um código do app.',
  })
  iniciarMfa(@UsuarioAtual('id') userId: string) {
    return this.mfa.iniciarCadastro(userId);
  }

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @SemMfa()
  @Post('mfa/confirmar')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Passo 2: confirma o cadastro e entrega os códigos de recuperação',
    description: 'Os códigos aparecem em claro UMA única vez, nesta resposta.',
  })
  confirmarMfa(@UsuarioAtual('id') userId: string, @Body() dto: CodigoMfaDto) {
    return this.mfa.confirmarCadastro(userId, dto.codigo);
  }

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @Post('mfa/codigos')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Emite um jogo novo de códigos, invalidando os anteriores' })
  renovarCodigos(@UsuarioAtual('id') userId: string, @Body() dto: CodigoMfaDto) {
    return this.mfa.renovarCodigos(userId, dto.codigo);
  }

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @Post('mfa/desativar')
  /* Confere a SENHA, então tem o mesmo teto do `mfa/zerar`: sem ele, esta rota
     vira um balcão de adivinhação de senha para DESLIGAR o segundo fator — a que
     mais interessa a quem tomou uma sessão, porque remove o fator que ela não
     tem. A reconferência não alimenta o `tentativasFalhas` (o bloqueio por
     conta), e o teto global de 120/min não é uma trava — é o balde que resta. */
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Desliga o segundo fator',
    description:
      'Pede a SENHA, e não um código: o cenário a proteger é o telefone perdido ' +
      'com a sessão aberta, onde o app autenticador está justamente com quem o achou.',
  })
  async desativarMfa(
    @UsuarioAtual('id') userId: string,
    @Body() dto: DesativarMfaDto,
  ): Promise<void> {
    await this.mfa.desativar(userId, dto.senha);
  }

  /**
   * A saída de emergência de quem perdeu o telefone E os códigos de recuperação.
   *
   * ⚠ NÃO é `@SemMfa`. Quem executa precisa do próprio segundo fator em ordem —
   * seria absurdo que a rota que restaura o MFA alheio fosse a brecha para
   * contornar a política. O admin trancado usa os próprios códigos de
   * recuperação; se perdeu também os dele, aí sim é caso de shell.
   *
   * O teto de 5/min existe porque a rota confere senha: sem ele, ela viraria um
   * balcão de tentativa de senha do admin, com a vantagem de não bloquear conta
   * nenhuma no caminho.
   */
  @Papeis('ADMIN')
  @UseGuards(OrganizacaoInternaGuard)
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @Post('mfa/zerar')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'ADMIN: remove o segundo fator de outro usuário da própria organização',
    description:
      'Para quem perdeu o telefone E os códigos de recuperação. Pede a senha de QUEM ' +
      'EXECUTA, recusa o próprio id, e registra em AuditLog (MFA_ZERADO_POR_ADMIN) ' +
      'quem zerou o de quem. O alvo entra com a senha e cadastra o segundo fator de novo.',
  })
  zerarMfaDeOutro(
    @UsuarioAtual() ator: UsuarioAutenticado,
    @Body() dto: ZerarMfaDto,
    @Req() req: Request,
  ) {
    return this.mfa.zerarDeOutroUsuario(ator, dto.usuarioId, dto.senha, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @Post('trocar-senha')
  /* Confere a senha ATUAL, então 5/min como as outras reconferências: sem teto
     próprio, uma sessão tomada tentaria adivinhar a senha a 120/min/IP para
     FIXAR o acesso (trocar a senha derruba as outras sessões, inclusive a do
     dono). A reconferência não alimenta o bloqueio por conta, então o balde é o
     que segura a força bruta aqui. */
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Troca a senha',
    description: 'Revoga todas as sessões ativas do usuário, inclusive a atual.',
  })
  async trocarSenha(
    @UsuarioAtual('id') userId: string,
    @Body() dto: TrocarSenhaDto,
  ): Promise<void> {
    await this.auth.trocarSenha(userId, dto.senhaAtual, dto.senhaNova);
  }

  // ── Esqueci minha senha: as duas únicas rotas que dão acesso sem credencial ──

  @Publico()
  @Post('esqueci-senha')
  @HttpCode(HttpStatus.NO_CONTENT)
  /* 3/min, como o reenvio de confirmação: cada aceite pode virar um e-mail de
     verdade, e e-mail em rajada queima a reputação do domínio — além de virar
     vetor de spam com o nosso nome no remetente. */
  @Throttle({ medio: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Pede o link de redefinição de senha',
    description:
      'Responde 204 SEMPRE — exista ou não o e-mail. Distinguir transformaria ' +
      'esta rota pública num verificador de cadastro: com uma lista de e-mails, ' +
      'qualquer um descobriria quais escritórios são clientes.',
  })
  async esqueciSenha(@Body() dto: SolicitarRedefinicaoDto, @Req() req: Request): Promise<void> {
    await this.auth.solicitarRedefinicao(dto.email, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @Publico()
  @Post('redefinir-senha')
  @HttpCode(HttpStatus.NO_CONTENT)
  /* Mais apertado que o pedido: aqui se ADIVINHA token. 10/min por IP não
     atrapalha ninguém que recebeu o link e erra a senha nova duas vezes, e
     torna inviável varrer o espaço de 32 bytes. */
  @Throttle({ medio: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Define a nova senha a partir do link',
    description:
      'Token inválido, vencido e já usado recebem a MESMA mensagem. Derruba ' +
      'todas as sessões do usuário — inclusive a de quem tenha invadido a conta.',
  })
  async redefinirSenha(@Body() dto: RedefinirSenhaDto, @Req() req: Request): Promise<void> {
    await this.auth.redefinirSenha(dto.token, dto.senha, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
