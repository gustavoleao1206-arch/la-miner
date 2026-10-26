import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { AssinaturaAtivaGuard } from './assinatura-ativa.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * O guard virou fronteira de verdade quando a landing entrou no ar.
 *
 * Enquanto toda organização nascia por script, PENDENTE durava minutos e
 * deixá-lo passar não tinha consequência. Com cadastro público, PENDENTE é
 * "não pagou" — e o produto foi vendido como pagar-primeiro-depois-acessar.
 * Este arquivo é o que impede alguém de reverter isso por engano seis meses
 * adiante: a linha que voltaria a liberar o não pagante fica vermelha aqui.
 *
 * A tabela de estados abaixo é a especificação inteira do guard. Se um estado
 * novo entrar no enum e ninguém decidir o que ele faz, o `it.each` não o cobre
 * — e é por isso que o teste de contagem existe no fim.
 */

function contextoDe(usuario: UsuarioAutenticado | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: usuario }) }),
  } as unknown as ExecutionContext;
}

function guardCom(status: string | null) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(status === null ? null : { status });
  const prisma = { assinatura: { findUnique } } as unknown as PrismaService;
  return { guard: new AssinaturaAtivaGuard(prisma), findUnique };
}

const CLIENTE: UsuarioAutenticado = {
  id: 'u-1',
  email: 'cliente@escritorio.com.br',
  papel: 'CLIENTE',
  organizationId: 'org-cliente',
} as UsuarioAutenticado;

const OPERADOR_INTERNO: UsuarioAutenticado = {
  id: 'u-2',
  email: 'equipe@exemplo.com.br',
  papel: 'OPERADOR',
  organizationId: 'org-interna',
} as UsuarioAutenticado;

/** Extrai o corpo do 402 sem depender de o Nest ter formatado a exceção. */
async function capturar402(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error('esperava HttpException, não veio nenhuma');
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return { status: e.getStatus(), corpo: e.getResponse() as Record<string, unknown> };
  }
}

describe('AssinaturaAtivaGuard', () => {
  describe('barra quem não pode entrar', () => {
    it('PENDENTE → 402 com motivo PAGAMENTO_PENDENTE', async () => {
      /* O caso que a Etapa 2 criou. Antes desta mudança, PENDENTE passava e o
         recém-cadastrado entrava num painel vazio sem saber por quê. */
      const { guard } = guardCom('PENDENTE');

      const { status, corpo } = await capturar402(() => guard.canActivate(contextoDe(CLIENTE)));

      expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(corpo.motivo).toBe('PAGAMENTO_PENDENTE');
    });

    it.each(['SUSPENSA', 'CANCELADA'])('%s → 402 com motivo ASSINATURA_INATIVA', async (st) => {
      const { guard } = guardCom(st);

      const { status, corpo } = await capturar402(() => guard.canActivate(contextoDe(CLIENTE)));

      expect(status).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(corpo.motivo).toBe('ASSINATURA_INATIVA');
    });

    it('separa os dois motivos — a tela oferece ações diferentes', async () => {
      /* Quem nunca pagou precisa TERMINAR o checkout; quem foi suspenso precisa
         REGULARIZAR uma fatura existente. Um motivo só mandaria metade dos
         clientes procurar um botão que não serve para eles. */
      const pendente = await capturar402(() =>
        guardCom('PENDENTE').guard.canActivate(contextoDe(CLIENTE)),
      );
      const suspensa = await capturar402(() =>
        guardCom('SUSPENSA').guard.canActivate(contextoDe(CLIENTE)),
      );

      expect(pendente.corpo.motivo).not.toBe(suspensa.corpo.motivo);
    });

    it('mantém `message` legível — a chave que o front já lia', async () => {
      /* A mudança acrescentou `motivo`; tirar `message` do lugar quebraria
         silenciosamente qualquer tela que já exibisse a frase. */
      const { guard } = guardCom('PENDENTE');

      const { corpo } = await capturar402(() => guard.canActivate(contextoDe(CLIENTE)));

      expect(typeof corpo.message).toBe('string');
      expect(corpo.message as string).toMatch(/pagamento/i);
    });
  });

  describe('deixa passar quem pode', () => {
    it('ATIVA passa', async () => {
      const { guard } = guardCom('ATIVA');
      await expect(guard.canActivate(contextoDe(CLIENTE))).resolves.toBe(true);
    });

    it('INADIMPLENTE passa — é a carência, não a suspensão', async () => {
      /* Cortar aqui removeria os dias de tolerância que o
         `processarVencimentos` existe para conceder: o cliente perderia acesso
         no dia seguinte ao vencimento, antes de qualquer cobrança amigável. */
      const { guard } = guardCom('INADIMPLENTE');
      await expect(guard.canActivate(contextoDe(CLIENTE))).resolves.toBe(true);
    });

    it('SEM assinatura passa — quem responde por esse caso é o escopo', async () => {
      /* Deliberado, e documentado no guard: misturar "não é cliente" com "está
         devendo" produziria um 402 "regularize o pagamento" para o usuário
         legado de papel CLIENTE dentro da org interna. */
      const { guard } = guardCom(null);
      await expect(guard.canActivate(contextoDe(CLIENTE))).resolves.toBe(true);
    });

    it('usuário interno passa sem NEM CONSULTAR o banco', async () => {
      /* Não é só o resultado: é uma consulta por requisição em todo o tráfego
         da operação interna. Se alguém trocar a ordem das checagens, este
         teste acusa o custo antes de ele chegar em produção. */
      const { guard, findUnique } = guardCom('PENDENTE');

      await expect(guard.canActivate(contextoDe(OPERADOR_INTERNO))).resolves.toBe(true);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('requisição sem usuário passa — autenticação é problema de outro guard', async () => {
      const { guard, findUnique } = guardCom('PENDENTE');

      await expect(guard.canActivate(contextoDe(undefined))).resolves.toBe(true);
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  it('todo estado de assinatura tem decisão explícita', async () => {
    /* A rede contra o estado NOVO: se alguém acrescentar 'EM_TESTE' ao enum e
       esquecer do guard, ele cairá no `else` implícito e LIBERARÁ o acesso —
       falha aberta, o pior padrão possível para uma trava de pagamento.
       Este teste não impede a adição; ele obriga a lista abaixo a ser
       atualizada junto, o que põe a decisão na frente de quem revisa. */
    const DECIDIDOS = ['PENDENTE', 'ATIVA', 'INADIMPLENTE', 'SUSPENSA', 'CANCELADA'];

    const { StatusAssinatura } = await import('@miner/database');
    expect(Object.keys(StatusAssinatura).sort()).toEqual(DECIDIDOS.sort());
  });
});
