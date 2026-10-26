import { Injectable, Logger } from '@nestjs/common';
import type { ConfirmacaoCadastro, EmailPort, RedefinicaoSenha } from './email.port';

/**
 * O provedor de MENTIRA — desenvolvimento e testes.
 *
 * Não manda nada: imprime o link no log, em WARN, para o desenvolvedor clicar.
 * WARN e não debug de propósito — quem está testando o fluxo precisa ACHAR o
 * link sem caçar nível de log.
 *
 * A trava que o impede em produção mora na fábrica do módulo e no zod
 * (EMAIL_PROVIDER=fake + CONFIRMACAO_EMAIL_ATIVA=true + produção = boot
 * recusado): confirmação obrigatória com e-mail de mentira seria um cadastro
 * que NINGUÉM consegue confirmar — a porta trancada por dentro.
 */
@Injectable()
export class EmailFakeProvider implements EmailPort {
  readonly nome = 'FAKE';
  private readonly logger = new Logger(EmailFakeProvider.name);

  async enviarConfirmacaoCadastro(dados: ConfirmacaoCadastro): Promise<void> {
    this.logger.warn(
      `E-MAIL FAKE (nada foi enviado) — confirmação para ${dados.para}: ${dados.link}`,
    );
  }

  async enviarRedefinicaoSenha(dados: RedefinicaoSenha): Promise<void> {
    this.logger.warn(
      `E-MAIL FAKE (nada foi enviado) — redefinição de senha para ${dados.para}: ${dados.link}`,
    );
  }
}
