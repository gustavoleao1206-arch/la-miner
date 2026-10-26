import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { Papeis, Publico, UsuarioAtual } from '../../common/decorators/papeis.decorator';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { CobrancaService } from './cobranca.service';

@ApiTags('cobranca')
@Controller('cobranca')
export class CobrancaController {
  constructor(
    private readonly cobranca: CobrancaService,
    private readonly prisma: PrismaService,
  ) {}

  // ── Cliente ──

  @Get('minha-assinatura')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  @ApiOperation({ summary: 'Plano, status e faturas da própria assinatura' })
  async minhaAssinatura(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.cobranca.minhaAssinatura(usuario.organizationId);
  }

  /**
   * Gera a cobrança que ficou faltando — pelas mãos do próprio cliente.
   *
   * Existe por causa de um beco sem saída real: quando o gateway recusa a
   * emissão, sobra uma fatura ABERTA sem cobrança do outro lado. Nada a
   * reconcilia sozinho (o cron de distribuição não olha fatura, e o de
   * vencimentos só mexe em quem já venceu), e a única rota capaz de retomar era
   * de ADMIN. O cliente ficava esperando uma confirmação que nunca viria.
   *
   * ⚠ A organização vem do TOKEN, nunca de parâmetro. Aceitar um id na URL
   * transformaria esta rota em "emitir fatura na conta alheia" — e ela é a
   * PRIMEIRA rota de cobrança que um cliente pode chamar.
   *
   * `emitirFatura` já é idempotente e já sabe retomar emissão incompleta, então
   * aqui não há regra de negócio nova: só quem pode pedir mudou.
   */
  @Post('minha-assinatura/retomar')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  /* Cada chamada bate no gateway. 5/min é o mesmo teto do cadastro público —
     generoso para quem clica de novo por impaciência, apertado para quem
     resolveu automatizar o botão. */
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Tenta gerar a cobrança da fatura em aberto da própria assinatura',
    description:
      'Idempotente: se a cobrança já existe, devolve a mesma sem chamar o gateway de novo.',
  })
  async retomarMinhaFatura(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.cobranca.emitirFatura({ organizationId: usuario.organizationId });
  }

  // ── Administração ──

  @Post('clientes/:id/fatura')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Emite a fatura do ciclo (idempotente por competência)' })
  async emitir(
    @Param('id', ParseUUIDPipe) organizationId: string,
    @Query('competencia') competencia?: string,
  ) {
    let quando: Date | undefined;
    if (competencia) {
      if (!/^\d{4}-\d{2}(-\d{2})?$/.test(competencia)) {
        throw new BadRequestException('A competência deve estar em AAAA-MM.');
      }
      quando = new Date(`${competencia.slice(0, 7)}-01T00:00:00.000Z`);
    }
    return this.cobranca.emitirFatura({ organizationId, competencia: quando });
  }

  @Post('faturas/:id/pagamento')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Dá baixa manual numa fatura (PIX/transferência recebidos)' })
  async baixar(@Param('id', ParseUUIDPipe) faturaId: string) {
    return this.cobranca.registrarPagamento(faturaId);
  }

  @Get('faturas')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Faturas de todos os clientes, mais recentes primeiro' })
  async faturas(@Query('status') status?: string) {
    const permitidos = ['ABERTA', 'PAGA', 'VENCIDA', 'CANCELADA', 'ESTORNADA'] as const;
    type StatusFatura = (typeof permitidos)[number];
    if (status && !permitidos.includes(status as StatusFatura)) {
      throw new BadRequestException(`status deve ser um de: ${permitidos.join(', ')}`);
    }
    const faturas = await this.prisma.fatura.findMany({
      where: status ? { status: status as StatusFatura } : {},
      orderBy: [{ competencia: 'desc' }, { criadoEm: 'desc' }],
      take: 200,
      select: {
        id: true,
        competencia: true,
        valor: true,
        status: true,
        vencimentoEm: true,
        pagoEm: true,
        assinatura: {
          select: {
            status: true,
            organization: { select: { id: true, nome: true } },
          },
        },
      },
    });
    return faturas.map((f) => ({
      ...f,
      valor: f.valor.toString(),
      cliente: f.assinatura.organization,
      statusAssinatura: f.assinatura.status,
      assinatura: undefined,
    }));
  }

  @Post('clientes/:id/cancelar')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Encerra a assinatura: para de faturar e o acesso cai (dados preservados)' })
  async cancelar(
    @Param('id', ParseUUIDPipe) organizationId: string,
    @Query('motivo') motivo?: string,
  ) {
    return this.cobranca.cancelarAssinatura(organizationId, motivo);
  }

  @Post('vencimentos')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'Roda a passagem de vencimentos agora (o cron faz isso diariamente)' })
  async vencimentos() {
    return this.cobranca.processarVencimentos();
  }

  // ── Webhook do gateway ──

  /**
   * Rota PÚBLICA — o gateway não tem token nosso.
   *
   * Quem autentica é a assinatura do provedor, conferida sobre o corpo CRU. No
   * provedor manual isto recusa tudo, de propósito: enquanto não há gateway
   * configurado, esta URL não pode dar baixa em nada.
   *
   * Throttle apertado: é a única rota pública que escreve, e o gateway legítimo
   * manda poucos eventos por segundo.
   */
  @Publico()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  /* `medio`, não `default`: o throttler chamado `default` não existe neste app,
     e o decorator com esse nome não limitava nada.
     ── OS DOIS BALDES, NÃO UM ──
     Sobrescrever só `medio` deixava `curto` valendo com o valor global de 10/s.
     O teto efetivo era 10/s E 30/min, e o de 30/min ninguém tinha decidido para
     um webhook: o balde é chaveado por `req.ip` e, com TRUST_PROXY_HOPS=2, TODO
     evento do Asaas cai no MESMO balde. Basta ~30 faturas vencerem no mesmo dia
     — o que acontece justamente quando o negócio deu certo — para o gateway
     tomar 429, reenviar e acabar penalizando os eventos. Um pagamento que não dá
     baixa é o pior silêncio deste sistema.
     Os números: 300/min ≈ 5/s sustentados, folga de uma ordem de grandeza sobre
     qualquer rajada de cobrança mensal; 30/s absorve o paralelismo do gateway.
     Continua sendo teto de verdade — a rota é PÚBLICA e o throttle roda ANTES da
     autenticação, então ele é a barreira contra quem nem tem o token. */
  @Throttle({
    curto: { limit: 30, ttl: 1_000 },
    medio: { limit: 300, ttl: 60_000 },
  })
  @ApiOperation({ summary: 'Recebe eventos de pagamento do gateway' })
  async webhook(@Req() req: RawBodyRequest<Request>, @Body() payload: unknown) {
    /* Os BYTES como chegaram. Sem eles a conferência de assinatura seria feita
       sobre um JSON re-serializado — e passaria a depender de ordem de chaves. */
    const corpoBruto = req.rawBody?.toString('utf8') ?? '';
    return this.cobranca.receberEvento(
      corpoBruto,
      req.headers as Record<string, string | undefined>,
      payload,
    );
  }
}
