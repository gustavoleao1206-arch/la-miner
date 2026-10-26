import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MOTIVO_OUTRA_SESSAO,
  MOTIVO_SESSAO_ENCERRADA,
  type PayloadJwt,
} from '../application/token.service';
import { TIPO_DESAFIO } from '../application/desafio-mfa';
import type { UsuarioAutenticado } from '../../../common/decorators/papeis.decorator';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  /**
   * Revalida contra o banco a cada requisição.
   *
   * Um JWT válido não basta: se o usuário foi desativado ou teve o papel
   * rebaixado depois da emissão, o token ainda carrega os dados antigos.
   * Com access token de 15 min, esta consulta é o que fecha essa janela.
   */
  async validate(payload: PayloadJwt & { iat?: number; typ?: string }): Promise<UsuarioAutenticado> {
    /**
     * O bilhete do meio do login NÃO é uma sessão.
     *
     * O desafio de MFA é emitido para quem acertou a senha e ainda não provou o
     * segundo fator. Ele já é assinado com um segredo derivado, então nem chega
     * aqui — a verificação de assinatura o rejeita antes. Esta linha é a segunda
     * barreira, para o dia em que alguém "simplificar" a derivação: sem ela, o
     * MFA inteiro seria contornável ignorando a segunda tela, porque esta
     * strategy autentica por `sub` e nem olha os outros campos.
     */
    if (payload.typ === TIPO_DESAFIO) {
      throw new UnauthorizedException('Token de desafio não vale como sessão');
    }

    const usuario = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        papel: true,
        organizationId: true,
        ativo: true,
        gestor: true,
        /* O marco de revogação sai da MESMA consulta que já revalida o usuário
           — custo zero. É o que faz "encerrar sessões" e "trocar senha"
           valerem na hora, em vez de esperar o access token expirar. */
        sessoesRevogadasEm: true,
        /* A ÚNICA sessão válida. Sai da mesma consulta — custo zero, como os
           vizinhos — e é o que faz um segundo login derrubar o primeiro na
           requisição seguinte, em vez de esperar os 15 min do access token. */
        familiaSessaoAtual: true,
        /* Sai da mesma consulta — custo zero — e é o que o MfaObrigatorioGuard
           consulta para decidir se este usuário ainda pode circular sem ter
           cadastrado o segundo fator. */
        mfaConfirmadoEm: true,
        /* Mesma consulta, custo zero — alimenta o EmailConfirmadoGuard. */
        emailConfirmadoEm: true,
        /* O tipo da org vem junto porque decide o ESCOPO de tudo que o usuário lê
           (dona × assinante). Sai da mesma consulta que já revalida o usuário —
           custo zero — e nunca do token, então mudar uma org de tipo tem efeito
           no próximo request, sem reemitir credencial. */
        organization: { select: { tipo: true } },
      },
    });

    if (!usuario || !usuario.ativo) {
      throw new UnauthorizedException('Usuário inválido ou inativo');
    }

    /**
     * Token emitido ANTES da revogação não vale mais.
     *
     * Revogar os refresh tokens não derruba o access token — ele é
     * auto-contido e vale até expirar. Sem esta comparação, "encerrei as
     * sessões" era uma promessa cumprida 15 minutos depois, e o mesmo valia
     * para a troca de senha, que é justamente o que se faz ao suspeitar de
     * invasão.
     *
     * ⚠ `iat` tem resolução de SEGUNDOS. Um login no MESMO segundo da
     * revogação cai junto, e o usuário loga de novo. É o lado seguro do erro:
     * a alternativa seria deixar passar o token que se quis derrubar.
     */
    if (usuario.sessoesRevogadasEm && payload.iat !== undefined) {
      if (payload.iat * 1000 < usuario.sessoesRevogadasEm.getTime()) {
        throw new UnauthorizedException('Sessão encerrada. Entre novamente.');
      }
    }

    /**
     * UMA SESSÃO POR PESSOA — e é aqui que a anterior morre.
     *
     * Cada access token carrega a família em que nasceu; `familiaSessaoAtual`
     * guarda a do último login. Diferentes significa que alguém entrou depois —
     * e o token de quem estava aqui antes para de valer na requisição SEGUINTE,
     * e não daqui a 15 minutos.
     *
     * ⚠ `payload.fam === undefined` PASSA, e isso é deliberado: os tokens
     * emitidos antes do deploy desta mudança não têm o campo, e recusá-los
     * derrubaria todo mundo que estivesse logado no momento da publicação. Eles
     * expiram em 15 minutos e, do login seguinte em diante, todos têm `fam`.
     *
     * A distinção entre os dois motivos importa para a tela: "encerrada"
     * manda a pessoa entrar de novo; "outro dispositivo" explica o que
     * aconteceu — sem ela, o usuário jura que o sistema o desloga sozinho.
     */
    if (payload.fam !== undefined && payload.fam !== usuario.familiaSessaoAtual) {
      const outra = usuario.familiaSessaoAtual !== null;
      throw new UnauthorizedException({
        message: outra
          ? 'Sua conta foi aberta em outro dispositivo. Entre novamente para continuar aqui.'
          : 'Sessão encerrada. Entre novamente.',
        error: outra ? MOTIVO_OUTRA_SESSAO : MOTIVO_SESSAO_ENCERRADA,
      });
    }

    return {
      id: usuario.id,
      email: usuario.email,
      papel: usuario.papel, // papel atual do banco, não o do token
      organizationId: usuario.organizationId,
      tipo: usuario.organization.tipo,
      gestor: usuario.gestor,
      mfaHabilitado: usuario.mfaConfirmadoEm !== null,
      emailConfirmado: usuario.emailConfirmadoEm !== null,
    };
  }
}
