import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Papeis } from '../../common/decorators/papeis.decorator';
import { FilaService } from './fila.service';
import { SincronizacaoAgendada } from './sincronizacao.agendada';
import { ReconferirDto, SincronizarDto } from './fila.dto';
import { TetoConsumoService } from '../enriquecimento/application/teto-consumo.service';
import { ReconferenciaService } from '../enriquecimento/application/reconferencia.service';
import { ENRICHMENT_PROVIDER } from '../enriquecimento/domain/enrichment-provider.port';
import type { EnrichmentProvider } from '../enriquecimento/domain/enrichment-provider.port';

@ApiTags('fila')
@ApiBearerAuth('jwt')
@Controller('fila')
@Papeis('ADMIN', 'OPERADOR') // cliente não mexe em sincronização
export class FilaController {
  constructor(
    private readonly fila: FilaService,
    private readonly agendada: SincronizacaoAgendada,
    private readonly teto: TetoConsumoService,
    private readonly reconferencia: ReconferenciaService,
    @Inject(ENRICHMENT_PROVIDER) private readonly provider: EnrichmentProvider,
  ) {}

  @Get('consumo')
  @ApiOperation({ summary: 'Consumo do dia e teto configurado' })
  consumo() {
    return this.teto.estado(this.provider.nome);
  }

  @Get('estado')
  @ApiOperation({ summary: 'Contadores da fila de enriquecimento' })
  estado() {
    return this.fila.estado();
  }

  @Get('falhas')
  @ApiOperation({ summary: 'Últimas falhas com motivo' })
  falhas(@Query('limite') limite = '20') {
    return this.fila.falhasRecentes(Math.min(100, Number(limite) || 20));
  }

  @Post('sincronizar')
  @ApiOperation({ summary: 'Enfileira pendentes para enriquecimento' })
  sincronizar(@Body() dto: SincronizarDto) {
    return this.fila.enfileirarPendentes(dto.limite);
  }

  @Post('prever')
  @ApiOperation({ summary: 'Simula a rodada: quantas consultas e custo, SEM consumir' })
  prever(@Body() dto: SincronizarDto) {
    return this.agendada.prever(dto.limite);
  }

  @Post('sincronizar-agora')
  @ApiOperation({ summary: 'Dispara a sincronização. Exige limite explícito — consome crédito.' })
  sincronizarAgora(@Body() dto: SincronizarDto) {
    return this.agendada.executar('manual-painel', dto.limite);
  }

  @Post('reprocessar')
  @ApiOperation({ summary: 'Reprocessa os jobs que falharam' })
  reprocessar() {
    return this.fila.reprocessarFalhas();
  }

  /**
   * ── SÓ ADMIN, e o `@Papeis` daqui ESTREITA o da classe ──
   *
   * O `RolesGuard` resolve por `getAllAndOverride([handler, class])`, então o
   * do método vence. A classe libera OPERADOR porque sincronizar carteira é
   * rotina; reescrever veredito da base inteira não é.
   *
   * Não consulta provedor e não gasta crédito: relê o payload já guardado.
   * Mesmo assim ESCREVE, e por isso simula por padrão — ver `ReconferirDto`.
   */
  @Post('reconferir-nomes')
  @Papeis('ADMIN')
  @ApiOperation({
    summary: 'Refaz o veredito do CPF a partir do payload guardado. Não gasta crédito.',
    description:
      'Use quando a regra de comparação mudar. Simula por padrão: só `simular: false` grava.',
  })
  reconferirNomes(@Body() dto: ReconferirDto) {
    /* `!== false` e não `?? true`: qualquer coisa que não seja o `false`
       explícito simula. */
    return this.reconferencia.reconferir(dto.simular !== false);
  }
}
