import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CadastroService } from './cadastro.service';
import { CadastroDto, ConfirmarEmailDto, ReenviarConfirmacaoDto } from './cadastro.dto';
import { Publico } from '../../common/decorators/papeis.decorator';

/**
 * Cadastro público — a rota que cria organizações a partir da internet aberta.
 *
 * ── POR QUE O LIMITE É TÃO ESTREITO ──
 *
 * As outras rotas públicas (login, refresh) só LEEM ou comparam. Esta ESCREVE:
 * cada requisição bem-sucedida cria uma organização, um usuário e uma
 * assinatura, e dispara uma chamada ao gateway — que também tem limite e cobra
 * reputação por abuso.
 *
 * Sem trava, um laço trivial enche a tabela `organizations` e o painel de
 * clientes do Asaas de lixo, e a limpeza depois é manual, linha a linha. Cinco
 * por minuto é folgado para gente de verdade — ninguém abre cinco escritórios
 * em um minuto — e inútil para script.
 *
 * O throttler do Nest conta por IP. Não é barreira contra quem tem muitos IPs;
 * é o que separa o acidente e o curioso do ataque dedicado. Para este último a
 * defesa é outra, e ela já existe: o cadastro não libera nada até o pagamento
 * confirmar.
 */
@ApiTags('cadastro')
@Controller('cadastro')
export class CadastroController {
  constructor(private readonly cadastro: CadastroService) {}

  @Publico()
  @Post()
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Cria a conta do assinante e devolve o link de pagamento',
    description:
      'A conta nasce com assinatura PENDENTE — o acesso só abre quando o webhook do gateway ' +
      'confirmar o pagamento. Responde 409 se o e-mail ou o documento já estiverem em uso.',
  })
  @ApiResponse({ status: 201, description: 'Conta criada; `urlPagamento` leva ao checkout.' })
  @ApiResponse({ status: 409, description: 'E-mail ou CNPJ/CPF já cadastrado.' })
  async criar(@Body() dados: CadastroDto) {
    return this.cadastro.cadastrar(dados);
  }

  @Publico()
  @Post('confirmar-email')
  @HttpCode(HttpStatus.OK)
  /* Mais folgado que o cadastro: o caso normal é UM clique, mas o front pode
     repetir por impaciência e o link chega de webmail com prefetch. */
  @Throttle({ medio: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Confirma o e-mail do cadastro e devolve o link de pagamento',
    description:
      'O token é de uso único. É AQUI que a cobrança nasce — antes da confirmação ' +
      'não existe fatura nem link de pagamento, por desenho.',
  })
  async confirmarEmail(@Body() dados: ConfirmarEmailDto) {
    return this.cadastro.confirmarEmail(dados.token);
  }

  @Publico()
  @Post('reenviar-confirmacao')
  @HttpCode(HttpStatus.OK)
  /* 3/min: cada aceite pode virar um e-mail de verdade, e e-mail em rajada
     queima a reputação do domínio — além de ser vetor de spam com nosso nome. */
  @Throttle({ medio: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reenvia o link de confirmação',
    description:
      'A resposta é a mesma exista ou não o e-mail — esta rota não confirma a ' +
      'existência de conta nenhuma.',
  })
  async reenviarConfirmacao(@Body() dados: ReenviarConfirmacaoDto) {
    await this.cadastro.reenviarConfirmacao(dados.email);
    /* Sempre o MESMO corpo. Ver o comentário do service. */
    return { enviado: true };
  }
}
