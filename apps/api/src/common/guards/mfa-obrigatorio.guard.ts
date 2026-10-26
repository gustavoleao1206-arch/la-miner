import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MfaService } from '../../modules/auth/application/mfa.service';
import { PUBLICO_KEY, SEM_MFA_KEY, type UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * A política de MFA, aplicada.
 *
 * ── POR QUE UM GUARD, E NÃO UM TERCEIRO CAMINHO NO LOGIN ──
 *
 * A alternativa seria o login recusar quem não tem MFA cadastrado. Mas aí o
 * usuário fica sem sessão nenhuma — e sem sessão ele não alcança a tela de
 * cadastro. Sobraria fazer um fluxo de cadastro que roda sem autenticação, que é
 * exatamente o tipo de rota que não se quer ter.
 *
 * Com o guard, quem está em falta ENTRA (a senha continua valendo) mas não
 * alcança nada além do próprio cadastro de MFA. O usuário resolve sozinho, sem
 * pedir nada a ninguém, e sem porta lateral.
 *
 * O 403 sai com `erro: 'MFA_OBRIGATORIO'` — a única coisa desta resposta que o
 * front deve inspecionar. Casar por texto de mensagem quebra na primeira revisão
 * de redação.
 */
@Injectable()
export class MfaObrigatorioGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly mfa: MfaService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    /* Desligado é o padrão: nenhuma consulta, nenhum custo, comportamento
       idêntico ao de antes desta mudança. */
    if (this.mfa.politica() === 'nenhum') return true;

    const isento = this.reflector.getAllAndOverride<boolean>(SEM_MFA_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isento) return true;

    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publico) return true;

    const user = context.switchToHttp().getRequest().user as UsuarioAutenticado | undefined;
    /* Sem usuário, a decisão não é desta camada: o JwtAuthGuard já recusou, ou a
       rota é pública e caiu no ramo acima. */
    if (!user) return true;

    if (!this.mfa.exigidoPara(user.papel, user.gestor)) return true;
    if (user.mfaHabilitado) return true;

    throw new ForbiddenException({
      message:
        'Este ambiente exige verificação em duas etapas para o seu perfil. ' +
        'Cadastre o segundo fator para continuar.',
      error: 'MFA_OBRIGATORIO',
    });
  }
}
