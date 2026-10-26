import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@miner/database';
import { escopoGlobal } from '../../prisma/sentinela-escopo';
import { DistribuicaoService } from './distribuicao.service';

/**
 * Renovação automática das assinaturas.
 *
 * Roda TODO DIA, não uma vez por mês: assinaturas começam em dias diferentes, e
 * um cron mensal só serviria a quem vence naquele dia. Aqui ele varre quem já
 * venceu (`proximaRenovacaoEm <= hoje`) e gera o ciclo de cada um.
 *
 * Rodar de novo no mesmo dia é inofensivo porque `gerarLote` é idempotente por
 * (assinatura, competência) — é o que permite o cron ser diário e burro em vez de
 * mensal e cheio de casos especiais.
 *
 * Desligado por padrão, como a sincronização: distribuir carteira é ato
 * comercial, e ligar sozinho num ambiente recém-configurado seria pior do que
 * não rodar.
 */
@Injectable()
export class DistribuicaoAgendada {
  private readonly logger = new Logger(DistribuicaoAgendada.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly distribuicao: DistribuicaoService,
    private readonly config: ConfigService,
  ) {}

  private get habilitado(): boolean {
    return this.config.get<string>('DISTRIBUICAO_AGENDADA_ATIVA', 'false') === 'true';
  }

  /** Todo dia às 04:00 — depois da sincronização das 03:00, antes do expediente. */
  @Cron(process.env.DISTRIBUICAO_CRON ?? '0 4 * * *', {
    name: 'distribuicao-diaria',
    timeZone: 'America/Recife',
  })
  async renovarVencidas(): Promise<void> {
    if (!this.habilitado) {
      /* WARN, não debug. Em produção o nível é `info`, então o debug NUNCA
         aparecia: o cron deixava de entregar a carteira de todo mundo e não
         havia uma linha sequer dizendo isso. Um mês inteiro de assinaturas sem
         renovação passaria como noite tranquila no log. */
      this.logger.warn(
        'Distribuição agendada DESATIVADA (DISTRIBUICAO_AGENDADA_ATIVA != "true"): ' +
          'nenhum cliente terá a carteira renovada enquanto isto não for ligado.',
      );
      return;
    }
    await this.executar('cron-diario');
  }

  /** Exposto para o botão "renovar agora" do painel administrativo. */
  async executar(origem: string): Promise<{
    assinaturas: number;
    lotes: number;
    liberados: number;
    /** Clientes que receberam MENOS do que o plano promete. */
    parciais: number;
    /** Clientes que não receberam NADA: a base deles esgotou. */
    vazios: number;
  }> {
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);

    const vencidas = await this.prisma.assinatura.findMany(
      /* O cron roda sem usuário logado e precisa alcançar todo cliente cujo
         ciclo venceu — recortá-lo por organização seria não distribuir nada. */
      escopoGlobal('cron de distribuicao: varre as assinaturas vencidas de todos os clientes', {
        where: {
          status: 'ATIVA',
          /* `null` entra: é a assinatura que nunca gerou ciclo — o primeiro lote
             sai na primeira passada do cron, sem precisar de disparo manual. */
          OR: [{ proximaRenovacaoEm: null }, { proximaRenovacaoEm: { lte: hoje } }],
        } satisfies Prisma.AssinaturaWhereInput,
        select: { organizationId: true },
      }),
    );

    let lotes = 0;
    let liberados = 0;
    /* Os dois desfechos que o número total esconde: o cliente que recebeu MENOS
       do que o plano promete, e o que não recebeu NADA. Sem separá-los, a linha
       "12 lotes, 2.900 liberados" parece saudável enquanto um cliente pagou e
       ficou sem carteira. */
    const parciais: string[] = [];
    const vazios: string[] = [];
    for (const a of vencidas) {
      /* Sequencial de propósito: cada geração lê "o que ainda não foi liberado" e
         escreve nessa mesma tabela. Em paralelo, dois clientes poderiam disputar
         os mesmos processos de maior valor — o @@unique salvaria a integridade,
         mas um deles receberia menos do que o plano promete, silenciosamente. */
      try {
        const r = await this.distribuicao.gerarLote({ organizationId: a.organizationId });
        if (r.gerado) {
          lotes++;
          liberados += r.liberados;
          if (r.liberados < r.alvo) parciais.push(a.organizationId);
        } else if (r.motivo?.includes('não tem processo novo')) {
          vazios.push(a.organizationId);
        }
      } catch (e) {
        /* Uma assinatura problemática não pode derrubar a rodada das outras. */
        this.logger.error(
          `Falha ao gerar lote da org ${a.organizationId}: ${(e as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Distribuição (${origem}): ${vencidas.length} assinatura(s) vencida(s), ` +
        `${lotes} lote(s) gerado(s), ${liberados} processo(s) liberado(s)`,
    );

    /**
     * A BASE ESGOTOU PARA ALGUÉM.
     *
     * `warn`, e não `log`: o cliente está pagando e não recebeu — ou recebeu
     * menos do que a assinatura promete. A alavanca é importar carteira nova, e
     * quem faz isso precisa saber ANTES de o cliente perguntar.
     *
     * O aviso também vive na tela (o alerta do dashboard, a partir de
     * `DistribuicaoService.folego`); aqui ele fica porque o cron roda às quatro
     * da manhã e é o primeiro a descobrir.
     */
    if (vazios.length > 0) {
      this.logger.warn(
        `BASE ESGOTADA para ${vazios.length} cliente(s): ${vazios.join(', ')}. ` +
          'Eles seguem pagando e NÃO receberam processo nenhum neste ciclo. ' +
          'Importe carteira nova para destravar.',
      );
    }
    if (parciais.length > 0) {
      this.logger.warn(
        `Lote INCOMPLETO para ${parciais.length} cliente(s): ${parciais.join(', ')}. ` +
          'A base já não cobre a cota do plano — o próximo ciclo tende a vir vazio.',
      );
    }

    return { assinaturas: vencidas.length, lotes, liberados, parciais: parciais.length, vazios: vazios.length };
  }
}
