import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

import { documentoValido, telefoneValido } from './documento';

/**
 * Liga um validador puro ao class-validator.
 *
 * A regra continua morando em `documento.ts`, testável sem instanciar DTO nem
 * subir o Nest; aqui só se declara ONDE ela se aplica. Reescrever a conta do
 * dígito verificador dentro do decorator criaria uma segunda cópia — e a que
 * divergisse seria a que roda de verdade.
 */
function ChecarCom(
  nome: string,
  valida: (v: string) => boolean,
  mensagem: string,
  opcoes?: ValidationOptions,
) {
  return (alvo: object, propriedade: string) =>
    registerDecorator({
      name: nome,
      target: alvo.constructor,
      propertyName: propriedade,
      options: { message: mensagem, ...opcoes },
      validator: {
        validate: (valor: unknown) => typeof valor === 'string' && valida(valor),
      },
    });
}

export class CadastroDto {
  @ApiProperty({ example: 'Silva & Costa Advogados' })
  @IsString()
  @MinLength(3, { message: 'Informe o nome do escritório.' })
  @MaxLength(120)
  nomeEscritorio!: string;

  @ApiProperty({ example: '11.222.333/0001-81', description: 'CNPJ do escritório ou CPF do titular' })
  @IsString()
  @ChecarCom(
    'documentoBr',
    documentoValido,
    'CNPJ ou CPF inválido — confira os números digitados.',
  )
  documento!: string;

  @ApiProperty({ example: '(81) 99999-8888' })
  @IsString()
  @ChecarCom('telefoneBr', telefoneValido, 'Telefone inválido. Informe DDD e número.')
  telefone!: string;

  @ApiProperty({ example: 'Ana Silva' })
  @IsString()
  @MinLength(3, { message: 'Informe o nome do responsável.' })
  @MaxLength(120)
  nomeResponsavel!: string;

  @ApiProperty({ example: 'ana@exemplo.adv.br' })
  /* O MESMO `@IsEmail` do login, e de propósito: um cadastro que aceitasse
     endereço sem TLD válido criaria a conta e o usuário nunca conseguiria
     entrar — foi exatamente o que aconteceu com `miner@admin`, que virou um
     usuário órfão no banco de produção. */
  @IsEmail({}, { message: 'E-mail inválido.' })
  @MaxLength(160)
  email!: string;

  @ApiProperty({ minLength: 12 })
  /* 12 caracteres, o mesmo piso do `criar-admin`. Comprimento é a única
     exigência: regra de "uma maiúscula, um símbolo" empurra o usuário para
     `Senha@123`, que é pior que uma frase longa. */
  @IsString()
  @MinLength(12, { message: 'A senha precisa de ao menos 12 caracteres.' })
  @MaxLength(200)
  senha!: string;

  @ApiProperty({ description: 'Id do plano escolhido, vindo de GET /planos' })
  @IsUUID('4', { message: 'Plano inválido.' })
  planoId!: string;
}

export class ConfirmarEmailDto {
  @ApiProperty({ description: 'O token do link recebido por e-mail.' })
  @IsString()
  @MinLength(16, { message: 'Token inválido.' })
  @MaxLength(128)
  token!: string;
}

export class ReenviarConfirmacaoDto {
  @ApiProperty({ example: 'ana@escritorio.com.br' })
  @IsEmail({}, { message: 'Informe um e-mail válido.' })
  email!: string;
}
