import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PUBLICO_KEY } from '../decorators/papeis.decorator';

/**
 * Guard global: TODA rota exige JWT por padrão.
 * Só escapa quem declarar @Publico() explicitamente.
 *
 * O padrão é fechado de propósito — esquecer de proteger uma rota nova
 * não deve virar vazamento de dados pessoais.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publico) return true;
    return super.canActivate(context);
  }
}
