import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';

/** Lançado quando o teto diário é atingido. O job falha de forma visível
 *  em vez de continuar gastando crédito silenciosamente. */
export class TetoDiarioAtingidoError extends Error {
  constructor(usadas: number, teto: number) {
    super(`Teto diário de consultas atingido (${usadas}/${teto}). Nenhuma chamada será feita hoje.`);
    this.name = 'TetoDiarioAtingidoError';
  }
}

/**
 * Trava de consumo do provedor pago.
 *
 * Existe porque o scope da credencial é `ALL`: a Contactra não impõe limite,
 * então o limite tem que ser nosso. Sem isto, um laço com defeito ou uma
 * importação grande demais viram fatura.
 */
@Injectable()
export class TetoConsumoService {
  private readonly logger = new Logger(TetoConsumoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get teto(): number {
    return this.config.get<number>('CONTACTRA_TETO_DIARIO', 500);
  }

  private inicioDeHoje(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Quantas chamadas cobráveis já foram feitas hoje. */
  async usadasHoje(provider: string): Promise<number> {
    const uso = await this.prisma.apiUsage.findUnique({
      where: { provider_data: { provider, data: this.inicioDeHoje() } },
      select: { chamadas: true },
    });
    return uso?.chamadas ?? 0;
  }

  async restantesHoje(provider: string): Promise<number> {
    return Math.max(0, this.teto - (await this.usadasHoje(provider)));
  }

  /** Barra a execução se o teto já foi atingido. Chamar ANTES de tocar no provedor. */
  async garantirDisponibilidade(provider: string): Promise<void> {
    // Provider gratuito não consome nada — não faz sentido travar.
    if (provider === 'FAKE') return;

    const usadas = await this.usadasHoje(provider);
    if (usadas >= this.teto) {
      this.logger.warn(`Teto diário atingido para ${provider}: ${usadas}/${this.teto}`);
      throw new TetoDiarioAtingidoError(usadas, this.teto);
    }
  }

  async estado(provider: string) {
    const usadas = await this.usadasHoje(provider);
    return {
      provider,
      teto: this.teto,
      usadas,
      restantes: Math.max(0, this.teto - usadas),
      percentual: this.teto > 0 ? Math.round((usadas / this.teto) * 100) : 0,
    };
  }
}
