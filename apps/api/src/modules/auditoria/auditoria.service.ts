import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { PERIODO_MAX_DIAS, POR_PAGINA_MAX, type ConsultasQueryDto, type ResumoQueryDto } from './auditoria.dto';

/**
 * Fuso da operação. O Brasil extinguiu o horário de verão em 2019, então o
 * deslocamento é fixo — dá para interpretar uma data sem biblioteca de fuso.
 * Usado em dois lugares que PRECISAM concordar: o recorte do período e o
 * agrupamento por dia da série. Se divergissem, o gráfico não fecharia com a lista.
 */
const FUSO = 'America/Sao_Paulo';
const OFFSET = '-03:00';

const DIA_MS = 86_400_000;

/** Teto da trilha por CPF. É resposta a titular, não exportação de base. */
const TETO_TRILHA = 500;

// ── Tipos de resposta ──

export interface ConsultaAuditoria {
  id: string;
  tipo: string;
  /** Nulo quando o texto já passou do prazo e foi descartado — ver `RetencaoAgendada`. */
  termo: string | null;
  cpfConsultado: string | null;
  totalResultados: number;
  contatoExibido: boolean;
  ip: string | null;
  userAgent: string | null;
  criadoEm: Date;
  user: { id: string; nome: string; email: string; papel: string };
}

export interface PaginaAuditoria<T> {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: T[];
}

export interface ResumoAuditoria {
  periodo: { de: string; ate: string };
  totalConsultas: number;
  consultasComContato: number;
  usuariosDistintos: number;
  cpfsDistintos: number;
  /** Um ponto por dia do período, inclusive os dias sem consulta (total 0). */
  serieDiaria: { data: string; total: number }[];
}

export interface EnriquecimentoAuditoria {
  id: string;
  provider: string;
  versao: number;
  status: string;
  mensagemErro: string | null;
  custoCreditos: string | null;
  requestId: string | null;
  latenciaMs: number | null;
  criadoEm: Date;
}

/** Uma opção do filtro "Usuário" da tela de auditoria. */
export interface UsuarioAuditoria {
  id: string;
  nome: string;
  email: string;
  /** Quantas consultas ele registrou — ordena a lista pelo que interessa. */
  consultas: number;
}

export interface TrilhaCpf {
  cpf: string;
  geradoEm: Date;
  pessoa: {
    id: string;
    nome: string;
    statusEnriquecimento: string;
    ultimaSincronizacao: Date | null;
  } | null;
  totalConsultas: number;
  /** true quando `consultas` foi truncada no teto — a trilha completa é maior. */
  truncado: boolean;
  consultas: ConsultaAuditoria[];
  enriquecimentos: EnriquecimentoAuditoria[];
}

/**
 * Leitura da trilha de accountability.
 *
 * NÃO EXISTE MÉTODO DE ESCRITA AQUI, e isso é deliberado: registro de auditoria
 * que o próprio sistema sabe alterar ou apagar não sustenta nada numa
 * fiscalização. Quem grava é quem consulta (CarteiraController) e o worker de
 * enriquecimento. Este serviço só lê.
 */
@Injectable()
export class AuditoriaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista paginada, mais recente primeiro. Sem período informado, varre tudo — paginado. */
  async listarConsultas(dto: ConsultasQueryDto, organizationId: string): Promise<PaginaAuditoria<ConsultaAuditoria>> {
    const { de, ate, userId, cpfConsultado, tipo, somenteContatoExibido } = dto;

    /* Clamp além do DTO: o serviço é chamável por outro código do backend, e o
       teto de página é uma garantia do serviço, não da camada HTTP. */
    const pagina = Math.max(1, dto.pagina || 1);
    const porPagina = Math.min(POR_PAGINA_MAX, Math.max(1, dto.porPagina || 20));

    /* ConsultaCliente não tem organizationId próprio: pertence à organização
       pelo usuário que fez a consulta. Sem esta trava, um ADMIN leria termo,
       CPF consultado, IP e e-mail dos funcionários de outro tenant. */
    const where: Prisma.ConsultaClienteWhereInput = { user: { organizationId } };
    if (de || ate) {
      const { inicio, fim } = this.periodo(de, ate);
      where.criadoEm = { gte: inicio, lte: fim };
    }
    if (userId) where.userId = userId;
    if (cpfConsultado) where.cpfConsultado = cpfConsultado;
    if (tipo) where.tipo = tipo;
    if (somenteContatoExibido) where.contatoExibido = true;

    const [total, itens] = await Promise.all([
      this.prisma.consultaCliente.count({ where }),
      this.prisma.consultaCliente.findMany({
        where,
        skip: (pagina - 1) * porPagina,
        take: porPagina,
        orderBy: { criadoEm: 'desc' },
        select: this.selecaoConsulta,
      }),
    ]);

    return {
      total,
      pagina,
      porPagina,
      totalPaginas: Math.max(1, Math.ceil(total / porPagina)),
      itens,
    };
  }

  async resumo(dto: ResumoQueryDto, organizationId: string): Promise<ResumoAuditoria> {
    const { inicio, fim } = this.periodo(dto.de, dto.ate);

    if (fim.getTime() - inicio.getTime() > PERIODO_MAX_DIAS * DIA_MS) {
      throw new BadRequestException(`O período do resumo não pode passar de ${PERIODO_MAX_DIAS} dias.`);
    }

    /* ConsultaCliente não tem organizationId próprio: pertence à organização
       pelo usuário que fez a consulta. Sem esta trava, um ADMIN leria termo,
       CPF consultado, IP e e-mail dos funcionários de outro tenant. */
    const where: Prisma.ConsultaClienteWhereInput = {
      criadoEm: { gte: inicio, lte: fim },
      user: { organizationId },
    };

    const [totalConsultas, consultasComContato, porUsuario, porCpf, serie] = await Promise.all([
      this.prisma.consultaCliente.count({ where }),
      this.prisma.consultaCliente.count({ where: { ...where, contatoExibido: true } }),
      this.prisma.consultaCliente.groupBy({ by: ['userId'], where }),
      this.prisma.consultaCliente.groupBy({
        by: ['cpfConsultado'],
        where: { ...where, cpfConsultado: { not: null } },
      }),
      this.serieDiaria(inicio, fim, organizationId),
    ]);

    return {
      periodo: { de: inicio.toISOString(), ate: fim.toISOString() },
      totalConsultas,
      consultasComContato,
      usuariosDistintos: porUsuario.length,
      cpfsDistintos: porCpf.length,
      serieDiaria: serie,
    };
  }

  /**
   * Quem já consultou algo — as opções do filtro "Usuário" da tela.
   *
   * ── POR QUE ESTA ROTA NÃO EXISTIA ──
   *
   * A tela sempre a chamou (`ROTAS.usuarios`), o backend sempre aceitou
   * `?userId=` em `/auditoria/consultas`, e o resumo até exibe
   * `usuariosDistintos`. Só a rota faltava — e a falha era MUDA: o front tem
   * `.catch(() => setUsuarios([]))`, e o bloco do filtro é condicional a
   * `usuarios.length > 0`. Resultado: o seletor nunca aparecia, e ninguém via
   * erro nenhum. A capacidade existia inteira e estava inalcançável.
   *
   * Só quem TEM consulta registrada entra. Listar todo mundo encheria o filtro
   * de gente que nunca aparece na tabela — e, num escritório grande, esconderia
   * quem de fato consulta no meio de dezenas de nomes inertes.
   *
   * Escopo pela organização do USUÁRIO, como no resto do módulo: `ConsultaCliente`
   * não tem `organizationId` próprio. Sem isso o filtro listaria os funcionários
   * de outro cliente — nome e e-mail — para quem abrisse a auditoria.
   */
  async usuariosComConsulta(organizationId: string): Promise<UsuarioAuditoria[]> {
    const porUsuario = await this.prisma.consultaCliente.groupBy({
      by: ['userId'],
      where: { user: { organizationId } },
      _count: { _all: true },
    });
    if (porUsuario.length === 0) return [];

    const usuarios = await this.prisma.user.findMany({
      where: { id: { in: porUsuario.map((u) => u.userId) } },
      select: { id: true, nome: true, email: true },
    });
    const contagem = new Map(porUsuario.map((u) => [u.userId, u._count._all]));

    return usuarios
      .map((u) => ({ ...u, consultas: contagem.get(u.id) ?? 0 }))
      /* Mais ativo primeiro; nome como desempate, senão a ordem dança entre
         duas aberturas da tela e o seletor parece bugado. */
      .sort((a, b) => b.consultas - a.consultas || a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  /**
   * Resposta ao titular que exerce o art. 18 da LGPD: tudo que tocou este CPF.
   * O CPF já chega validado pelo DTO; a checagem repetida cobre chamada interna.
   */
  async trilhaCpf(cpfBruto: string, organizationId: string): Promise<TrilhaCpf> {
    const cpf = (cpfBruto ?? '').replace(/\D/g, '');
    if (!/^\d{11}$/.test(cpf)) throw new BadRequestException('CPF deve ter 11 dígitos.');

    /* `cpfConsultado` só é preenchido quando a busca foi por CPF completo. Uma
       busca por nome que devolveu este titular não aparece aqui — daí o segundo
       critério, que pega o CPF digitado dentro do termo. Termo com máscara
       ("123.456.789-00") não casa: é limitação conhecida, não descuido. */
    /* AND, não mais um item no OR: o recorte por organização precisa valer
       junto das duas alternativas de casamento do CPF. Solto dentro do OR, ele
       viraria uma terceira forma de casar e devolveria TODAS as consultas do
       tenant, não as deste titular. */
    const where: Prisma.ConsultaClienteWhereInput = {
      user: { organizationId },
      OR: [{ cpfConsultado: cpf }, { termo: { contains: cpf } }],
    };

    const pessoa = await this.prisma.pessoa.findUnique({
      where: { cpf },
      select: { id: true, nome: true, statusEnriquecimento: true, ultimaSincronizacao: true },
    });

    const [totalConsultas, consultas, enriquecimentos] = await Promise.all([
      this.prisma.consultaCliente.count({ where }),
      this.prisma.consultaCliente.findMany({
        where,
        take: TETO_TRILHA,
        orderBy: { criadoEm: 'desc' },
        select: this.selecaoConsulta,
      }),
      pessoa
        ? this.prisma.enriquecimento.findMany({
            where: { pessoaId: pessoa.id },
            orderBy: { criadoEm: 'desc' },
            take: TETO_TRILHA,
            /* `dadosBrutos` fica de fora de propósito: a trilha responde QUEM
               tocou o dado e QUANDO. Devolver o payload íntegro do provider a
               cada leitura multiplica a exposição do que se quer proteger. */
            select: {
              id: true,
              provider: true,
              versao: true,
              status: true,
              mensagemErro: true,
              custoCreditos: true,
              requestId: true,
              latenciaMs: true,
              criadoEm: true,
            },
          })
        : Promise.resolve([]),
    ]);

    return {
      cpf,
      geradoEm: new Date(),
      pessoa,
      totalConsultas,
      truncado: totalConsultas > consultas.length,
      consultas,
      // Decimal do Prisma não sobrevive ao JSON.stringify com precisão — vai como string.
      enriquecimentos: enriquecimentos.map((e) => ({
        ...e,
        custoCreditos: e.custoCreditos?.toString() ?? null,
      })),
    };
  }

  private readonly selecaoConsulta = {
    id: true,
    tipo: true,
    termo: true,
    cpfConsultado: true,
    totalResultados: true,
    contatoExibido: true,
    ip: true,
    userAgent: true,
    criadoEm: true,
    user: { select: { id: true, nome: true, email: true, papel: true } },
  } as const;

  /**
   * Um ponto por dia, sem buraco. O SQL só devolve os dias que tiveram consulta;
   * plotar isso direto encurta o eixo e finge que a semana teve 4 dias.
   *
   * ⚠ `organizationId` É OBRIGATÓRIO, e não era.
   *
   * O `resumo` monta um `where` do Prisma com `user: { organizationId }` e um
   * comentário dizendo, com todas as letras, que sem essa trava um ADMIN leria
   * dado de outro tenant. E então chamava esta função, que roda SQL CRU e
   * filtrava só por data — o escopo ficava para trás na fronteira do Prisma.
   *
   * O gráfico diário contava as consultas da PLATAFORMA INTEIRA. Não vazava
   * conteúdo (termo, CPF, IP ficaram protegidos pelas outras consultas), mas
   * entregava o volume de atividade de todos os clientes a qualquer um deles —
   * inclusive concorrentes entre si.
   *
   * Mesma classe do achado do B2: o SQL cru escapou da trava que o Prisma
   * carregava. Onde há `$queryRaw` num modelo multi-tenant, o escopo tem de ser
   * reescrito à mão, e é por isso que agora ele é PARÂMETRO — quem chamar sem
   * passá-lo não compila.
   */
  private async serieDiaria(
    inicio: Date,
    fim: Date,
    organizationId: string,
  ): Promise<{ data: string; total: number }[]> {
    /* COUNT(*) é bigint: sem o ::int o Prisma devolve BigInt, que o JSON.stringify
       do Nest não serializa — a rota inteira estoura em runtime.
       O AT TIME ZONE duplo converte o TIMESTAMP (gravado em UTC, sem fuso na
       coluna) para o calendário local antes de agrupar. */

    /**
     * ⚠ AS DATAS VÃO COMO TEXTO ISO COM `::timestamp`, E NÃO COMO `Date`.
     *
     * `criadoEm` é `timestamp WITHOUT time zone` guardando UTC. Passando um
     * `Date` do JavaScript, o Prisma o envia como `timestamptz` e o Postgres o
     * converte para o fuso da SESSÃO antes de comparar — aqui, `America/Cayenne`
     * (UTC−3). A janela inteira escorregava 3 horas.
     *
     * Medido: com parâmetro `Date`, a mesma consulta que devolve 10 linhas
     * devolvia ZERO. Na prática o gráfico perdia as consultas mais recentes —
     * justamente as do dia que o operador está olhando.
     *
     * O texto ISO com `::timestamp` é comparado como horário de parede, que é
     * exatamente como a coluna guarda. Imune ao fuso da sessão.
     */
    const linhas = await this.prisma.$queryRaw<{ dia: string; total: number }[]>`
      SELECT to_char(
               date_trunc('day', (c."criadoEm" AT TIME ZONE 'UTC') AT TIME ZONE ${FUSO}::text),
               'YYYY-MM-DD'
             ) AS dia,
             COUNT(*)::int AS total
        FROM "consultas_cliente" c
        JOIN "users" u ON u."id" = c."userId"
       WHERE c."criadoEm" >= ${inicio.toISOString()}::timestamp
         AND c."criadoEm" <= ${fim.toISOString()}::timestamp
         AND u."organizationId" = ${organizationId}::uuid
       GROUP BY 1
       ORDER BY 1
    `;

    const porDia = new Map(linhas.map((l) => [l.dia, Number(l.total)]));
    const serie: { data: string; total: number }[] = [];

    for (let t = inicio.getTime(); t <= fim.getTime(); t += DIA_MS) {
      const data = this.diaLocal(new Date(t));
      // O passo de 24h pode repetir um dia na borda; o Map garante idempotência.
      if (serie[serie.length - 1]?.data !== data) {
        serie.push({ data, total: porDia.get(data) ?? 0 });
      }
    }
    return serie;
  }

  /** AAAA-MM-DD no fuso da operação — mesma chave que o SQL produz. */
  private diaLocal(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  /**
   * Resolve o período. Padrão: últimos 30 dias.
   *
   * Uma data pura ("2026-07-19") em `ate` viraria 00:00 e cortaria fora o dia
   * inteiro que o operador pediu — off-by-one silencioso numa tela cujo propósito
   * é ser confiável. Por isso datas puras ganham as bordas do dia, no fuso local.
   */
  private periodo(de?: string, ate?: string): { inicio: Date; fim: Date } {
    const soData = /^\d{4}-\d{2}-\d{2}$/;

    const fim = ate
      ? new Date(soData.test(ate) ? `${ate}T23:59:59.999${OFFSET}` : ate)
      : new Date();
    const inicio = de
      ? new Date(soData.test(de) ? `${de}T00:00:00.000${OFFSET}` : de)
      : new Date(fim.getTime() - 30 * DIA_MS);

    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
      throw new BadRequestException('Período inválido. Use AAAA-MM-DD.');
    }
    if (inicio > fim) {
      throw new BadRequestException('A data inicial é posterior à final.');
    }
    return { inicio, fim };
  }
}
