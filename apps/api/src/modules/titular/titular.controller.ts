import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches } from 'class-validator';

import { Papeis, UsuarioAtual, type UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { OrganizacaoInternaGuard } from '../../common/guards/organizacao-interna.guard';
import { TitularService } from './titular.service';

const soDigitos = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null ? value : String(value).replace(/\D/g, '');

class CpfDto {
  @ApiProperty({ description: 'CPF do titular, com ou sem máscara', example: '12345678901' })
  @Transform(soDigitos)
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos.' })
  cpf!: string;
}

class ExcluirDto extends CpfDto {
  /**
   * Por que a exclusão está sendo feita. Vai para a coluna `exclusaoMotivo` e
   * é o que se apresenta à ANPD junto com a data — "apagamos" sem o pedido
   * registrado não demonstra atendimento de nada.
   */
  @ApiPropertyOptional({ example: 'Pedido do titular por e-mail em 10/08/2026' })
  @IsOptional()
  @IsString()
  @Length(3, 500)
  motivo?: string;
}

/**
 * Direitos do titular (LGPD art. 18).
 *
 * ── POST, E NÃO DELETE ──
 *
 * O verbo natural seria DELETE, mas o CPF iria na URL — e URL entra no log de
 * acesso do proxy, que não é nosso e não se apaga a pedido de ninguém. Seria
 * irônico: a rota que existe para apagar o dado do titular seria a que o
 * gravaria num lugar fora do nosso alcance. O corpo é censurado pelo logger
 * (`req.body.cpf`), então é por ele que o CPF entra. Mesma escolha do B2.
 *
 * ADMIN apenas: exclusão é irreversível e responde a um pedido formal.
 */
@ApiTags('titular')
@ApiBearerAuth('jwt')
@Controller('titular')
@Papeis('ADMIN')
/* ADMIN nao basta: `ADMIN` e coluna de `User`, e `User` pertence a uma
   organizacao qualquer. Estas rotas leem e APAGAM na base inteira de titulares,
   entao exigem tambem pertencer a operacao. Ver o guard. */
@UseGuards(OrganizacaoInternaGuard)
export class TitularController {
  constructor(private readonly titular: TitularService) {}

  @Post('situacao')
  @HttpCode(200)
  @ApiOperation({
    summary: 'O que a base tem sobre um CPF',
    description:
      'Consulta, apesar do verbo: o CPF vai no corpo para não aparecer na URL nem no log de acesso.',
  })
  situacao(@Body() dto: CpfDto) {
    return this.titular.situacao(dto.cpf);
  }

  @Post('dados')
  @HttpCode(200)
  /* Balde `medio`, que EXISTE. `@Throttle` só sobrescreve o balde que nomeia, e
     um nome inexistente vira metadado morto sem erro nenhum — foi assim que a
     proteção de uma rota já ficou só no comentário. Os baldes desta casa são
     `curto` e `medio` (config/throttlers.ts).
     10 por minuto: atender pedido de titular é trabalho humano, não varredura. */
  @Throttle({ medio: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Tudo o que a base tem sobre um CPF (LGPD art. 18, II e V)',
    description:
      'Consulta, apesar do verbo: o CPF vai no corpo para não aparecer na URL nem no log de acesso. ' +
      'Devolve identificação, contatos, histórico de consultas ao provedor, processos e — art. 18, VII — ' +
      'quais escritórios receberam cada processo. NÃO devolve a resposta crua do provedor nem o texto ' +
      'livre escrito pelo escritório assinante, que é controlador daquele conteúdo.',
  })
  dados(@Body() dto: CpfDto, @UsuarioAtual() ator: UsuarioAutenticado) {
    return this.titular.dados(dto.cpf, { id: ator.id, organizationId: ator.organizationId });
  }

  @Post('excluir')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Apaga os dados de contato do titular (LGPD art. 18, VI)',
    description:
      'IRREVERSÍVEL. Apaga telefones, e-mails, endereços e as respostas cruas do provedor, e impede ' +
      'que o enriquecimento volte a consultar este CPF. TIRA DE CIRCULAÇÃO: revoga as liberações do ' +
      'processo em todas as organizações e impede que ele volte a ser sorteado. Preserva CPF e nome ' +
      '(vêm do precatório, que é ato público) e a trilha de auditoria (accountability).',
  })
  excluir(@Body() dto: ExcluirDto, @UsuarioAtual('id') autorId: string) {
    return this.titular.excluir(dto.cpf, dto.motivo ?? 'pedido do titular', autorId);
  }
}
