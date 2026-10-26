import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ehEscopoCliente } from '../escopo-processos';
import type { UsuarioAutenticado } from '../decorators/papeis.decorator';

/**
 * Suspensão com dentes.
 *
 * "Suspensa = sem acesso, dados preservados" só é verdade se algo de fato barrar
 * a leitura. O motor de distribuição já corta lotes novos, mas isso sozinho
 * deixaria o inadimplente usando para sempre a carteira que já recebeu — a
 * alavanca comercial não existiria.
 *
 * Devolve 402 (Payment Required), não 403: o cliente não está proibido, está
 * devendo. A diferença importa para a tela, que precisa oferecer "regularizar"
 * em vez de "você não tem permissão".
 *
 * INADIMPLENTE ainda passa — é a carência. Quem barra é a suspensão, que só
 * chega depois dos dias de tolerância (ver CobrancaService.processarVencimentos).
 *
 * ── PENDENTE TAMBÉM BARRA, DESDE O CADASTRO PÚBLICO ──
 *
 * Antes, PENDENTE passava. Fazia sentido enquanto toda organização nascia por
 * script, pela mão de quem já sabia quem era o cliente: PENDENTE era um estado
 * de minutos, entre criar a linha e emitir a primeira fatura.
 *
 * Com a landing no ar, qualquer pessoa cria uma organização preenchendo um
 * formulário. PENDENTE deixou de ser um intervalo administrativo e virou "não
 * pagou ainda" — e o modelo escolhido para o produto é pagar primeiro, depois
 * acessar.
 *
 * O escopo por liberação já garantia que a carteira viesse VAZIA para quem não
 * tem assinatura ativa, e essa continua sendo a defesa que protege o dado. Mas
 * "entra e vê tudo zerado" é uma resposta pior que "entra e vê onde pagar":
 * indistinguível de um sistema quebrado, e o visitante que acabou de se
 * cadastrar conclui que o produto não funciona. As duas travas respondem
 * perguntas diferentes — o escopo diz o que se pode ver, o guard diz se a
 * porta abre — e é isso que faz o 402 poder carregar uma tela útil.
 */
@Injectable()
export class AssinaturaAtivaGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const usuario = ctx.switchToHttp().getRequest().user as UsuarioAutenticado | undefined;
    /* Autenticação é problema de outro guard; aqui, sem usuário, não há o que
       avaliar. */
    if (!usuario) return true;

    /* Só o CLIENTE é avaliado. A operação interna não tem assinatura, e exigir
       uma dela trancaria o sistema inteiro por causa de uma tabela vazia. */
    if (!ehEscopoCliente(usuario)) return true;

    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId: usuario.organizationId },
      select: { status: true },
    });

    /* SEM assinatura NÃO barra aqui, de propósito. Este guard tem um significado
       só — suspensão —, e misturar "não é cliente" com "está devendo" produziria
       um 402 "regularize o pagamento" para o usuário legado de papel CLIENTE
       dentro da org interna, que nunca foi cliente de nada.
       Quem cuida desse caso é o ESCOPO: sem assinatura não há liberação, e sem
       liberação a carteira já vem vazia. Uma trava por pergunta. */
    /* `motivo` é o campo que a tela lê; `message` continua sendo a frase, no
       mesmo lugar de antes, para não quebrar quem já a exibia. Distinguir os
       dois casos importa porque a ação oferecida é diferente: quem nunca pagou
       precisa TERMINAR o checkout; quem foi suspenso precisa REGULARIZAR uma
       fatura que já existe. Mandar os dois para a mesma tela deixaria metade
       dos clientes procurando um botão que não serve para eles. */
    if (assinatura?.status === 'PENDENTE') {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          motivo: 'PAGAMENTO_PENDENTE',
          message:
            'Sua assinatura ainda não foi confirmada. Conclua o pagamento para liberar o acesso.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    if (assinatura?.status === 'SUSPENSA' || assinatura?.status === 'CANCELADA') {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          motivo: 'ASSINATURA_INATIVA',
          message:
            'Assinatura suspensa ou inativa. Regularize o pagamento para voltar a acessar a sua carteira.',
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
