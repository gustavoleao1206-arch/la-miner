import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Papel } from '@miner/database';
import { PAPEIS_KEY, PUBLICO_KEY } from '../decorators/papeis.decorator';

/**
 * Autorização por papel.
 *
 * Ausência de @Papeis() = ROTA NEGADA. Toda rota declara @Papeis() ou @Publico().
 * ADMIN não recebe passe livre implícito: se a rota declara papéis,
 * ADMIN precisa constar na lista. Permissão implícita é como se criam
 * brechas silenciosas.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const exigidos = this.reflector.getAllAndOverride<Papel[] | undefined>(PAPEIS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    /* Rota pública é decisão explícita e escapa antes de tudo. */
    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publico) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('Não autenticado');

    /* NEGA por omissão.
       Antes isto era `return true`: rota autenticada sem @Papeis ficava aberta a
       qualquer papel, e foi assim que /carteira/buscar expôs 3.974 documentos
       com contato a usuários CLIENTE. Um guard de autorização que libera quando
       não sabe o que exigir só protege quem lembrou de configurá-lo — ou seja,
       falha exatamente nos casos em que era necessário. Esquecer o decorator
       agora quebra a rota em desenvolvimento, não em produção. */
    if (!exigidos || exigidos.length === 0) {
      throw new ForbiddenException(
        'Rota sem papéis declarados. Adicione @Papeis(...) ou @Publico() explicitamente.',
      );
    }

    if (!exigidos.includes(user.papel)) {
      throw new ForbiddenException(
        `Acesso negado. Requer papel: ${exigidos.join(' ou ')}. Seu papel: ${user.papel}.`,
      );
    }
    return true;
  }
}
