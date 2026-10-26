import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Os enums repetidos aqui, e não importados do banco: o DTO é o contrato da API,
 * e amarrá-lo ao enum do Prisma faria uma renomeação de coluna virar mudança
 * silenciosa de contrato para quem consome.
 */
export enum Modalidade {
  CESSAO = 'CESSAO',
  HONORARIOS = 'HONORARIOS',
}

export enum Origem {
  ESCRITORIO = 'ESCRITORIO',
  TITULAR = 'TITULAR',
}

export enum QuemPaga {
  ESCRITORIO = 'ESCRITORIO',
  TITULAR = 'TITULAR',
}

export enum Decisao {
  ACEITA = 'ACEITA',
  RECUSADA = 'RECUSADA',
  CANCELADA = 'CANCELADA',
}

/**
 * DINHEIRO COMO TEXTO, no contrato inteiro.
 *
 * `number` em JSON é float de dupla precisão: R$ 4.018.773,35 sobrevive, mas
 * centavo em conta encadeada não — e aqui a conta encadeada é o deságio. O
 * padrão aceita "300000" e "300000.00", e recusa vírgula: a formatação é da
 * tela, o transporte é sempre ponto.
 */
const DINHEIRO = /^\d{1,13}(\.\d{1,2})?$/;
const PERCENTUAL = /^\d{1,3}(\.\d{1,2})?$/;

export class CriarPropostaDto {
  @ApiProperty({ enum: Modalidade })
  @IsEnum(Modalidade)
  modalidade!: Modalidade;

  /** `TITULAR` é a CONTRAPROPOSTA — o número que o titular pôs na mesa. */
  @ApiPropertyOptional({ enum: Origem, default: Origem.ESCRITORIO })
  @IsOptional()
  @IsEnum(Origem)
  origem?: Origem;

  @ApiPropertyOptional({ description: 'Quanto se paga ao titular (só na CESSÃO)', example: '300000.00' })
  @IsOptional()
  @Matches(DINHEIRO, { message: 'Use ponto como separador decimal, sem símbolo de moeda.' })
  valorProposto?: string;

  @ApiPropertyOptional({ description: 'Percentual do escritório (só em HONORÁRIOS)', example: '20.00' })
  @IsOptional()
  @Matches(PERCENTUAL, { message: 'Percentual inválido.' })
  honorarioPercentual?: string;

  @ApiPropertyOptional({ example: '1500.00' })
  @IsOptional()
  @Matches(DINHEIRO, { message: 'Use ponto como separador decimal, sem símbolo de moeda.' })
  custasEstimadas?: string;

  @ApiPropertyOptional({ enum: QuemPaga, default: QuemPaga.ESCRITORIO })
  @IsOptional()
  @IsEnum(QuemPaga)
  custasPorContaDe?: QuemPaga;

  @ApiPropertyOptional({ description: 'Até quando a proposta vale (AAAA-MM-DD)' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validaAte?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  observacao?: string;
}

/**
 * O ajuste NÃO aceita `modalidade`.
 *
 * Trocar cessão por honorários no meio da rodada mudaria o significado de todos
 * os outros campos — o valor deixaria de ser quantia e viraria nada. Quem quer
 * mudar de caminho abre a rodada seguinte, que é o que preserva a anterior.
 */
export class AjustarPropostaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DINHEIRO, { message: 'Use ponto como separador decimal, sem símbolo de moeda.' })
  valorProposto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(PERCENTUAL, { message: 'Percentual inválido.' })
  honorarioPercentual?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DINHEIRO, { message: 'Use ponto como separador decimal, sem símbolo de moeda.' })
  custasEstimadas?: string;

  @ApiPropertyOptional({ enum: QuemPaga })
  @IsOptional()
  @IsEnum(QuemPaga)
  custasPorContaDe?: QuemPaga;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601({ strict: true })
  validaAte?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Length(0, 1000)
  observacao?: string;
}

export class DecisaoDto {
  @ApiProperty({ enum: Decisao })
  @IsEnum(Decisao)
  decisao!: Decisao;
}

/**
 * O cronograma pedido pela tela.
 *
 * O TOTAL não vem daqui: sai do `valorProposto` já gravado na proposta. Aceitar
 * um total no corpo criaria duas verdades sobre quanto se paga ao titular — e a
 * segunda a divergir seria a que ninguém lembra que existe.
 */
export class CronogramaDto {
  @ApiPropertyOptional({ description: 'Quanto sai no ato', example: '50000.00' })
  @IsOptional()
  @Matches(/^\d{1,13}(\.\d{1,2})?$/, {
    message: 'Use ponto como separador decimal, sem símbolo de moeda.',
  })
  entrada?: string;

  /**
   * Teto de 60 aqui, e NÃO no banco: é regra comercial, e regra comercial muda.
   * Sem teto nenhum, um zero a mais digitado geraria dez mil linhas — e a tabela
   * já é a que mais cresce do CRM (250 processos/mês por cliente, acumulando).
   */
  @ApiProperty({ minimum: 1, maximum: 60 })
  @IsInt()
  @Min(1)
  @Max(60)
  parcelas!: number;

  @ApiProperty({ description: 'AAAA-MM-DD da primeira parcela' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Use o formato AAAA-MM-DD.' })
  primeiroVencimento!: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 12 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  intervaloMeses?: number;
}

