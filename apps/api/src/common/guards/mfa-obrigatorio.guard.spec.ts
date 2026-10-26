import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { MfaObrigatorioGuard } from './mfa-obrigatorio.guard';
import { MfaService, type PoliticaMfa } from '../../modules/auth/application/mfa.service';
import { PUBLICO_KEY, SEM_MFA_KEY, type UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * A política de MFA, caso a caso.
 *
 * ── POR QUE ESTE ARQUIVO NÃO EXISTIA, E POR QUE PASSA A EXISTIR ──
 *
 * O guard nasceu junto com `MFA_OBRIGATORIO=nenhum`, e com `nenhum` ele sai na
 * primeira linha: nada do que vem depois rodou em produção um dia sequer. Virar
 * a chave para `todos` é ligar código nunca exercitado fora de teste — e não
 * havia teste. O que ele decide é quem entra e quem fica na porta; errar para
 * um lado tranca gente, errar para o outro deixa a política de enfeite.
 *
 * O `MfaService` é o REAL, com só a configuração falsa: `politica()` e
 * `exigidoPara()` só leem config, e é justamente a lógica deles que o guard
 * consome. Um dublê do serviço aqui provaria que o dublê concorda consigo mesmo.
 */
function guardCom(politica: PoliticaMfa, marcas: Partial<Record<string, boolean>> = {}) {
  const reflector = {
    chamadas: 0,
    getAllAndOverride(chave: string) {
      this.chamadas++;
      return marcas[chave] ?? false;
    },
  };
  const config = { get: (k: string) => (k === 'MFA_OBRIGATORIO' ? politica : undefined) };
  const mfa = new MfaService({} as never, config as never);
  return { guard: new MfaObrigatorioGuard(reflector as unknown as Reflector, mfa), reflector };
}

function contexto(user?: UsuarioAutenticado): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as never;
}

function usuario(extra: Partial<UsuarioAutenticado> = {}): UsuarioAutenticado {
  return {
    id: 'u1',
    email: 'u@teste.local',
    papel: 'CLIENTE',
    organizationId: 'o1',
    tipo: 'CLIENTE',
    gestor: false,
    mfaHabilitado: false,
    emailConfirmado: true,
    ...extra,
  };
}

/** O que o front inspeciona: o CÓDIGO, nunca o texto. */
function codigoDoErro(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(ForbiddenException);
    const corpo = (e as ForbiddenException).getResponse() as { error?: string };
    return corpo.error;
  }
}

describe('MfaObrigatorioGuard', () => {
  it('`nenhum` passa SEM consultar metadado nenhum — o custo zero que o comentário promete', () => {
    const { guard, reflector } = guardCom('nenhum');
    expect(guard.canActivate(contexto(usuario()))).toBe(true);
    expect(reflector.chamadas).toBe(0);
  });

  describe('`todos`', () => {
    it('quem não tem MFA recebe 403 com o código que o front redireciona', () => {
      const { guard } = guardCom('todos');
      expect(codigoDoErro(() => guard.canActivate(contexto(usuario())))).toBe('MFA_OBRIGATORIO');
    });

    it('quem tem MFA passa', () => {
      const { guard } = guardCom('todos');
      expect(guard.canActivate(contexto(usuario({ mfaHabilitado: true })))).toBe(true);
    });

    it('alcança TODO papel — CLIENTE, OPERADOR e ADMIN, gestor ou não', () => {
      const { guard } = guardCom('todos');
      for (const u of [
        usuario({ papel: 'CLIENTE', gestor: false }),
        usuario({ papel: 'CLIENTE', gestor: true }),
        usuario({ papel: 'OPERADOR' }),
        usuario({ papel: 'ADMIN', tipo: 'INTERNA' }),
      ]) {
        expect(codigoDoErro(() => guard.canActivate(contexto(u)))).toBe('MFA_OBRIGATORIO');
      }
    });

    it('rota @SemMfa passa mesmo sem MFA — é por ela que a pessoa cumpre a exigência', () => {
      /* Sem esta isenção a política trancaria a porta pelo lado de dentro:
         a tela de cadastro precisa de /auth/eu, /auth/mfa, cadastrar e confirmar. */
      const { guard } = guardCom('todos', { [SEM_MFA_KEY]: true });
      expect(guard.canActivate(contexto(usuario()))).toBe(true);
    });

    it('rota @Publico passa — login, refresh e logout não podem depender de MFA', () => {
      const { guard } = guardCom('todos', { [PUBLICO_KEY]: true });
      expect(guard.canActivate(contexto(usuario()))).toBe(true);
    });

    it('sem usuário na requisição, a decisão não é deste guard', () => {
      /* Ou o JwtAuthGuard já recusou, ou a rota é pública. Recusar aqui de novo
         só trocaria um 401 correto por um 403 enganoso. */
      const { guard } = guardCom('todos');
      expect(guard.canActivate(contexto(undefined))).toBe(true);
    });
  });

  describe('`admin` — quem manda', () => {
    it('CLIENTE comum sem MFA passa: a política não o alcança', () => {
      const { guard } = guardCom('admin');
      expect(guard.canActivate(contexto(usuario({ papel: 'CLIENTE', gestor: false })))).toBe(true);
    });

    it('gestor de escritório sem MFA é barrado: comanda os acessos de uma organização', () => {
      const { guard } = guardCom('admin');
      expect(codigoDoErro(() => guard.canActivate(contexto(usuario({ gestor: true }))))).toBe(
        'MFA_OBRIGATORIO',
      );
    });

    it('ADMIN sem MFA é barrado: enxerga a base inteira', () => {
      const { guard } = guardCom('admin');
      expect(
        codigoDoErro(() => guard.canActivate(contexto(usuario({ papel: 'ADMIN', tipo: 'INTERNA' })))),
      ).toBe('MFA_OBRIGATORIO');
    });
  });
});
