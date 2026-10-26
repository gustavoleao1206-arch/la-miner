import request from 'supertest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/configurar-app';
import { PrismaService } from '../../src/prisma/prisma.service';
import { prisma, limparDados, encerrar } from './ambiente';

/**
 * O rate limit do login, exercitado de verdade.
 *
 * ⚠ App PRÓPRIA, sem o `overrideGuard(ThrottlerGuard)` do `app-de-teste.ts`.
 * Lá o throttler é desligado de propósito — o contador é por IP e todos os
 * testes vêm de 127.0.0.1, então o limite estouraria entre um caso e outro e o
 * resultado dependeria da ORDEM de execução. Aqui a instância é exclusiva, com
 * armazenamento em memória próprio, então o contador nasce zerado.
 *
 * Este arquivo existe por causa de um achado da auditoria: o decorator dizia
 * `@Throttle({ default: ... })` enquanto os throttlers registrados se chamam
 * `curto` e `medio`. O nome inexistente virava metadado morto — o login aceitava
 * os 120/min do limite global em vez de 5/min, e NADA denunciava isso: o código
 * parecia certo, o comentário afirmava a proteção, e a suíte passava.
 *
 * O teto subiu de 5 para 15/min quando o produto passou a vender 5 perfis por
 * escritório: o balde é por IP, um escritório atrás de NAT sai por um IP só, e
 * cinco colegas entrando às 9h davam 429 no uso NORMAL.
 *
 * É a lição que a auditoria resumiu melhor do que eu: toda proteção afirmada em
 * comentário precisa de um teste que a exerça, ou vira falsa confiança.
 */
describe('Rate limit — o login tem teto real', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    base = `/${configurarApp(app)}/v1`;
    await app.init();
    await limparDados();
  });

  afterAll(async () => {
    await app.close();
    await encerrar();
  });

  /**
   * E-mail INEXISTENTE de propósito.
   *
   * Com um usuário real, a trava de conta (5 tentativas → bloqueio de 15 min,
   * `auth.service.ts`) responderia 403 antes de o throttler agir, e o teste
   * mediria a defesa errada. As duas são independentes: uma protege a CONTA,
   * outra protege o SERVIÇO. Aqui o alvo é a segunda.
   */
  it('a 16ª tentativa de login no mesmo minuto recebe 429', async () => {
    const tentar = () =>
      request(app.getHttpServer())
        .post(`${base}/auth/login`)
        .send({ email: 'ninguem@inexistente.local', senha: 'SenhaQualquer#123' });

    const codigos: number[] = [];
    for (let i = 0; i < 16; i++) {
      codigos.push((await tentar()).status);
      /* ── O ESPAÇAMENTO NÃO É ENFEITE ──
         São DOIS baldes: `curto` (10/s) e `medio` (15/min). Disparadas em
         rajada, as tentativas estourariam o `curto` na 11ª, e o teste passaria
         medindo a proteção ERRADA — continuaria verde mesmo se o teto por
         minuto voltasse a ser metadado morto, que é exatamente o defeito que
         este arquivo existe para pegar.
         Medido nesta máquina: com 60ms de espaçamento a 11ª ainda tomava 429
         (o argon2 falso é mais barato do que eu supus, e as dez primeiras
         cabiam na mesma janela de 1s). Com 200ms a cadência fica em ~4/s,
         menos da metade do `curto`. */
      await new Promise((r) => setTimeout(r, 200));
    }

    /* As quinze primeiras chegam ao serviço e falham nas credenciais — nenhum
       429 antes da hora prova que quem cortou foi o teto por MINUTO. */
    expect(codigos.slice(0, 15)).toEqual(Array(15).fill(401));
    /* A décima sexta nem chega: o guard corta antes. */
    expect(codigos[15]).toBe(429);
  });

  /**
   * O limite é POR ROTA, não um balde único do app: estourar o login não pode
   * derrubar o resto da API.
   */
  it('o teto do login não consome o das outras rotas', async () => {
    const r = await request(app.getHttpServer()).get(`${base}/carteira/resumo`);
    /* 401 (sem token), e não 429 — a rota ainda responde. */
    expect(r.status).toBe(401);
  });
});
