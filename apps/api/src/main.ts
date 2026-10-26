import 'reflect-metadata';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { configurarApp } from './configurar-app';
import { conferirSombraEnv } from './config/conferir-sombra-env';

async function bootstrap(): Promise<void> {
  /* `rawBody` para o webhook de cobrança. Assinatura de webhook se confere sobre
     os BYTES recebidos: re-serializar o JSON muda ordem de chaves e espaçamento,
     e a checagem passaria a falhar (ou, pior, a ser escrita de um jeito que
     sempre passa). Sem isso, um adaptador de gateway não tem como ser correto. */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  /* DEPOIS do create, e não antes: só com os módulos carregados o `process.env`
     está no estado final — é o import do client do Prisma, lá dentro, que já
     causou uma sombra silenciosa sobre o .env da raiz. Fica aqui, e não no
     `configurar-app.ts`, porque os testes de integração sobrescrevem a
     DATABASE_URL de propósito e não devem esbarrar nesta trava. */
  conferirSombraEnv(join(__dirname, '..', '..', '..', '.env'));
  const config = app.get(ConfigService);
  const logger = app.get(PinoLogger);
  app.useLogger(logger);

  /* `PORT` primeiro, e vindo do ambiente cru: é a variável que a Render injeta,
     e ela não passa pelo schema do zod — só `API_PORT` passa. Ler apenas
     `API_PORT` fazia a API escutar na 3333 enquanto a plataforma procurava
     porta aberta em outro lugar, e o deploy travava em "no open ports detected"
     sem um único erro no log da aplicação: ela subia perfeitamente, no lugar
     errado. Local nada muda — sem `PORT` definida, cai no `API_PORT` de sempre. */
  const porta = Number(process.env.PORT) || config.get<number>('API_PORT', 3333);
  const producao = config.get<string>('NODE_ENV') === 'production';

  /* Prefixo, versionamento, helmet, CORS e ValidationPipe. Compartilhado com os
     testes de controller — ver configurar-app.ts. */
  const prefixo = configurarApp(app);

  app.enableShutdownHooks();

  /* Swagger fica fora do ar em produção. O `??` é o que faz o default valer:
     `SWAGGER_ENABLED` é OPCIONAL no schema justamente para chegar aqui como
     `undefined` quando ninguém a definiu — com um default no zod, o
     ConfigService devolvia o valor validado e este fallback nunca era usado. */
  if (config.get<boolean | undefined>('SWAGGER_ENABLED') ?? !producao) {
    const doc = new DocumentBuilder()
      .setTitle('Leão Amorim Miner — API')
      /* Descrição neutra: a anterior citava o "provider de enriquecimento", e o
         requisito de produto é que o cliente não saiba que essa engrenagem
         existe. Documentação também é superfície de vazamento. */
      .setDescription('Sistema de Inteligência de Precatórios — API interna.')
      .setVersion('0.1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'jwt')
      .build();
    SwaggerModule.setup(`${prefixo}/docs`, app, SwaggerModule.createDocument(app, doc), {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  await app.listen(porta, '0.0.0.0');
  logger.log(`API em http://localhost:${porta}/${prefixo}`);
  if (!producao) logger.log(`Swagger em http://localhost:${porta}/${prefixo}/docs`);
}

/* O `.catch` não é zelo: sem ele, qualquer falha de boot — validação de
   ambiente, providers, `$connect()` do Prisma — vira unhandled rejection, e o
   log da plataforma mostra a stack do Node em vez da causa. Custou um ciclo de
   deploy inteiro descobrir que o erro era do FakeProvider e não do que a stack
   sugeria. `process.exit(1)` é explícito para a plataforma marcar o deploy como
   falho em vez de reiniciar em laço. */
void bootstrap().catch((e) => {
  console.error('BOOT FALHOU:', e);
  process.exit(1);
});
