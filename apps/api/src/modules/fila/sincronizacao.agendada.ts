import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { FilaService } from './fila.service';
import { TetoConsumoService } from '../enriquecimento/application/teto-consumo.service';
import {
  ENRICHMENT_PROVIDER,
  type EnrichmentProvider,
} from '../enriquecimento/domain/enrichment-provider.port';

/**
 * Sincronização automática agendada.
 *
 * Decisão de projeto: o cron consulta o TETO ANTES de enfileirar e só
 * enfileira o que cabe no orçamento do dia. Enfileirar mais do que o teto
 * criaria uma fila de jobs condenados a falhar na trava — barulho inútil
 * nos logs e nas métricas de falha.
 */
@Injectable()
export class SincronizacaoAgendada {
  private readonly logger = new Logger(SincronizacaoAgendada.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fila: FilaService,
    private readonly teto: TetoConsumoService,
    private readonly config: ConfigService,
    @Inject(ENRICHMENT_PROVIDER) private readonly provider: EnrichmentProvider,
  ) {}

  private get habilitado(): boolean {
    return this.config.get<string>('SYNC_AGENDADA_ATIVA', 'false') === 'true';
  }

  /** Todo dia às 03:00 — fora do horário comercial. */
  @Cron(process.env.SYNC_CRON ?? '0 3 * * *', { name: 'sincronizacao-diaria', timeZone: 'America/Recife' })
  async sincronizarDiariamente(): Promise<void> {
    if (!this.habilitado) {
      this.logger.debug('Sincronização agendada desativada (SYNC_AGENDADA_ATIVA != true)');
      return;
    }
    const porRodada = this.config.get<number>('SYNC_LIMITE_POR_RODADA', 100);
    await this.executar('cron-diario', porRodada);
  }

  /** Calcula o que ACONTECERIA, sem enfileirar nada. Base do botão de confirmação. */
  async prever(limite: number) {
    const restantes = await this.teto.restantesHoje(this.provider.nome);
    const elegiveis = await this.prisma.pessoa.count({ where: this.criterio() });
    const quantidade = Math.min(limite, restantes, elegiveis);
    const preco = this.config.get<number>('CONTACTRA_CUSTO_POR_CONSULTA', 0);

    let observacao: string | undefined;
    if (quantidade < limite) {
      observacao =
        restantes < limite
          ? `Limitado pelo teto diário (restam ${restantes}).`
          : `Só há ${elegiveis} pessoa(s) elegível(is).`;
    }

    return {
      quantidade,
      elegiveis,
      tetoRestante: restantes,
      custoEstimado: preco > 0 ? Number((quantidade * preco).toFixed(2)) : null,
      provider: this.provider.nome,
      dryRun: this.config.get<string>('SYNC_DRY_RUN', 'false') === 'true',
      observacao,
    };
  }

  /** Critério de elegibilidade — usado na previsão e na execução. */
  private criterio() {
    const dias = this.config.get<number>('SYNC_DIAS_RECONSULTA', 90);
    const limite = new Date();
    limite.setDate(limite.getDate() - dias);
    return {
      OR: [
        { statusEnriquecimento: 'PENDENTE' as const },
        { statusEnriquecimento: 'ERRO' as const },
        { statusEnriquecimento: 'SINCRONIZADO' as const, ultimaSincronizacao: { lt: limite } },
      ],
    };
  }

  /**
   * Executa uma rodada. Exposto para o botão "sincronizar agora" do painel.
   * @param origem rótulo para auditoria
   */
  async executar(origem: string, limite: number): Promise<{ enfileirados: number; motivo?: string }> {
    const restantes = await this.teto.restantesHoje(this.provider.nome);
    if (restantes <= 0) {
      this.logger.warn(`Rodada abortada: teto diário já consumido (${origem})`);
      return { enfileirados: 0, motivo: 'teto diário já consumido' };
    }

    // Enfileira o MENOR entre o autorizado e o que cabe no teto.
    // Enfileirar além do teto só criaria jobs condenados a falhar na trava.
    const quantidade = Math.min(limite, restantes);

    const pessoas = await this.prisma.pessoa.findMany({
      where: this.criterio(),
      /* Só o id: desde que o job deixou de carregar CPF, ler o CPF aqui seria
         trazer dado pessoal para a memória do processo sem uso nenhum. */
      select: { id: true },
      take: quantidade,
      orderBy: [{ ultimaSincronizacao: { sort: 'asc', nulls: 'first' } }, { criadoEm: 'asc' }],
    });

    if (pessoas.length === 0) {
      this.logger.log(`Nada a sincronizar (${origem})`);
      return { enfileirados: 0, motivo: 'nenhuma pessoa pendente ou desatualizada' };
    }

    const r = await this.fila.enfileirarLote(
      pessoas.map((p) => ({ pessoaId: p.id })),
      origem,
    );
    this.logger.log(
      `Sincronização (${origem}): ${r.enfileirados} enfileirados · autorizado ${limite} · teto restante ${restantes}`,
    );
    return r;
  }

}
