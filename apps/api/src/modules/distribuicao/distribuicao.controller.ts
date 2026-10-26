import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { Papeis } from '../../common/decorators/papeis.decorator';
import { DistribuicaoService } from './distribuicao.service';
import { CriarClienteDto, CriarPlanoDto } from './distribuicao.dto';

@ApiTags('distribuicao')
@ApiBearerAuth('jwt')
@Controller('distribuicao')
/* Só ADMIN. Aqui se cria cliente, se define plano e se libera carteira — é o
   painel COMERCIAL da operação. OPERADOR importa e sincroniza, mas não vende; e
   o CLIENTE não pode sequer saber que esta superfície existe, porque é dela que
   sai a resposta "quem mais recebeu este processo". */
@Papeis('ADMIN')
export class DistribuicaoController {
  constructor(
    private readonly distribuicao: DistribuicaoService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Planos ──

  @Post('planos')
  @ApiOperation({ summary: 'Cria um plano de assinatura' })
  async criarPlano(@Body() dto: CriarPlanoDto) {
    const plano = await this.prisma.plano.create({
      data: {
        nome: dto.nome.trim(),
        descricao: dto.descricao?.trim() || null,
        processosPorCiclo: dto.processosPorCiclo,
        preco: dto.preco,
        intervaloMeses: dto.intervaloMeses ?? 1,
      },
      select: { id: true, nome: true, processosPorCiclo: true, intervaloMeses: true },
    });
    return { ...plano, preco: dto.preco.toFixed(2) };
  }

  @Get('planos')
  @ApiOperation({ summary: 'Catálogo de planos' })
  async planos() {
    const planos = await this.prisma.plano.findMany({
      where: { ativo: true },
      orderBy: { processosPorCiclo: 'asc' },
      select: {
        id: true,
        nome: true,
        descricao: true,
        processosPorCiclo: true,
        preco: true,
        intervaloMeses: true,
        _count: { select: { assinaturas: true } },
      },
    });
    /* Decimal do Prisma vira string em toda a API — ver a nota no `resumo`. */
    return planos.map((p) => ({ ...p, preco: p.preco.toString() }));
  }

  // ── Clientes ──

  @Post('clientes')
  @ApiOperation({ summary: 'Cadastra uma org CLIENTE e sua assinatura' })
  async criarCliente(@Body() dto: CriarClienteDto) {
    /* A senha é gerada aqui e o hash sai ANTES da transação: argon2 leva ~100ms
       de propósito (é o que o torna caro de atacar), e segurar a transação aberta
       nesse tempo prenderia conexão do pool por nada. */
    const senhaInicial = dto.emailUsuario ? randomBytes(12).toString('base64url') : null;
    const senhaHash = senhaInicial
      ? await hash(senhaInicial, { memoryCost: 19456, timeCost: 2, parallelism: 1 })
      : null;

    /* Org, assinatura e primeiro usuário na MESMA transação: um cliente sem
       assinatura não recebe lote nenhum e ficaria invisível para o motor — um
       cadastro pela metade que ninguém perceberia até a primeira renovação não
       acontecer. */
    return this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { nome: dto.nome.trim(), cnpj: dto.cnpj ?? null, tipo: 'CLIENTE' },
        select: { id: true, nome: true, cnpj: true },
      });
      const assinatura = await tx.assinatura.create({
        data: {
          organizationId: org.id,
          planoId: dto.planoId,
          /* ATIVA na criação porque, até a Fase de billing existir, o ato do
             admin de cadastrar É a ativação. Quando o gateway entrar, isto passa
             a nascer PENDENTE e só vira ATIVA no webhook do primeiro pagamento. */
          status: 'ATIVA',
        },
        select: { id: true, status: true, plano: { select: { nome: true, processosPorCiclo: true } } },
      });

      let acesso: { email: string; senhaInicial: string; aviso: string } | null = null;
      if (dto.emailUsuario && senhaHash && senhaInicial) {
        const email = dto.emailUsuario.toLowerCase().trim();
        await tx.user.create({
          data: {
            organizationId: org.id,
            email,
            nome: dto.nomeUsuario?.trim() || dto.nome.trim(),
            /* papel CLIENTE: quem entra por aqui enxerga só a carteira liberada.
               O escopo real quem aplica é o tipo da ORG, mas o papel é o que
               fecha as rotas administrativas no guard. */
            papel: 'CLIENTE',
            /* O primeiro usuário é o GESTOR da empresa — é ele que convida os
               colegas. Sem isso o cliente nasceria sem ninguém capaz de crescer a
               equipe, e só um gestor promove outro: a empresa ficaria trancada. */
            gestor: true,
            senhaHash,
          },
        });
        acesso = {
          email,
          senhaInicial,
          aviso: 'Senha exibida uma única vez. Entregue ao cliente e peça a troca no primeiro acesso.',
        };
      }

      return { organizationId: org.id, nome: org.nome, cnpj: org.cnpj, assinatura, acesso };
    });
  }

  /**
   * O FÔLEGO das assinaturas: quanto de base ainda resta para cada cliente.
   *
   * Rota separada, e não um campo do dashboard, porque a resposta muda uma vez
   * por mês — consultá-la no ritmo dos outros cartões seria varrer a tabela de
   * liberações a cada minuto para ver o mesmo número.
   */
  @Get('folego')
  @ApiOperation({
    summary: 'Quantos ciclos de base ainda restam para cada cliente',
    description:
      'A base é finita e o cliente paga todo mês. Quando o poço dele seca, a assinatura segue ' +
      'ATIVA e a fatura segue saindo — este é o aviso para importar carteira nova antes disso.',
  })
  async folego() {
    return this.distribuicao.folego();
  }

  @Get('clientes')
  @ApiOperation({ summary: 'Clientes, suas assinaturas e o tamanho da carteira liberada' })
  async clientes() {
    const orgs = await this.prisma.organization.findMany({
      where: { tipo: 'CLIENTE' },
      orderBy: { criadoEm: 'desc' },
      select: {
        id: true,
        nome: true,
        cnpj: true,
        ativo: true,
        criadoEm: true,
        _count: { select: { liberacoes: true, usuarios: true } },
        assinatura: {
          select: {
            id: true,
            status: true,
            inicioEm: true,
            proximaRenovacaoEm: true,
            plano: { select: { nome: true, processosPorCiclo: true } },
            _count: { select: { lotes: true } },
          },
        },
      },
    });
    /* O fôlego vem do MESMO cálculo do alerta, e não de uma conta repetida
       aqui: dois lugares respondendo "quantos ciclos ainda cabem" divergiriam no
       dia em que um deles mudasse — e a tela mostraria um número enquanto o
       alerta usaria outro. */
    const { clientes: folego } = await this.distribuicao.folego();
    const folegoPor = new Map(folego.map((f) => [f.organizationId, f]));

    return orgs.map((o) => ({
      organizationId: o.id,
      nome: o.nome,
      cnpj: o.cnpj,
      ativo: o.ativo,
      criadoEm: o.criadoEm,
      usuarios: o._count.usuarios,
      /* O número que o comercial olha: quantos processos este cliente já recebeu. */
      processosLiberados: o._count.liberacoes,
      ciclos: o.assinatura?._count.lotes ?? 0,
      /* Nulo para quem não tem assinatura ATIVA nem INADIMPLENTE: sem ciclo por
         vir, "quanto ainda cabe" não é uma pergunta com resposta útil. */
      folego: folegoPor.get(o.id)
        ? {
            restantesNaBase: folegoPor.get(o.id)!.restantesNaBase,
            ciclosRestantes: folegoPor.get(o.id)!.ciclosRestantes,
            situacao: folegoPor.get(o.id)!.situacao,
          }
        : null,
      assinatura: o.assinatura
        ? {
            id: o.assinatura.id,
            status: o.assinatura.status,
            inicioEm: o.assinatura.inicioEm,
            proximaRenovacaoEm: o.assinatura.proximaRenovacaoEm,
            plano: o.assinatura.plano,
          }
        : null,
    }));
  }

  // ── Distribuição ──

  @Post('clientes/:id/lote')
  @ApiOperation({ summary: 'Gera o lote do ciclo (use dryRun=true para simular)' })
  async gerarLote(
    @Param('id', ParseUUIDPipe) organizationId: string,
    @Query('dryRun') dryRun?: string,
    @Query('competencia') competencia?: string,
  ) {
    /* `competencia` permite regerar um mês específico (correção operacional).
       Formato validado aqui: string livre viraria Invalid Date e o Prisma
       devolveria 500 — um erro do cliente disfarçado de falha do servidor. */
    let quando: Date | undefined;
    if (competencia) {
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(competencia)) {
        throw new BadRequestException('A competência deve estar em AAAA-MM.');
      }
      quando = new Date(`${competencia.slice(0, 7)}-01T00:00:00.000Z`);
    }
    return this.distribuicao.gerarLote({
      organizationId,
      competencia: quando,
      dryRun: dryRun === 'true',
    });
  }

  @Get('clientes/:id/lotes')
  @ApiOperation({ summary: 'Histórico de distribuição do cliente' })
  async lotes(@Param('id', ParseUUIDPipe) organizationId: string) {
    return this.distribuicao.lotes(organizationId);
  }
}
