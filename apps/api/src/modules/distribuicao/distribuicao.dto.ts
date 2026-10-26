import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';

export class CriarPlanoDto {
  @ApiProperty({ example: 'Essencial 250' })
  @IsString()
  @Length(2, 80)
  nome!: string;

  @ApiPropertyOptional({ example: '250 processos novos por mês' })
  @IsOptional()
  @IsString()
  @Length(0, 300)
  descricao?: string;

  @ApiProperty({ example: 250, description: 'Processos NOVOS liberados a cada ciclo' })
  @IsInt()
  @Min(1)
  processosPorCiclo!: number;

  @ApiProperty({ example: 1990.0, description: 'Preço por ciclo, em reais' })
  @IsNumber()
  @Min(0)
  preco!: number;

  @ApiPropertyOptional({ example: 1, description: 'Meses entre renovações (1 = mensal)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  intervaloMeses?: number;
}

export class CriarClienteDto {
  @ApiProperty({ example: 'Advocacia Silva & Souza' })
  @IsString()
  @Length(2, 120)
  nome!: string;

  /** Só dígitos. Opcional porque nem todo cliente entra com CNPJ no cadastro. */
  @ApiPropertyOptional({ example: '12345678000199' })
  @IsOptional()
  @IsString()
  @Length(14, 14)
  cnpj?: string;

  @ApiProperty({ description: 'Plano que o cliente assina' })
  @IsUUID()
  planoId!: string;

  /**
   * E-mail do primeiro usuário do cliente. Opcional, mas sem ele o cliente NÃO
   * consegue entrar — a org existe, recebe lote, e não tem quem a acesse.
   * A senha é GERADA pelo sistema e devolvida uma única vez na resposta.
   */
  @ApiPropertyOptional({ example: 'socio@exemplo.com.br' })
  @IsOptional()
  @IsEmail()
  emailUsuario?: string;

  @ApiPropertyOptional({ example: 'Dra. Ana Silva' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  nomeUsuario?: string;
}
