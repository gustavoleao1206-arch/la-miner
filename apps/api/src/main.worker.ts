import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { papelDoProcesso } from './config/papel-do-processo';

/**
 * O processo que consome a fila e dispara os crons.
 *
 * ── `createApplicationContext`, E NÃO `create` ──
 *
 * O worker não serve HTTP. `createApplicationContext` monta a mesma árvore de
 * providers sem abrir porta nem mapear rota — então o worker NÃO tem superfície
 * de rede: nada para escanear, nada para atacar, nenhum guard para revisar.
 *
 * O AppModule é o MESMO da API de propósito. Duas árvores divergem — alguém
 * acrescenta um provider numa e esquece a outra, e o worker roda com metade da
 * configuração. O que muda entre os dois é apenas O QUE cada papel registra,
 * decidido em `papel-do-processo.ts`.
 *
 * ── DESLIGAMENTO ORDENADO ──
 *
 * `enableShutdownHooks` é o que faz o BullMQ terminar o job em voo antes de o
 * processo morrer. Sem isso, cada deploy interromperia uma consulta paga no
 * meio — e retentativa de consulta paga é dinheiro.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });

  const logger = app.get(PinoLogger);
  app.useLogger(logger);
  app.enableShutdownHooks();

  logger.log(
    `Worker no ar (papel=${papelDoProcesso()}): consumindo a fila de enriquecimento ` +
      'e disparando os crons. Sem porta HTTP.',
  );

  /* Não há `listen` para segurar o processo vivo: o que o mantém rodando é a
     conexão do worker do BullMQ com o Redis. Se ela cair de vez, o processo
     encerra — e a plataforma o reinicia, que é o comportamento desejado. */
}

/* Mesmo motivo do main.ts: sem `.catch`, a falha de boot sai como unhandled
   rejection e esconde a causa. Aqui é ainda mais importante — o worker não tem
   `listen`, então já é um processo silencioso por natureza. */
void bootstrap().catch((e) => {
  console.error('BOOT DO WORKER FALHOU:', e);
  process.exit(1);
});
