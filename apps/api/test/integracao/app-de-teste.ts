import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { INestApplication } from '@nestjs/common';
import type { Papel } from '@miner/database';

import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/configurar-app';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prisma } from './ambiente';

/**
 * Sobe a aplicação REAL para os testes de controller.
 *
 * UMA substituição só: `PrismaService` aponta para o banco de teste. É o mesmo
 * client que os testes de service usam, então as fixtures criadas fora do HTTP
 * aparecem dentro dele.
 *
 * A fila NÃO é substituída aqui: o `FilaModule` já detecta `NODE_ENV=test` e usa
 * um Queue em memória, sem abrir conexão com o Redis (que nesta máquina roda em
 * Docker/WSL, fora do alcance do jest). Assim o `FilaService` real é exercitado,
 * só o transporte é que muda.
 *
 * TUDO o mais é o de produção: os guards globais (JwtAuthGuard e RolesGuard), o
 * ValidationPipe com `forbidNonWhitelisted`, o filtro de exceção, o prefixo e o
 * versionamento — via `configurarApp`, a MESMA função que o `main.ts` chama.
 */
export async function criarAppDeTeste(): Promise<{
  app: INestApplication;
  base: string;
  tokenPara: (userId: string) => Promise<string>;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    /**
     * Rate limit desligado NESTE app — pelo ARMAZENAMENTO, não pelo guard.
     *
     * Havia aqui um `overrideGuard(ThrottlerGuard)` que não desligava nada:
     * guard registrado via `APP_GUARD` não é alcançado por `overrideGuard`, que
     * atua sobre `@UseGuards`. O comentário afirmava a desativação e o código
     * não a entregava — descoberto quando a correção do `@Throttle` fez o teste
     * de bloqueio de conta receber 429 em vez de 403.
     *
     * `ThrottlerStorage` é um provider comum, e esse o DI substitui de verdade.
     * Um contador que nunca acumula deixa cada caso independente da ORDEM de
     * execução — o contador é por IP, e a suíte inteira sai de 127.0.0.1.
     *
     * (Zerar o Map do serviço real entre os testes NÃO funciona: ele mantém
     * timers que depois leem entradas removidas e quebram com "Cannot
     * destructure property 'totalHits' of undefined".)
     *
     * Isto não afrouxa a cobertura: o teto real de 5/min tem suíte própria
     * (`throttle.int-spec.ts`), que sobe uma instância separada, SEM este
     * override, e afere o 429 de verdade.
     */
    .overrideProvider(ThrottlerStorage)
    .useValue({
      /* O tipo `ThrottlerStorageRecord` não é reexportado no índice do pacote —
         só o símbolo `ThrottlerStorage`. Os quatro campos abaixo SÃO o
         contrato; deixar o tipo inferir evita um import de caminho interno. */
      increment: async () => ({
        totalHits: 1, // sempre abaixo de qualquer limite
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication();
  const prefixo = configurarApp(app);
  await app.init();

  const jwt = app.get(JwtService);
  const config = app.get(ConfigService);
  const segredo = config.getOrThrow<string>('JWT_ACCESS_SECRET');

  return {
    app,
    /* As rotas vivem em /<prefixo>/v1/... por causa do versionamento por URI.
       Montar a URL a partir da config evita testes que passam com o prefixo
       errado por terem sido escritos com o caminho na mão. */
    base: `/${prefixo}/v1`,
    /**
     * Token de acesso válido para um usuário do banco de teste.
     *
     * Assinado com o MESMO segredo da aplicação, porque o objetivo é exercitar
     * o guard de verdade. O papel não vai no token de propósito: a strategy
     * relê do banco a cada requisição — é assim que um usuário desativado ou
     * rebaixado perde acesso antes de o token expirar.
     */
    tokenPara: (userId: string) =>
      jwt.signAsync({ sub: userId }, { secret: segredo, expiresIn: '15m' }),
  };
}

/** Cria um usuário com o papel pedido, na organização dada. */
export async function criarUsuario(organizationId: string, papel: Papel, sufixo = '') {
  return prisma.user.create({
    data: {
      organizationId,
      email: `${papel.toLowerCase()}${sufixo}${Date.now()}@teste.local`,
      nome: `Usuário ${papel}`,
      papel,
      senhaHash: 'nao-e-um-hash-valido',
    },
    select: { id: true, papel: true, organizationId: true },
  });
}
