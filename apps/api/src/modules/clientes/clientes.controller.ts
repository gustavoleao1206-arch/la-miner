import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { Papeis, UsuarioAtual } from '../../common/decorators/papeis.decorator';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { ClientesService } from './clientes.service';

class ConfirmarExclusaoDto {
  /**
   * O CNPJ da conta, digitado à mão (com ou sem máscara). Conta sem documento
   * usa o nome exato. Não é enfeite: é o que separa "cliquei na linha errada"
   * de "eu quis apagar ESTA conta".
   */
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  confirmacao!: string;
}

@ApiTags('clientes')
@Controller('clientes')
export class ClientesController {
  constructor(private readonly clientes: ClientesService) {}

  @Get(':id/exclusao')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @ApiOperation({ summary: 'O que aconteceria ao excluir esta conta, e por quê' })
  async sondar(
    @Param('id', ParseUUIDPipe) organizationId: string,
    @UsuarioAtual() ator: UsuarioAutenticado,
  ) {
    return this.clientes.sondar(organizationId, ator.organizationId);
  }

  /**
   * DELETE de verdade — e o corpo é OBRIGATÓRIO.
   *
   * Um DELETE sem corpo seria disparável por qualquer link ou histórico de
   * navegador. Exigir o documento no corpo faz da chamada um ato deliberado,
   * não um efeito colateral de alguém apertando F5 na hora errada.
   */
  @Delete(':id')
  @ApiBearerAuth('jwt')
  @Papeis('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exclui (ou anonimiza) a conta de um cliente' })
  @ApiResponse({ status: 200, description: '`modo` diz o que de fato aconteceu.' })
  @ApiResponse({ status: 400, description: 'Confirmação ausente ou diferente do documento.' })
  @ApiResponse({ status: 403, description: 'Organização interna, ou a própria do administrador.' })
  async excluir(
    @Param('id', ParseUUIDPipe) organizationId: string,
    @Body() dto: ConfirmarExclusaoDto,
    @UsuarioAtual() ator: UsuarioAutenticado,
    @Req() req: Request,
  ) {
    return this.clientes.excluir(organizationId, dto.confirmacao, {
      userId: ator.id,
      organizationId: ator.organizationId,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }
}
