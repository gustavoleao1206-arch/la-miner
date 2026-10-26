import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsUUID, MinLength, MaxLength, Matches } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  @ApiProperty({ example: 'admin@exemplo.com.br' })
  @IsEmail({}, { message: 'E-mail inválido' })
  @Transform(({ value }) => String(value ?? '').toLowerCase().trim())
  email!: string;

  @ApiProperty({ example: 'senha-forte' })
  @IsString()
  @MinLength(8, { message: 'Senha deve ter ao menos 8 caracteres' })
  @MaxLength(128)
  senha!: string;
}

/* RefreshDto foi removido: /auth/refresh e /auth/logout não recebem mais corpo.
   O refresh token entra pelo cookie httpOnly `miner_refresh`. Aceitar também
   pelo corpo — como rede de compatibilidade — anularia o ganho: um XSS voltaria
   a poder usar um token roubado, que é exatamente o que o cookie impede. */

export class TrocarSenhaDto {
  @ApiProperty()
  @IsString()
  senhaAtual!: string;

  @ApiProperty({
    description: 'Mínimo 10 caracteres, com letra maiúscula, minúscula e número.',
  })
  @IsString()
  @MinLength(10, { message: 'A nova senha deve ter ao menos 10 caracteres' })
  @MaxLength(128)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message: 'A nova senha precisa conter letra maiúscula, minúscula e número',
  })
  senhaNova!: string;
}

/**
 * O que o cliente RECEBE. Sem `refreshToken`, de propósito: ele vai no cookie
 * httpOnly `miner_refresh` e o navegador o devolve sozinho nas rotas de auth.
 * Se este campo voltar ao corpo, o JavaScript volta a enxergá-lo — e o motivo
 * inteiro do B3 se desfaz.
 */
export class TokensRespostaDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ description: 'Validade do access token, em segundos' })
  expiraEm!: number;
}

/**
 * A resposta do login, que agora tem duas formas.
 *
 * Com `mfaRequerido: true` NÃO vem token nem cookie: vem o desafio, que o front
 * devolve em `/auth/mfa/verificar` junto com o código. É o campo que a tela deve
 * inspecionar — não a ausência de `accessToken`.
 */
export class LoginRespostaDto {
  @ApiProperty({ description: 'true = falta o segundo fator; não há sessão ainda' })
  mfaRequerido!: boolean;

  @ApiProperty({ required: false })
  accessToken?: string;

  @ApiProperty({ required: false, description: 'Validade do access token, em segundos' })
  expiraEm?: number;

  @ApiProperty({ required: false, description: 'Válido por 5 minutos' })
  desafio?: string;
}

export class VerificarMfaDto {
  @ApiProperty({ description: 'O desafio devolvido pelo /auth/login' })
  @IsString()
  desafio!: string;

  @ApiProperty({ description: 'Código de 6 dígitos do app OU um código de recuperação' })
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  codigo!: string;
}

export class CodigoMfaDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(6)
  @MaxLength(32)
  codigo!: string;
}

export class DesativarMfaDto {
  @ApiProperty({ description: 'A SENHA, não um código — ver a nota em MfaService.desativar' })
  @IsString()
  senha!: string;
}

export class ZerarMfaDto {
  @ApiProperty({
    description: 'Id do usuário a desbloquear. Precisa ser da MESMA organização do admin.',
    format: 'uuid',
  })
  /* Normaliza a caixa ANTES de validar. `@IsUUID` aceita maiúsculas, e o id em
     caixa alta já foi o caminho para um ADMIN escapar da trava do próprio id —
     ver a nota em `MfaService.zerarDeOutroUsuario`. A defesa real é comparar o
     id que o banco devolve; isto aqui é a segunda camada. */
  @Transform(({ value }) => String(value ?? '').toLowerCase().trim())
  @IsUUID('4', { message: 'usuarioId deve ser um UUID' })
  usuarioId!: string;

  @ApiProperty({
    description:
      'A senha de QUEM EXECUTA, não a do alvo. Remover o segundo fator de outra ' +
      'pessoa não pode sair de uma sessão aberta e desatendida.',
  })
  @IsString()
  senha!: string;
}

/* ── Esqueci minha senha ── */

export class SolicitarRedefinicaoDto {
  @ApiProperty({ example: 'contato@escritorio.com.br' })
  @IsEmail({}, { message: 'E-mail inválido' })
  @Transform(({ value }) => String(value ?? '').toLowerCase().trim())
  email!: string;
}

export class RedefinirSenhaDto {
  @ApiProperty({ description: 'O token do link recebido por e-mail.' })
  @IsString()
  @MinLength(16, { message: 'Link inválido.' })
  @MaxLength(128)
  token!: string;

  /**
   * 12 caracteres, SEM exigência de composição — a mesma regra do cadastro
   * público, e pela razão que está escrita lá: "uma maiúscula e um símbolo"
   * empurra as pessoas para `Senha@123`, que é pior que uma frase longa.
   *
   * (O `trocar-senha` autenticado ainda pede 10 com composição. As duas réguas
   * convivem no repositório desde antes disto; unificar é mexer em fluxo que
   * hoje funciona, e fica registrado aqui para ser decidido de propósito.)
   */
  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12, { message: 'A senha precisa de ao menos 12 caracteres.' })
  @MaxLength(200)
  senha!: string;
}
