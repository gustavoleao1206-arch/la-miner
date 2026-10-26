import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { CONCORRENCIA_IMPORTACAO, FILA_IMPORTACAO } from '../fila/fila.constants';
import type { JobImportarPlanilha } from '../fila/fila.service';
import { ImportacaoService } from './importacao.service';

/**
 * Quem processa a planilha, longe da requisição HTTP.
 *
 * ── ESTA CLASSE É FINA DE PROPÓSITO ──
 *
 * Toda a lógica está no `ImportacaoService`, e não aqui, por dois motivos. O
 * primeiro é teste: o serviço roda direto na suíte de integração, sem Redis e
 * sem BullMQ, o que mantém os dezessete testes da carteira exercitando o
 * caminho REAL de gravação. O segundo é que a mesma lógica atende dois
 * chamadores — o job e o script de medição —, e duplicá-la faria os dois
 * medirem coisas diferentes.
 *
 * ── CONCORRÊNCIA 1 ──
 *
 * Ver a nota em `fila.constants.ts`: não é economia de recurso, é correção.
 * Duas importações simultâneas fazem read-modify-write sobre as mesmas linhas
 * de `processos`.
 *
 * ── O QUE ACONTECE QUANDO ISTO FALHA ──
 *
 * O erro SOBE, e o BullMQ retenta (3 tentativas, backoff exponencial). É
 * seguro porque `processarImportacao` só lê linhas em PENDENTE: a retentativa
 * continua de onde parou em vez de reprocessar o que já entrou. O mesmo
 * mecanismo cobre o worker morto no meio — o job travado volta sozinho.
 *
 * O que NÃO deve subir daqui são as falhas que retentativa não resolve
 * (importação apagada, perfil removido); o serviço as encerra marcando FALHOU
 * e devolve normalmente, para não queimar as três tentativas contra um erro
 * permanente.
 */
@Processor(FILA_IMPORTACAO, { concurrency: CONCORRENCIA_IMPORTACAO })
export class ImportacaoProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportacaoProcessor.name);

  constructor(private readonly servico: ImportacaoService) {
    super();
  }

  async process(job: Job<JobImportarPlanilha>): Promise<void> {
    const { importacaoId } = job.data;
    this.logger.log(`Processando importação ${importacaoId} (job ${job.id}).`);
    await this.servico.processarImportacao(importacaoId);
  }

  @OnWorkerEvent('failed')
  aoFalhar(job: Job<JobImportarPlanilha>, err: Error): void {
    this.logger.error(
      `Importação ${job.data?.importacaoId} falhou (tentativa ${job.attemptsMade}): ${err.message}`,
    );
  }
}
