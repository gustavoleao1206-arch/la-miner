import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { EnriquecimentoModule } from '../enriquecimento/enriquecimento.module';
import { EnriquecimentoProcessor } from './enriquecimento.processor';
import { FilaService } from './fila.service';
import { FILA_ENRIQUECIMENTO, FILA_IMPORTACAO } from './fila.constants';
import { FilaController } from './fila.controller';
import { SincronizacaoAgendada } from './sincronizacao.agendada';
import { ehWorker } from '../../config/papel-do-processo';

export { FILA_ENRIQUECIMENTO, FILA_IMPORTACAO };

/**
 * Abrir conexão com o Redis já na carga do módulo torna o Redis dependência de
 * QUALQUER coisa que suba a aplicação — inclusive os testes de controller, que
 * não têm nada a ver com fila. E aqui o Redis roda em Docker/WSL, longe do
 * alcance de um `jest`: a suíte quebraria por infraestrutura ausente, não por
 * regressão. Em `NODE_ENV=test`, a fila é substituída por um duplo e nenhuma
 * conexão é aberta.
 *
 * NÃO é atalho de teste que enfraquece a cobertura: o comportamento da FILA
 * (enfileirar, prever, consumir) tem seus próprios testes; o que se troca aqui é
 * só o TRANSPORTE, que em produção é BullMQ e nos testes é um objeto em memória.
 */
const MODO_TESTE = process.env.NODE_ENV === 'test';

/**
 * Só quem tem papel de worker CONSOME a fila.
 *
 * A API continua PRODUZINDO (a importação enfileira), o que exige a conexão do
 * BullMQ — mas não registra o processador. Sem esta separação, cada instância
 * da API viraria um consumidor a mais disputando os mesmos jobs, e um deploy
 * mataria a consulta paga que estava no ar.
 */
const CONSOME_FILA = !MODO_TESTE && ehWorker();

/* Um duplo mínimo com a interface de Queue que o FilaService toca. Em teste,
   ninguém consome — os jobs só não são despachados para lugar nenhum. */
const filaEmMemoria = () => ({
  add: async () => ({ id: 'test' }),
  addBulk: async (jobs: unknown[]) => jobs.map((_, i) => ({ id: `test-${i}` })),
  getJobCounts: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
  getFailed: async () => [],
  close: async () => undefined,
});

@Module({
  imports: [
    ConfigModule,
    EnriquecimentoModule,
    /* Sem `...spread` de array condicional: em teste, `imports` fica vazio e
       nenhum provider do BullMQ entra na injeção. */
    ...(MODO_TESTE
      ? []
      : [
          BullModule.forRootAsync({
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
              connection: {
                host: config.get<string>('REDIS_HOST', 'localhost'),
                port: config.get<number>('REDIS_PORT', 6379),
                password: config.get<string>('REDIS_PASSWORD') || undefined,
                // BullMQ exige null: com retry finito o worker morre em queda de rede.
                maxRetriesPerRequest: null,
              },
              defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 5_000 },
                removeOnComplete: { age: 86_400, count: 5_000 },
                removeOnFail: { age: 604_800 }, // 7 dias para inspecionar falhas
              },
            }),
          }),
          BullModule.registerQueue({ name: FILA_ENRIQUECIMENTO }),
          /* A fila da importação é registrada AQUI, junto da outra, mesmo com o
             processador morando no módulo de importação: o `registerQueue` só
             precisa existir onde o Queue é INJETADO, e quem injeta é o
             FilaService — que centraliza o teto de tempo do Redis. */
          BullModule.registerQueue({ name: FILA_IMPORTACAO }),
        ]),
  ],
  controllers: [FilaController],
  providers: [
    FilaService,
    /* `SincronizacaoAgendada` fica SEMPRE: o FilaController o injeta, e ele só
       depende de Prisma, config e do provider — nada de Redis. É o cron que não
       dispara em teste (o ScheduleModule não roda), mas a classe existe.

       Só o `EnriquecimentoProcessor` sai em teste: ele estende WorkerHost do
       BullMQ e ABRE conexão com o Redis para consumir a fila. No lugar dele, um
       duplo ocupa o token do Queue para o FilaService continuar injetável. */
    SincronizacaoAgendada,
    ...(MODO_TESTE
      ? [
          { provide: `BullQueue_${FILA_ENRIQUECIMENTO}`, useValue: filaEmMemoria() },
          { provide: `BullQueue_${FILA_IMPORTACAO}`, useValue: filaEmMemoria() },
        ]
      : []),
    /* O processador entra SÓ no papel de worker. A API segue produzindo na
       fila (a importação enfileira) — o que ela não faz mais é consumir. */
    ...(CONSOME_FILA ? [EnriquecimentoProcessor] : []),
  ],
  exports: [FilaService, SincronizacaoAgendada, ...(MODO_TESTE ? [] : [BullModule])],
})
export class FilaModule {}
