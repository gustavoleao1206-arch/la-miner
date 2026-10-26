import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Papel, TipoOrganizacao } from '@miner/database';

export const PAPEIS_KEY = 'papeis';

/** Restringe a rota aos papéis informados. Ex.: @Papeis('ADMIN', 'OPERADOR') */
export const Papeis = (...papeis: Papel[]) => SetMetadata(PAPEIS_KEY, papeis);

export const PUBLICO_KEY = 'publico';

/** Marca a rota como pública (sem JWT). Use com parcimônia. */
export const Publico = () => SetMetadata(PUBLICO_KEY, true);

export interface UsuarioAutenticado {
  id: string;
  email: string;
  papel: Papel;
  organizationId: string;
  /// Tipo da ORGANIZAÇÃO do usuário — o que decide o escopo de leitura da
  /// carteira (INTERNA vê o que possui; CLIENTE vê só o que lhe foi liberado).
  /// Resolvido no jwt.strategy, que já revalida o usuário no banco a cada request.
  tipo: TipoOrganizacao;
  /// Administra a própria organização. Vem do banco a cada request, como o
  /// `tipo`: revogar a gestão de alguém vale no request seguinte, sem esperar o
  /// access token de 15 min expirar.
  gestor: boolean;
  /// Segundo fator CONFIRMADO. Vem da mesma consulta da strategy, e é o que o
  /// MfaObrigatorioGuard lê — sem consulta extra por requisição.
  mfaHabilitado: boolean;
  /// E-mail do cadastro CONFIRMADO. Mesma consulta, mesmo custo zero — é o que
  /// o EmailConfirmadoGuard lê. Convidados pela equipe e contas anteriores à
  /// funcionalidade nascem confirmados.
  emailConfirmado: boolean;
}

export const SEM_MFA_KEY = 'sem-mfa';

/**
 * Isenta a rota da exigência de segundo fator.
 *
 * Existe para uma única situação, e ela é obrigatória: quando a política manda
 * cadastrar MFA, o usuário precisa alcançar as rotas DE CADASTRO estando ainda
 * sem MFA. Sem esta isenção, a política seria uma porta trancada por dentro —
 * ninguém conseguiria cumpri-la.
 */
export const SemMfa = () => SetMetadata(SEM_MFA_KEY, true);

/** Injeta o usuário autenticado no handler: `@UsuarioAtual() usuario: UsuarioAutenticado` */
export const UsuarioAtual = createParamDecorator(
  (campo: keyof UsuarioAutenticado | undefined, ctx: ExecutionContext) => {
    const { user } = ctx.switchToHttp().getRequest();
    return campo ? user?.[campo] : user;
  },
);
