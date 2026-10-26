import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConfirmacaoCadastro, EmailPort, RedefinicaoSenha } from './email.port';

/**
 * Envio via Resend (resend.com) — API REST simples, sem SDK.
 *
 * Escolhido como primeiro adaptador real por ser o de menor atrito: uma chave,
 * um POST, e o domínio verifica com DNS (SPF/DKIM) que o dono já administra.
 * Se o dono preferir outro provedor, entra como mais um adaptador aqui — a
 * porta não muda.
 *
 * ⚠ Falha de envio LANÇA. Quem decide o que fazer é o chamador: no cadastro, o
 * erro vira log e o usuário reenvia pela tela; engolir aqui esconderia um
 * domínio sem DNS configurado até o primeiro cliente reclamar.
 */
@Injectable()
export class ResendProvider implements EmailPort {
  readonly nome = 'RESEND';
  private readonly logger = new Logger(ResendProvider.name);

  constructor(private readonly config: ConfigService) {}

  async enviarConfirmacaoCadastro(dados: ConfirmacaoCadastro): Promise<void> {
    const resposta = await this.postar({
      to: [dados.para],
      subject: 'Confirme seu e-mail para ativar a conta',
      html: [
        /* ESCAPADOS: os dois nomes vêm do formulário PÚBLICO de cadastro.
           Até 20/08/2026 iam crus para dentro do HTML — cliente de e-mail
           moderno não executa script, mas uma tag solta ainda quebra o layout e
           o link, e "provavelmente não executa" não é argumento de segurança. */
        `<p>Olá, ${escapar(dados.nomeResponsavel)}.</p>`,
        `<p>Recebemos o cadastro do escritório <strong>${escapar(dados.nomeEscritorio)}</strong>.`,
        ' Para ativar a conta e seguir para o pagamento, confirme seu e-mail:</p>',
        `<p><a href="${dados.link}">Confirmar e-mail e continuar</a></p>`,
        `<p>O link vale por ${dados.validadeHoras} horas. Se você não fez este cadastro,`,
        ' ignore esta mensagem — nada será cobrado e a conta não será ativada.</p>',
      ].join(''),
    });
    await this.conferir(resposta);
  }

  async enviarRedefinicaoSenha(dados: RedefinicaoSenha): Promise<void> {
    const resposta = await this.postar({
      to: [dados.para],
      subject: 'Redefinição de senha — LEÃO AMORIM MINER',
      html: [
        `<p>Olá, ${escapar(dados.nome)}.</p>`,
        '<p>Recebemos um pedido para redefinir a senha da sua conta no LEÃO AMORIM MINER.</p>',
        `<p><a href="${dados.link}">Escolher uma nova senha</a></p>`,
        `<p>O link vale por ${dados.validadeMinutos} minutos e só pode ser usado UMA vez.</p>`,
        '<p><strong>Se não foi você</strong>, ignore esta mensagem: sua senha atual continua',
        ' valendo e nada muda. Vale trocá-la mesmo assim se desconfiar de algo.</p>',
      ].join(''),
    });
    await this.conferir(resposta);
  }

  /** O POST, igual para todo e-mail: só mudam destinatário, assunto e corpo. */
  private postar(corpo: { to: string[]; subject: string; html: string }) {
    const chave = this.config.getOrThrow<string>('RESEND_API_KEY');
    const remetente = this.config.getOrThrow<string>('EMAIL_REMETENTE');
    return fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `LEÃO AMORIM MINER <${remetente}>`, ...corpo }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async conferir(resposta: Response): Promise<void> {
    if (resposta.ok) return;
    const corpo = await resposta.text().catch(() => '');
    this.logger.error(`Resend respondeu ${resposta.status}: ${corpo.slice(0, 300)}`);
    throw new Error(`envio de e-mail falhou (${resposta.status})`);
  }
}

/**
 * O nome vem do cadastro, e o cadastro vem de quem digita: sem escapar, um nome
 * com `<script>` viaja para dentro do HTML do e-mail. Cliente de e-mail moderno
 * não executa script, mas a tag ainda quebra o layout e o link — e "o cliente
 * provavelmente não executa" não é argumento de segurança.
 */
function escapar(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
