import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, Length } from 'class-validator';
import type { Papel } from '@miner/database';

export class CriarUsuarioDto {
  @ApiProperty({ example: 'Dra. Ana Silva' })
  @IsString()
  @Length(2, 120)
  nome!: string;

  @ApiProperty({ example: 'ana@escritorio.com.br' })
  @IsEmail()
  email!: string;

  /**
   * Só é CONSULTADO quando quem cria já é ADMIN da plataforma — ver
   * `papelParaNovo`. Para qualquer outro ator o campo é ignorado e o novo
   * usuário nasce com o papel de quem o criou, então mandá-lo não escala nada.
   */
  @ApiPropertyOptional({ enum: ['ADMIN', 'OPERADOR', 'CLIENTE'] })
  @IsOptional()
  @IsIn(['ADMIN', 'OPERADOR', 'CLIENTE'])
  papel?: Papel;

  @ApiPropertyOptional({ description: 'Pode administrar a equipe da própria organização' })
  @IsOptional()
  @IsBoolean()
  gestor?: boolean;
}

export class AtualizarUsuarioDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  gestor?: boolean;
}
