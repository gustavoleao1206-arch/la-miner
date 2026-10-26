import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Política de retenção do dado bruto do provedor.
 *
 * ── O PROBLEMA ──
 *
 * Cada consulta de enriquecimento guarda em `Enriquecimento.dadosBrutos` a
 * resposta CRUA do provedor: telefones, e-mails, endereços — e tudo o mais que
 * ele resolveu mandar, inclusive campos que nunca usamos. Isso ficava para
 * sempre.
 *
 * São duas consequências, e a segunda é a que assusta:
 *  1. guardamos mais dado pessoal do que precisamos, o que a LGPD chama de
 *     falta de minimização (art. 6º, III);
 *  2. o que interessa já foi EXTRAÍDO para telefones/emails/enderecos na hora
 *     da consulta. O payload é cópia — e cópia esquecida é a que vaza.
 *
 * ── O QUE ESTE CRON FAZ, E O QUE NÃO FAZ ──
 *
 * Apaga o CONTEÚDO (`dadosBrutos = NULL`) das consultas mais velhas que o
 * prazo. NÃO apaga a linha: ela é o registro de que consultamos aquele CPF,
 * quando, a que custo e com que resultado — é o que responde à ANPD e o que
 * sustenta a conferência da fatura do provedor.
 *
 * Reter o FATO e descartar o CONTEÚDO é a forma de atender minimização sem
 * destruir a própria capacidade de prestar contas.
 */
@Injectable()
export class RetencaoAgendada {
  private readonly logger = new Logger(RetencaoAgendada.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Dias que a resposta crua sobrevive. 0 desliga a limpeza. */
  private get dias(): number {
    return this.config.get<number>('RETENCAO_DADOS_BRUTOS_DIAS', 180);
  }

  /* 4h da manhã, depois da sincronização das 3h: limpar antes faria a limpeza
     rodar sobre um retrato desatualizado e sobrar o que acabou de entrar. */
  @Cron('0 4 * * *', { name: 'retencao-dados-brutos', timeZone: 'America/Recife' })
  async limparDiariamente(): Promise<void> {
    await this.executar('cron');
  }

  async executar(origem: string): Promise<{ limpos: number; motivo?: string }> {
    const dias = this.dias;
    if (dias <= 0) {
      return { limpos: 0, motivo: 'retenção desligada (RETENCAO_DADOS_BRUTOS_DIAS=0)' };
    }

    const corte = new Date(Date.now() - dias * 86_400_000);

    const { count } = await this.prisma.enriquecimento.updateMany({
      where: {
        criadoEm: { lt: corte },
        /* Só quem ainda tem conteúdo. Sem este filtro o UPDATE reescreveria
           todas as linhas antigas toda madrugada — escrita à toa numa tabela
           que só cresce, e ruído no autovacuum. */
        dadosBrutos: { not: Prisma.DbNull },
      },
      data: { dadosBrutos: Prisma.DbNull },
    });

    if (count > 0) {
      this.logger.log(
        `Retenção (${origem}): ${count} respostas de provedor com mais de ${dias} dias foram descartadas. ` +
          'As linhas de consulta seguem íntegras para a trilha.',
      );
    }
    return { limpos: count };
  }
}
