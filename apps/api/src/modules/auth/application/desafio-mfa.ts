import { createHmac } from 'node:crypto';

/**
 * O bilhete que liga o passo 1 (senha) ao passo 2 (código) do login.
 *
 * ── O PERIGO DESTE OBJETO ──
 *
 * Ele é emitido para alguém que ACERTOU A SENHA e ainda NÃO provou o segundo
 * fator. Se um desafio puder ser usado como access token, o MFA vira decoração:
 * bastaria ignorar a segunda tela e chamar a API com o bilhete.
 *
 * E o risco não é teórico. A `JwtStrategy` autentica por `sub` e relê o usuário
 * do banco — ela nem olha os outros campos. Um JWT assinado com o segredo de
 * acesso contendo só `{ sub }` seria aceito como sessão completa.
 *
 * Duas barreiras, independentes:
 *
 *  1. SEGREDO DERIVADO. O desafio é assinado com HMAC(JWT_ACCESS_SECRET,
 *     'mfa-desafio'), que não é o segredo de acesso. A verificação da
 *     `JwtStrategy` falha na ASSINATURA — antes de qualquer lógica.
 *
 *  2. CLAIM `typ: 'mfa'`, que a `JwtStrategy` recusa explicitamente. Redundante
 *     de propósito: se alguém um dia "simplificar" a derivação e passar a
 *     assinar com o segredo de acesso, a segunda barreira ainda segura.
 *
 * A derivação também evita mais uma variável de ambiente para o dono gerenciar,
 * sem reusar chave entre propósitos diferentes.
 */

export const TIPO_DESAFIO = 'mfa';

/**
 * Cinco minutos: tempo de pegar o telefone, abrir o app e digitar — e não muito
 * mais. É a janela em que uma senha correta, sozinha, ainda vale alguma coisa.
 */
export const DESAFIO_TTL = '5m';

export function segredoDoDesafio(segredoDeAcesso: string): string {
  return createHmac('sha256', segredoDeAcesso).update('mfa-desafio').digest('hex');
}

export interface PayloadDesafio {
  sub: string;
  typ: typeof TIPO_DESAFIO;
}
