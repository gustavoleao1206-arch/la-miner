/**
 * A porta de ENVIO DE E-MAIL — o primeiro e-mail que o sistema manda.
 *
 * Propositalmente estreita: um método por PROPÓSITO, e não um `enviar(para,
 * assunto, html)` genérico. Método genérico vira caixa de spam interna — todo
 * módulo passa a mandar e-mail por conta própria e ninguém sabe mais o que o
 * sistema comunica. Cada propósito novo entra aqui com nome, e a revisão do PR
 * enxerga o que passou a ser enviado.
 *
 * Mesmo desenho da cobrança e do enriquecimento: porta + adaptadores + escolha
 * por env na fábrica do módulo.
 */

export const EMAIL_PORT = Symbol('EMAIL_PORT');

export interface ConfirmacaoCadastro {
  para: string;
  nomeResponsavel: string;
  nomeEscritorio: string;
  /** O link completo, já montado — o adaptador não decide URL de front. */
  link: string;
  /** Quanto tempo o link vale, para o texto do e-mail dizer a verdade. */
  validadeHoras: number;
}

export interface RedefinicaoSenha {
  para: string;
  nome: string;
  /** O link completo, já montado — o adaptador não decide URL de front. */
  link: string;
  /**
   * Validade em MINUTOS, e não em horas como a confirmação.
   *
   * A unidade denuncia a diferença de risco: confirmar e-mail ativa uma conta,
   * redefinir senha TOMA uma conta. Link de reset que dura o dia inteiro é uma
   * chave esquecida na fechadura — basta a caixa de entrada ficar aberta num
   * computador compartilhado.
   */
  validadeMinutos: number;
}

export interface EmailPort {
  readonly nome: string;
  enviarConfirmacaoCadastro(dados: ConfirmacaoCadastro): Promise<void>;
  enviarRedefinicaoSenha(dados: RedefinicaoSenha): Promise<void>;
}
