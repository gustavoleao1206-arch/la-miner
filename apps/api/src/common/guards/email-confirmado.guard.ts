import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { PUBLICO_KEY, type UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * "Não confirmou o e-mail, não acessa" — a metade do ACESSO.
 *
 * (A metade do PAGAMENTO não é guard nenhum: é a ORDEM do cadastro — a
 * cobrança só nasce em `confirmarEmail`, então não existe link de pagamento
 * antes da confirmação.)
 *
 * Mesmo desenho do MfaObrigatorioGuard, pelas mesmas razões: o LOGIN continua
 * passando — recusar ali deixaria o usuário sem sessão e sem tela — e é aqui
 * que tudo além das rotas públicas fecha com um código estável que o front
 * transforma em redirecionamento para a tela de confirmação.
 *
 * Desligado (o padrão) é invisível: nenhum custo, comportamento idêntico ao de
 * antes. E não há isenção além de @Publico() de propósito — um usuário sem
 * e-mail confirmado não tem NADA legítimo a fazer autenticado; as rotas de
 * confirmação e reenvio são públicas.
 */
@Injectable()
export class EmailConfirmadoGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.get<boolean>('CONFIRMACAO_EMAIL_ATIVA', false)) return true;

    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publico) return true;

    const user = context.switchToHttp().getRequest().user as UsuarioAutenticado | undefined;
    /* Sem usuário a decisão não é desta camada — o JwtAuthGuard já recusou. */
    if (!user) return true;
    if (user.emailConfirmado) return true;

    throw new ForbiddenException({
      message:
        'Confirme seu e-mail para acessar a conta. Enviamos um link para o endereço cadastrado.',
      error: 'EMAIL_NAO_CONFIRMADO',
    });
  }
}
