import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';

import { PrismaService } from '../../prisma/prisma.service';
import { CobrancaService } from '../cobranca/cobranca.service';
import { EMAIL_PORT, type EmailPort } from '../email/email.port';
import { apenasDigitos } from './documento';
import type { CadastroDto } from './cadastro.dto';

/** Os mesmos parâmetros do AuthService — OWASP 2024 (19 MiB, 2 iterações). */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/**
 * O cadastro público: a primeira porta do sistema que qualquer pessoa da
 * internet consegue empurrar.
 *
 * ── A ORDEM DAS ESCRITAS É A DECISÃO PRINCIPAL ──
 *
 * Conta primeiro, cobrança depois. Se o gateway falhar, sobra uma organização
 * com assinatura PENDENTE e sem fatura — visível, reconciliável, e o cliente
 * consegue entrar, ver o 402 e retomar o checkout. Na ordem inversa sobraria
 * uma cobrança no Asaas sem conta nenhuma deste lado: o cliente pagaria e não
 * teria onde acessar, que é o pior desfecho possível de uma venda.
 *
 * É a mesma regra que o `emitirFatura` já aplica entre fatura e gateway, e ela
 * vale pelo mesmo motivo: entre duas metades, sobrar a NOSSA é sempre melhor,
 * porque é a que conseguimos consertar.
 */
@Injectable()
export class CadastroService {
  private readonly logger = new Logger(CadastroService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cobranca: CobrancaService,
    private readonly config: ConfigService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  /** A exigência de confirmação está ligada? Desligada = comportamento antigo. */
  private get confirmacaoAtiva(): boolean {
    return this.config.get<boolean>('CONFIRMACAO_EMAIL_ATIVA', false);
  }

  private get validadeHoras(): number {
    return this.config.get<number>('CONFIRMACAO_EMAIL_VALIDADE_HORAS', 48);
  }

  /** Token em claro para o LINK; o banco só guarda o SHA-256, como o refresh. */
  private gerarTokenDeConfirmacao() {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      hash: createHash('sha256').update(token).digest('hex'),
      expiraEm: new Date(Date.now() + this.validadeHoras * 3_600_000),
    };
  }

  private linkDeConfirmacao(token: string): string {
    const base = this.config.get<string>('WEB_URL', 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/confirmar-email?token=${token}`;
  }

  /** Envia o e-mail SEM propagar falha: quem não recebeu reenvia pela tela. */
  private async enviarConfirmacao(dados: {
    para: string;
    nomeResponsavel: string;
    nomeEscritorio: string;
    token: string;
  }): Promise<void> {
    try {
      await this.email.enviarConfirmacaoCadastro({
        para: dados.para,
        nomeResponsavel: dados.nomeResponsavel,
        nomeEscritorio: dados.nomeEscritorio,
        link: this.linkDeConfirmacao(dados.token),
        validadeHoras: this.validadeHoras,
      });
    } catch (e) {
      /* A conta EXISTE e o reenvio existe. Propagar faria o visitante achar que
         o cadastro falhou, tentar de novo e bater no 409 — o mesmo raciocínio
         da cobrança que falha, logo abaixo. */
      this.logger.error(`Cadastro criado, mas o e-mail de confirmação falhou: ${(e as Error).message}`);
    }
  }

  async cadastrar(dados: CadastroDto) {
    const email = dados.email.toLowerCase().trim();
    const documento = apenasDigitos(dados.documento);
    const telefone = apenasDigitos(dados.telefone);

    /* O plano vem do cliente, mas o PREÇO não: só o id viaja, e a fatura é
       emitida relendo `planos.preco` do banco. Conferir aqui que ele existe e
       está ATIVO evita criar assinatura órfã apontando para um plano que saiu
       de catálogo — ou para um uuid inventado. */
    const plano = await this.prisma.plano.findFirst({
      where: { id: dados.planoId, ativo: true },
      select: { id: true },
    });
    if (!plano) {
      throw new BadRequestException('Plano indisponível. Recarregue a página e tente de novo.');
    }

    /**
     * ── CADASTRO VENCIDO NÃO TRANCA NINGUÉM ──
     *
     * Antes dos 409: se o e-mail ou o CNPJ esbarram num cadastro que NUNCA foi
     * confirmado e cujo link já venceu, aquele registro é casca vazia — nome
     * digitado, nada pago, ninguém entrou. Reciclamos em vez de recusar.
     *
     * Sem isto, a confirmação obrigatória criaria a pior armadilha do produto:
     * quem digita o próprio e-mail ERRADO cria uma conta que nunca será
     * confirmada e que bloqueia o próprio CNPJ com 409 para sempre — e a
     * mensagem manda falar com o suporte, que não existe às 23h de um sábado.
     */
    const reciclado = await this.reciclarCadastroVencido(email, documento, dados, telefone);
    if (reciclado) return reciclado;

    /* E-mail é @unique GLOBAL. Sem esta checagem, o cadastro duplicado voltaria
       como violação de constraint — um 500 que parece defeito do sistema para
       quem só esqueceu que já tem conta. */
    const emailEmUso = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, emailConfirmadoEm: true, emailConfirmacaoExpiraEm: true },
    });
    if (emailEmUso) {
      throw new ConflictException(
        emailEmUso.emailConfirmadoEm === null
          ? 'Já existe um cadastro aguardando confirmação para este e-mail. Verifique a caixa ' +
            'de entrada (e o spam) — dá para reenviar o link na tela de confirmação.'
          : 'Já existe uma conta com este e-mail. Entre pelo login ou use outro endereço.',
      );
    }

    const documentoEmUso = await this.prisma.organization.findUnique({
      where: { cnpj: documento },
      select: { id: true },
    });
    if (documentoEmUso) {
      throw new ConflictException(
        'Já existe uma assinatura para este CNPJ/CPF. Fale com a equipe se precisar de outro acesso.',
      );
    }

    /* Hash ANTES de abrir transação: argon2 leva ~100 ms de propósito, e segurar
       uma transação aberta nesse tempo prende conexão do pool à toa. Mesmo
       cuidado do UsuariosService. */
    const senhaHash = await hash(dados.senha, ARGON2);
    const confirmacao = this.confirmacaoAtiva ? this.gerarTokenDeConfirmacao() : null;

    const organizationId = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          nome: dados.nomeEscritorio.trim(),
          cnpj: documento,
          telefone,
          tipo: 'CLIENTE',
        },
        select: { id: true },
      });

      await tx.user.create({
        data: {
          organizationId: org.id,
          email,
          senhaHash,
          nome: dados.nomeResponsavel.trim(),
          /* Com a exigência LIGADA, nasce sem confirmação e com o token do
             link; desligada, nasce confirmado — comportamento idêntico ao de
             antes desta funcionalidade. Quem é convidado pela equipe também
             nasce confirmado (usuarios.service), porque o gestor entrega a
             credencial em mãos. */
          ...(confirmacao
            ? {
                emailConfirmacaoTokenHash: confirmacao.hash,
                emailConfirmacaoExpiraEm: confirmacao.expiraEm,
              }
            : { emailConfirmadoEm: new Date() }),
          /* CLIENTE, nunca ADMIN: `papel` decide o que se alcança na
             PLATAFORMA, e um ADMIN aqui enxergaria os outros assinantes.
             `gestor` é o outro eixo — quem manda na própria empresa —, e o
             primeiro usuário é ele por definição: precisa convidar a equipe e
             ver a própria assinatura. */
          papel: 'CLIENTE',
          gestor: true,
        },
      });

      await tx.assinatura.create({
        data: {
          organizationId: org.id,
          planoId: plano.id,
          /* PENDENTE até o webhook confirmar. É o estado que o
             AssinaturaAtivaGuard barra com 402 — o "paga primeiro, depois
             acessa" só é verdade porque esta linha nasce assim. */
          status: 'PENDENTE',
        },
      });

      return org.id;
    });

    this.logger.log(`Organização cadastrada pelo site: ${organizationId}`);

    /**
     * ── COM A EXIGÊNCIA LIGADA, A COBRANÇA NÃO NASCE AQUI ──
     *
     * "Não confirmou, não paga" não é um guard: é esta ORDEM. O link de
     * pagamento só passa a existir em `confirmarEmail` — antes disso não há
     * cobrança no gateway, então não há como pagar com o e-mail errado e
     * virar chamado de suporte. O e-mail com o link de confirmação sai fora
     * da transação, como a cobrança: falha vira log + reenvio, nunca 500.
     */
    if (confirmacao) {
      await this.enviarConfirmacao({
        para: email,
        nomeResponsavel: dados.nomeResponsavel.trim(),
        nomeEscritorio: dados.nomeEscritorio.trim(),
        token: confirmacao.token,
      });
      return {
        organizationId,
        email,
        confirmacaoPendente: true as const,
        faturaId: null,
        urlPagamento: null,
      };
    }

    /* ── A cobrança, fora da transação ──
       Chamada de rede não entra em transação de banco: o Asaas lento seguraria
       a conexão, e um erro dele desfaria escritas que devem sobreviver. */
    let urlPagamento: string | null = null;
    let faturaId: string | null = null;
    try {
      const fatura = await this.cobranca.emitirFatura({ organizationId });
      faturaId = fatura.faturaId ?? null;
      urlPagamento = fatura.urlPagamento ?? null;
    } catch (e) {
      /* Não propaga: a conta EXISTE e é boa. Devolver erro aqui faria o
         visitante achar que o cadastro falhou e tentar de novo — e o segundo
         cadastro bateria no 409 de e-mail em uso, deixando-o preso sem
         entender nada. Ele entra, vê o 402 e retoma o pagamento. */
      this.logger.error(
        `Conta ${organizationId} criada, mas a cobrança falhou: ${(e as Error).message}`,
      );
    }

    return {
      organizationId,
      email,
      confirmacaoPendente: false as const,
      faturaId,
      /* Nulo em dois casos diferentes, e a tela precisa tratar os dois:
         provedor manual (que não emite link, por desenho) e falha do gateway.
         Em ambos o caminho é o mesmo — entrar e retomar pela assinatura. */
      urlPagamento,
    };
  }

  /**
   * Recicla um cadastro NUNCA confirmado e com o link VENCIDO.
   *
   * As condições são estreitas de propósito, e cada uma é uma trava:
   *  - usuário GESTOR de org CLIENTE (a forma exata do cadastro público);
   *  - `emailConfirmadoEm` NULO — nunca foi de ninguém: confirmar é o que
   *    transforma um formulário preenchido em posse;
   *  - link vencido — enquanto vale, o dono legítimo ainda pode confirmar, e
   *    reciclar aqui permitiria sequestrar um cadastro recém-feito;
   *  - NENHUMA fatura PAGA — dinheiro pago jamais é reciclado por cima.
   *
   * Se e-mail e CNPJ esbarram em cadastros DIFERENTES, não se recicla nada:
   * emendar duas cascas vazias uma na outra é o tipo de esperteza que vira
   * corrupção de dado. 409 e a pessoa escolhe outro e-mail.
   */
  private async reciclarCadastroVencido(
    email: string,
    documento: string,
    dados: CadastroDto,
    telefone: string,
  ) {
    const agora = new Date();
    const forma = {
      emailConfirmadoEm: null,
      emailConfirmacaoExpiraEm: { lt: agora },
      gestor: true,
      papel: 'CLIENTE' as const,
      organization: { is: { tipo: 'CLIENTE' as const } },
    };

    const porEmail = await this.prisma.user.findFirst({
      where: { email, ...forma },
      select: { id: true, organizationId: true },
    });
    const porDocumento = await this.prisma.user.findFirst({
      /* O spread vem PRIMEIRO: o `organization` daqui soma o cnpj à forma. */
      where: { ...forma, organization: { is: { cnpj: documento, tipo: 'CLIENTE' } } },
      select: { id: true, organizationId: true },
    });

    const velho = porEmail ?? porDocumento;
    if (!velho) return null;
    if (porEmail && porDocumento && porEmail.id !== porDocumento.id) return null;

    /* Se o OUTRO identificador pertence a um cadastro vivo, o 409 normal cuida. */
    if (!porEmail) {
      const emailDeOutro = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (emailDeOutro) return null;
    }
    if (!porDocumento) {
      const docDeOutro = await this.prisma.organization.findFirst({
        where: { cnpj: documento, NOT: { id: velho.organizationId } },
        select: { id: true },
      });
      if (docDeOutro) return null;
    }

    const pagas = await this.prisma.fatura.count({
      where: { assinatura: { organizationId: velho.organizationId }, status: 'PAGA' },
    });
    if (pagas > 0) return null;

    const plano = await this.prisma.plano.findFirst({
      where: { id: dados.planoId, ativo: true },
      select: { id: true },
    });
    if (!plano) {
      throw new BadRequestException('Plano indisponível. Recarregue a página e tente de novo.');
    }

    const senhaHash = await hash(dados.senha, ARGON2);
    const confirmacao = this.confirmacaoAtiva ? this.gerarTokenDeConfirmacao() : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: velho.organizationId },
        data: { nome: dados.nomeEscritorio.trim(), cnpj: documento, telefone },
      });
      await tx.user.update({
        where: { id: velho.id },
        data: {
          email,
          nome: dados.nomeResponsavel.trim(),
          senhaHash,
          ...(confirmacao
            ? {
                emailConfirmadoEm: null,
                emailConfirmacaoTokenHash: confirmacao.hash,
                emailConfirmacaoExpiraEm: confirmacao.expiraEm,
              }
            : {
                emailConfirmadoEm: new Date(),
                emailConfirmacaoTokenHash: null,
                emailConfirmacaoExpiraEm: null,
              }),
        },
      });
      await tx.assinatura.update({
        where: { organizationId: velho.organizationId },
        data: { planoId: plano.id, status: 'PENDENTE' },
      });
    });

    this.logger.log(`Cadastro vencido reciclado: ${velho.organizationId}`);

    if (confirmacao) {
      await this.enviarConfirmacao({
        para: email,
        nomeResponsavel: dados.nomeResponsavel.trim(),
        nomeEscritorio: dados.nomeEscritorio.trim(),
        token: confirmacao.token,
      });
      return {
        organizationId: velho.organizationId,
        email,
        confirmacaoPendente: true as const,
        faturaId: null,
        urlPagamento: null,
      };
    }

    /* Exigência desligada: o comportamento antigo, cobrança na hora. */
    let urlPagamento: string | null = null;
    let faturaId: string | null = null;
    try {
      const fatura = await this.cobranca.emitirFatura({ organizationId: velho.organizationId });
      faturaId = fatura.faturaId ?? null;
      urlPagamento = fatura.urlPagamento ?? null;
    } catch (e) {
      this.logger.error(
        `Conta ${velho.organizationId} reciclada, mas a cobrança falhou: ${(e as Error).message}`,
      );
    }
    return {
      organizationId: velho.organizationId,
      email,
      confirmacaoPendente: false as const,
      faturaId,
      urlPagamento,
    };
  }

  /**
   * O clique no link: confirma, e SÓ ENTÃO a cobrança nasce.
   *
   * O token é de uso único (limpo na mesma escrita) e a busca é pelo HASH — o
   * banco nunca viu o token em claro. Vencido, a resposta manda cadastrar de
   * novo: o cadastro vencido é reciclável, então recomeçar custa um formulário.
   */
  async confirmarEmail(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const usuario = await this.prisma.user.findUnique({
      where: { emailConfirmacaoTokenHash: tokenHash },
      select: {
        id: true,
        email: true,
        organizationId: true,
        emailConfirmacaoExpiraEm: true,
      },
    });
    /* Inválido e já-usado caem juntos aqui, de propósito: o token é limpo ao
       confirmar, então o segundo clique no MESMO link não acha nada — e não
       pode ganhar mensagem diferente de um token forjado, senão vira oráculo. */
    if (!usuario) {
      throw new BadRequestException(
        'Link inválido ou já utilizado. Se você já confirmou, entre pelo login.',
      );
    }
    if (usuario.emailConfirmacaoExpiraEm && usuario.emailConfirmacaoExpiraEm < new Date()) {
      throw new BadRequestException(
        'Este link venceu. Faça o cadastro novamente — leva um minuto e o CNPJ não fica preso.',
      );
    }

    await this.prisma.user.update({
      where: { id: usuario.id },
      data: {
        emailConfirmadoEm: new Date(),
        emailConfirmacaoTokenHash: null,
        emailConfirmacaoExpiraEm: null,
      },
    });

    /* A MESMA disciplina do cadastro antigo: a cobrança nasce aqui, fora de
       transação, e falha dela não desfaz a confirmação — o cliente entra, vê o
       402 e retoma pela tela de assinatura. */
    let urlPagamento: string | null = null;
    let faturaId: string | null = null;
    try {
      const fatura = await this.cobranca.emitirFatura({ organizationId: usuario.organizationId });
      faturaId = fatura.faturaId ?? null;
      urlPagamento = fatura.urlPagamento ?? null;
    } catch (e) {
      this.logger.error(
        `E-mail confirmado (${usuario.organizationId}), mas a cobrança falhou: ${(e as Error).message}`,
      );
    }

    return { email: usuario.email, faturaId, urlPagamento };
  }

  /**
   * Reenvio do link — a resposta é IDÊNTICA exista ou não o e-mail.
   *
   * Esta rota é pública e aceita qualquer endereço: responder diferente para
   * "não existe", "já confirmado" e "reenviado" a transformaria num oráculo de
   * enumeração da base de clientes. O throttle do controller é a outra metade
   * da defesa.
   */
  async reenviarConfirmacao(email: string): Promise<void> {
    const usuario = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), emailConfirmadoEm: null },
      select: { id: true, nome: true, organization: { select: { nome: true } } },
    });
    if (!usuario) return;

    const confirmacao = this.gerarTokenDeConfirmacao();
    await this.prisma.user.update({
      where: { id: usuario.id },
      data: {
        emailConfirmacaoTokenHash: confirmacao.hash,
        emailConfirmacaoExpiraEm: confirmacao.expiraEm,
      },
    });
    await this.enviarConfirmacao({
      para: email.toLowerCase().trim(),
      nomeResponsavel: usuario.nome,
      nomeEscritorio: usuario.organization.nome,
      token: confirmacao.token,
    });
  }
}
