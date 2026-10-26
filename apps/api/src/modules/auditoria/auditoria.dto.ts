import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsISO8601, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

/** Valores que `ConsultaCliente.tipo` recebe hoje (o schema guarda String livre). */
export const TIPOS_CONSULTA = ['CPF', 'NOME', 'PROCESSO', 'CIDADE', 'UF'] as const;

/** Teto de página. A tabela de auditoria só cresce; sem teto, um `porPagina=100000`
 *  derruba a API carregando anos de trilha numa resposta só. */
export const POR_PAGINA_MAX = 100;

/** Mantém a série diária do /resumo limitada — 180 pontos já é mais do que um gráfico lê. */
export const PERIODO_MAX_DIAS = 180;

const soDigitos = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null ? value : String(value).replace(/\D/g, '');

/* Query string não tem tipo: `?somenteContatoExibido=true` chega como a string "true".
   O enableImplicitConversion global converte pelo design:type, mas Boolean('false')
   é `true` — o filtro faria o oposto do pedido. Por isso a conversão é explícita. */
const paraBooleano = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null ? value : value === true || value === 'true' || value === '1';

/** Filtros comuns às listagens e agregados da trilha. */
export class PeriodoQueryDto {
  @ApiPropertyOptional({ description: 'Início do período (ISO 8601). Aceita AAAA-MM-DD.' })
  @IsOptional()
  @IsISO8601({}, { message: 'Data inicial inválida. Use AAAA-MM-DD.' })
  de?: string;

  @ApiPropertyOptional({ description: 'Fim do período (ISO 8601). Aceita AAAA-MM-DD.' })
  @IsOptional()
  @IsISO8601({}, { message: 'Data final inválida. Use AAAA-MM-DD.' })
  ate?: string;
}

export class ConsultasQueryDto extends PeriodoQueryDto {
  @ApiPropertyOptional({ description: 'Filtra por um usuário específico' })
  @IsOptional()
  @IsUUID('4', { message: 'userId inválido.' })
  userId?: string;

  @ApiPropertyOptional({ description: 'CPF consultado, somente dígitos', example: '12345678901' })
  @IsOptional()
  @Transform(soDigitos)
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos.' })
  cpfConsultado?: string;

  @ApiPropertyOptional({ enum: TIPOS_CONSULTA })
  @IsOptional()
  @IsIn(TIPOS_CONSULTA, { message: `tipo deve ser um de: ${TIPOS_CONSULTA.join(', ')}.` })
  tipo?: string;

  @ApiPropertyOptional({
    description: 'Só as consultas em que o contato do titular foi efetivamente exibido',
  })
  @IsOptional()
  @Transform(paraBooleano)
  @IsBoolean()
  somenteContatoExibido?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsInt({ message: 'pagina deve ser um número inteiro.' })
  @Min(1, { message: 'pagina começa em 1.' })
  pagina: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: POR_PAGINA_MAX })
  @IsInt({ message: 'porPagina deve ser um número inteiro.' })
  @Min(1)
  @Max(POR_PAGINA_MAX, { message: `porPagina não pode passar de ${POR_PAGINA_MAX}.` })
  porPagina: number = 20;
}

export class ResumoQueryDto extends PeriodoQueryDto {}

/**
 * CPF da trilha do titular — vai no CORPO, e não no caminho da URL.
 *
 * URL aparece no log de acesso do proxy, que não é nosso e não se apaga sob
 * pedido do titular. Corpo, não: o `redact` do pino já censura `req.body.cpf`.
 * A rota que expõe TUDO sobre uma pessoa é a que menos pode deixar rastro.
 */
export class TrilhaCpfDto {
  @ApiPropertyOptional({ description: 'CPF com ou sem máscara', example: '12345678901' })
  @Transform(soDigitos)
  @Matches(/^\d{11}$/, { message: 'CPF deve ter 11 dígitos.' })
  cpf!: string;
}
