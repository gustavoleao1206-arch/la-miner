import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@miner/database';
import { escopoGlobal } from '../../prisma/sentinela-escopo';
import { CobrancaService } from './cobranca.service';

/**
 * Ciclo diário de cobrança: fatura quem deve ser faturado, vence o que passou do
 * prazo e suspende quem estourou a carência.
 *
 * Diário e não mensal, pelo mesmo motivo da distribuição: assinaturas começam em
 * dias diferentes, e as duas operações são idempotentes (uma fatura por
 * competência), então rodar todo dia é mais simples e mais robusto do que
 * acertar um dia do mês.
 *
 * Desligado por padrão. Este cron SUSPENDE cliente — é o mais consequente do
 * sistema, e ligar sozinho num ambiente recém-configurado poderia cortar o acesso
 * de quem está em dia por causa de um relógio ou de um seed pela metade.
 */
@Injectable()
export class CobrancaAgendada {
  private readonly logger = new Logger(CobrancaAgendada.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cobranca: CobrancaService,
    private readonly config: ConfigService,
  ) {}

  private get habilitado(): boolean {
    return this.config.get<string>('COBRANCA_AGENDADA_ATIVA', 'false') === 'true';
  }

  /** Todo dia às 05:00 — depois da distribuição das 04:00. */
  @Cron(process.env.COBRANCA_CRON ?? '0 5 * * *', {
    name: 'cobranca-diaria',
    timeZone: 'America/Recife',
  })
  async rodar(): Promise<void> {
    if (!this.habilitado) {
      this.logger.debug('Cobrança agendada desativada (COBRANCA_AGENDADA_ATIVA != true)');
      return;
    }
    await this.executar('cron-diario');
  }

  /** Exposto para o botão "rodar cobrança agora" do painel administrativo. */
  async executar(origem: string) {
    /* Fatura também o INADIMPLENTE: ele continua consumindo o serviço durante a
       carência, e pular o ciclo dele criaria um buraco na régua de cobrança que
       ninguém fecharia depois. Quem não é faturado é SUSPENSA e CANCELADA. */
    const aFaturar = await this.prisma.assinatura.findMany(
      /* O ciclo de faturamento roda sem usuário logado e precisa alcançar TODOS
         os clientes — recortá-lo por organização seria não faturar ninguém. */
      escopoGlobal('cron de cobranca: varre as assinaturas de todos os clientes, sem usuario logado', {
        /* `satisfies` e não genérico explícito: fixar o genérico corrigiria o
           enum e apagaria a inferência do `select` junto, devolvendo o tipo do
           modelo inteiro para uma consulta que traz uma coluna só. */
        where: { status: { in: ['ATIVA', 'INADIMPLENTE'] } } satisfies Prisma.AssinaturaWhereInput,
        select: { organizationId: true },
      }),
    );

    let emitidas = 0;
    for (const a of aFaturar) {
      try {
        const r = await this.cobranca.emitirFatura({ organizationId: a.organizationId });
        if (r.emitida) emitidas++;
      } catch (e) {
        /* Uma assinatura problemática não pode derrubar a rodada das outras. */
        this.logger.error(
          `Falha ao faturar a org ${a.organizationId}: ${(e as Error).message}`,
        );
      }
    }

    const vencimentos = await this.cobranca.processarVencimentos();

    this.logger.log(
      `Cobrança (${origem}): ${emitidas} fatura(s) emitida(s), ` +
        `${vencimentos.vencidas} vencida(s), ${vencimentos.inadimplentes} inadimplente(s), ` +
        `${vencimentos.suspensas} suspensa(s)`,
    );
    return { emitidas, ...vencimentos };
  }
}
