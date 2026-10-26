import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

import { ehEscopoCliente } from '../escopo-processos';
import type { UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * A rota é da OPERAÇÃO, não de um escritório assinante.
 *
 * ── O BURACO QUE ISTO FECHA (R-13 da auditoria LGPD) ──
 *
 * Algumas rotas operam sobre a base INTEIRA de titulares, por desenho: a
 * exclusão do art. 18 precisa alcançar todos os escritórios, e a trilha por CPF
 * responde "quem tocou o dado desta pessoa?" à ANPD. Elas estavam protegidas
 * apenas por `@Papeis('ADMIN')`.
 *
 * E `ADMIN` não é papel de operação: é coluna de `User`, e `User` pertence a uma
 * organização QUALQUER. A invariante "ADMIN só existe na org interna" é
 * convenção do código — as três portas de criação de conta nascem com papel
 * CLIENTE —, mas NADA no banco a impõe. Um ADMIN criado por script, seed ou
 * `UPDATE` dentro de uma organização cliente transformava essas rotas em leitura
 * (e exclusão) da base inteira.
 *
 * Este guard troca a convenção por regra: só passa quem está na organização
 * INTERNA. É o mesmo teste que decide o escopo da carteira
 * (`ehEscopoCliente`), então não há uma segunda definição de "quem é cliente"
 * para divergir na próxima mudança.
 *
 * ── POR QUE 403, E POR QUE ISTO NÃO QUEBRA NINGUÉM HOJE ──
 *
 * 403 e não 404: quem chega aqui está autenticado e tem papel ADMIN; o que
 * falta é pertencer à operação. Esconder a rota com 404 faria o operador
 * interno legítimo pensar que ela sumiu.
 *
 * E o alcance prático da mudança é zero: para existir um ADMIN fora da org
 * interna alguém teria de tê-lo criado por fora do produto. Se existir, esta
 * linha é justamente a que precisava existir.
 */
@Injectable()
export class OrganizacaoInternaGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const usuario = ctx.switchToHttp().getRequest().user as UsuarioAutenticado | undefined;
    /* Autenticação é problema de outro guard; sem usuário não há o que avaliar. */
    if (!usuario) return true;

    if (ehEscopoCliente(usuario)) {
      throw new ForbiddenException(
        'Esta rota opera sobre a base inteira de titulares e é restrita à operação interna.',
      );
    }
    return true;
  }
}
