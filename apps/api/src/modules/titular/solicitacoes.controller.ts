import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

import { Papeis, UsuarioAtual, type UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { OrganizacaoInternaGuard } from '../../common/guards/organizacao-interna.guard';
import { SolicitacoesService } from './solicitacoes.service';

const TIPOS = [
  'ACESSO',
  'CORRECAO',
  'EXCLUSAO',
  'OPOSICAO',
  'PORTABILIDADE',
  'REVISAO_AUTOMATIZADA',
] as const;

const STATUS = ['RECEBIDA', 'EM_ANALISE', 'ATENDIDA', 'RECUSADA'] as const;

const soDigitos = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null ? value : String(value).replace(/\D/g, '');

class RegistrarDto {
  @ApiProperty({ description: 'CPF do titular que fez o pedido', example: '12345678901' })
  @Transform(soDigitos)
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos.' })
  cpf!: string;

  @ApiProperty({ enum: TIPOS })
  @IsEnum(TIPOS, { message: `tipo deve ser um de: ${TIPOS.join(', ')}` })
  tipo!: (typeof TIPOS)[number];

  @ApiPropertyOptional({ description: 'Nome informado pelo titular, quando houver' })
  @IsOptional()
  @IsString()
  @Length(2, 160)
  nome?: string;

  @ApiPropertyOptional({ description: 'E-mail de onde veio o pedido — é por ele que a resposta volta' })
  @IsOptional()
  @IsEmail({}, { message: 'E-mail inválido.' })
  @Length(5, 160)
  email?: string;

  /**
   * O que o titular escreveu.
   *
   * ⚠ É a superfície de dado SENSÍVEL mais provável do sistema: é aqui que cabe
   * "estou em tratamento e não quero ser contatado". Quem registra deve resumir
   * o PEDIDO, não transcrever o desabafo — e o limite curto existe para lembrar
   * disso a cada uso.
   */
  @ApiPropertyOptional({ example: 'Pediu a exclusão dos dados de contato por e-mail em 20/08/2026' })
  @IsOptional()
  @IsString()
  @Length(3, 1000)
  descricao?: string;
}

class AtualizarDto {
  @ApiPropertyOptional({ enum: STATUS })
  @IsOptional()
  @IsEnum(STATUS)
  status?: (typeof STATUS)[number];

  @ApiPropertyOptional({ description: 'O que foi respondido ao titular' })
  @IsOptional()
  @IsString()
  @Length(3, 2000)
  resposta?: string;
}

/**
 * Central de Privacidade — a fila de pedidos do art. 18.
 *
 * ADMIN apenas, e sem rota pública: o titular não tem login e não há como
 * autenticá-lo, então uma página de autoatendimento seria oráculo de
 * enumeração de CPF. O canal segue sendo o e-mail da Política; o que estas
 * rotas dão é PROTOCOLO, PRAZO e PROVA DE ATENDIMENTO — que é o que faltava.
 */
@ApiTags('titular')
@ApiBearerAuth('jwt')
@Controller('titular/solicitacoes')
@Papeis('ADMIN')
/* Mesmo motivo do TitularController: atender um pedido aqui APAGA dado na base
   inteira, e ADMIN sozinho nao prova que quem chama e da operacao. */
@UseGuards(OrganizacaoInternaGuard)
export class SolicitacoesController {
  constructor(private readonly solicitacoes: SolicitacoesService) {}

  @Post()
  @HttpCode(201)
  /* Balde `medio`, que existe (config/throttlers.ts). Registro é trabalho
     humano: 30 por minuto é folga de sobra e ainda barra script. */
  @Throttle({ medio: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Registra um pedido de titular recebido pelo canal publicado',
    description:
      'Gera protocolo e prazo. O pedido chega por e-mail (a Política publica o canal); esta rota é ' +
      'como ele passa a existir para o sistema, com relógio correndo.',
  })
  registrar(@Body() dto: RegistrarDto) {
    return this.solicitacoes.registrar(dto);
  }

  @Get()
  @ApiOperation({ summary: 'A fila de pedidos, com o que vence primeiro no topo' })
  listar(@Query('status') status?: (typeof STATUS)[number]) {
    return this.solicitacoes.listar({ status: STATUS.includes(status!) ? status : undefined });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Um pedido' })
  porId(@Param('id', ParseUUIDPipe) id: string) {
    return this.solicitacoes.porId(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Anota andamento ou escreve a resposta' })
  atualizar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AtualizarDto) {
    return this.solicitacoes.atualizar(id, dto);
  }

  @Post(':id/atender')
  @HttpCode(200)
  @Throttle({ medio: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'EXECUTA o pedido e marca como atendido',
    description:
      'EXCLUSAO apaga os dados e retira o processo de circulação; ACESSO e PORTABILIDADE geram o ' +
      'relatório. Os demais tipos são atendidos à mão — o sistema recusa em vez de fingir automação.',
  })
  atender(@Param('id', ParseUUIDPipe) id: string, @UsuarioAtual() ator: UsuarioAutenticado) {
    return this.solicitacoes.atender(id, { id: ator.id, organizationId: ator.organizationId });
  }
}
