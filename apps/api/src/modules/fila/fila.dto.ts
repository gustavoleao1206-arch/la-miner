import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Limite é OBRIGATÓRIO de propósito.
 *
 * Antes existia um default que consumia "tudo que coubesse no teto".
 * Um disparo acidental gastou 107 consultas reais — o custo de um clique
 * errado aqui é dinheiro. Agora quem chama precisa declarar quantas
 * consultas está autorizando.
 */
export class SincronizarDto {
  @ApiProperty({
    description: 'Quantas consultas serão autorizadas nesta rodada. Obrigatório.',
    minimum: 1,
    maximum: 5000,
    example: 50,
  })
  @IsInt({ message: 'Informe o limite de consultas desta rodada.' })
  @Min(1, { message: 'O limite deve ser ao menos 1.' })
  @Max(5000, { message: 'O limite máximo por rodada é 5000.' })
  limite!: number;
}

export class PrevisaoDto {
  @ApiProperty({ description: 'Quantas consultas seriam feitas' })
  quantidade!: number;

  @ApiProperty({ description: 'Quantas pessoas estão elegíveis no total' })
  elegiveis!: number;

  @ApiProperty({ description: 'Teto restante hoje' })
  tetoRestante!: number;

  @ApiProperty({ description: 'Custo estimado em R$ (null se o preço não estiver configurado)' })
  custoEstimado!: number | null;

  @ApiProperty({ description: 'Provider que será usado' })
  provider!: string;

  @ApiProperty({ description: 'true = nenhuma consulta real será feita' })
  dryRun!: boolean;

  @ApiProperty({ description: 'Motivo, quando a quantidade for menor que o pedido' })
  observacao?: string;
}

/**
 * Reconferência do veredito de nome. NÃO consulta o provedor e NÃO gasta
 * crédito — relê o payload já guardado em `Enriquecimento.dadosBrutos`.
 *
 * `simular` ausente significa SIMULAR, e só o `false` explícito grava. Mesma
 * direção de erro do teto e do dry-run: variável esquecida não muda dado.
 */
export class ReconferirDto {
  @ApiProperty({
    description: 'false grava as mudanças. Ausente ou true apenas simula.',
    required: false,
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'Use true para simular ou false para aplicar.' })
  simular?: boolean;
}
