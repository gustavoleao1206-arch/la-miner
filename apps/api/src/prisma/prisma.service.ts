import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@miner/database';

import { modoDoAmbiente, registrarSentinela } from './sentinela-escopo';

/**
 * Acrescenta os limites à URL de conexão.
 *
 * ── POR QUE NÃO DEIXAR NO PADRÃO ──
 *
 * Sem parâmetros, o Prisma dimensiona o pool por `num_cpus * 2 + 1`. Medido
 * nesta máquina: 25 conexões. O tamanho do pool passa a ser acidente do
 * hardware onde o processo caiu — e o Postgres da Render (`basic-256mb`) tem
 * teto baixo de conexões, compartilhado com as migrations do preDeploy e com
 * qualquer segundo serviço (o worker do C3, quando existir).
 *
 * E `statement_timeout` vinha ZERO: uma consulta travada segurava a conexão
 * para sempre. Bastam algumas para o pool acabar e a API parar de responder —
 * sem erro em lugar nenhum, só lentidão que vira indisponibilidade.
 *
 * Os três valores são explícitos porque cada um responde a uma pergunta
 * diferente: quantas conexões cabem, quanto se espera por uma livre, e quanto
 * tempo uma consulta pode tomar antes de ser abortada.
 *
 * Exportada para o teste conferir a montagem sem subir a aplicação.
 */
export function urlComLimites(
  base: string,
  limites: { conexoes: number; poolSegundos: number; consultaMs: number },
): string {
  const params = new URLSearchParams({
    connection_limit: String(limites.conexoes),
    pool_timeout: String(limites.poolSegundos),
    /* `options` chega ao Postgres como parâmetros de sessão. É o único caminho
       para statement_timeout via URL — conferido de verdade: com 1500ms, um
       `pg_sleep(5)` é abortado em ~1518ms com o código 57014. */
    options: `-c statement_timeout=${limites.consultaMs}`,
  });

  /* A URL já pode trazer `?schema=public`. Concatenar sem olhar produziria
     duas interrogações e uma URL inválida. */
  return base.includes('?') ? `${base}&${params}` : `${base}?${params}`;
}

/**
 * Dono único do pool de conexões. Nenhum outro ponto do código
 * instancia PrismaClient — evita múltiplos pools esgotando o Postgres.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    /**
     * Lido de `process.env` direto, e não do ConfigService.
     *
     * O PrismaService é construído junto com o módulo que o ConfigService ainda
     * está preparando — injetar aqui criaria dependência circular na
     * inicialização. As três chaves são validadas no boot pelo `env.validation`,
     * então os defaults abaixo só valem para quem instancia fora do Nest
     * (scripts).
     */
    const base = process.env.DATABASE_URL ?? '';
    const limites = {
      conexoes: Number(process.env.DB_CONEXOES ?? 10),
      poolSegundos: Number(process.env.DB_POOL_TIMEOUT_S ?? 10),
      consultaMs: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000),
    };

    super({
      datasources: base ? { db: { url: urlComLimites(base, limites) } } : undefined,
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    this.limites = limites;
  }

  private readonly limites: { conexoes: number; poolSegundos: number; consultaMs: number };

  async onModuleInit(): Promise<void> {
    /* O sentinela entra ANTES do `$connect`: middleware registrado depois de a
       primeira consulta sair não a teria visto, e o furo que mais importa é
       justamente o do boot. */
    const modo = modoDoAmbiente();
    registrarSentinela(this as never, modo, (m) => this.logger.warn(m));

    await this.$connect();
    /* Os limites no log de boot: é a diferença entre descobrir um pool mal
       dimensionado agora ou sob carga, quando as conexões acabam e a API
       simplesmente para de responder. */
    this.logger.log(
      `Conectado ao PostgreSQL (pool ${this.limites.conexoes} conexões · ` +
        `espera ${this.limites.poolSegundos}s · consulta até ${this.limites.consultaMs}ms)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Usado pelo /health/ready — confirma que o banco responde de fato. */
  async verificarConexao(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
