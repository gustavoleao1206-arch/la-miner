import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { Publico } from '../../common/decorators/papeis.decorator';

/**
 * Sonda de saúde da API.
 *
 * Três lugares do código já AFIRMAVAM que estas rotas existiam — o `ignore` do
 * logger (`app.module.ts`), o comentário de `verificarConexao` e o
 * documento de arquitetura — e nenhum controller as declarava. `verificarConexao`
 * estava escrito, testado pelo tipo, e sem um único chamador.
 *
 * Sem elas o Render não tem como saber se a instância está viva: uma API com o
 * Postgres fora continuaria recebendo tráfego e devolvendo 500 a cada
 * requisição, e a plataforma a consideraria saudável.
 *
 * PÚBLICAS de propósito: o balanceador não tem token. Por isso não devolvem
 * versão, host, nome de banco nem contagem de registros — uma sonda de saúde é
 * um alvo de reconhecimento, e a resposta certa é a mais curta possível.
 */
@ApiTags('health')
@Controller('health')
@Publico()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness: "o processo está de pé?".
   *
   * NÃO toca no banco. É a pergunta que decide se o orquestrador REINICIA o
   * contêiner — e reiniciar a API porque o Postgres caiu só transforma uma
   * indisponibilidade em duas.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness — o processo responde' })
  vivo() {
    return { status: 'ok' };
  }

  /**
   * Readiness: "dá para atender requisição agora?".
   *
   * Aqui o Postgres É consultado, porque sem ele nenhuma rota útil funciona.
   * Responde 503 quando não dá — é o código que faz o balanceador tirar a
   * instância da rotação sem matá-la.
   *
   * O Redis fica de FORA da decisão: ele serve a fila de enriquecimento, e a
   * plataforma continua servindo leitura sem ele. Derrubar a instância por causa
   * da fila seria trocar degradação parcial por queda total.
   */
  @Get('ready')
  @ApiOperation({ summary: 'Readiness — o banco responde' })
  async pronto() {
    if (!(await this.prisma.verificarConexao())) {
      throw new ServiceUnavailableException({ status: 'indisponivel', banco: false });
    }
    return { status: 'ok', banco: true };
  }
}
