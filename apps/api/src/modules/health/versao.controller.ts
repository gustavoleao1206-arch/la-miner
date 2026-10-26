import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Papeis } from '../../common/decorators/papeis.decorator';

/**
 * QUAL CÓDIGO ESTÁ RODANDO AQUI.
 *
 * Nasceu de uma cegueira concreta: depois de publicar, a única forma de saber
 * se a versão nova assumiu era achar algum comportamento visível de fora que
 * tivesse mudado — uma string no bundle, um cabeçalho de rate limit. Quando a
 * mudança é interna (uma correção de corrida no MFA, por exemplo), não há
 * marcador nenhum, e "subiu?" vira uma pergunta que só o painel da Render
 * responde.
 *
 * ── POR QUE NÃO ENTROU NO HealthController ──
 *
 * Aquela classe inteira é `@Publico()`, e o `PUBLICO_KEY` é resolvido com
 * `getAllAndOverride([handler, classe])`: um método que não declare a chave
 * HERDA o valor da classe. Um `@Papeis('ADMIN')` aqui NÃO desfaz o `@Publico()`
 * de lá — os guards checam público ANTES de papel, e a rota sairia aberta,
 * publicando o commit em produção para qualquer um. Controller separado não tem
 * como errar isso.
 *
 * O comentário do HealthController diz por que ele não devolve versão: "uma
 * sonda de saúde é um alvo de reconhecimento". Esta rota não contradiz aquilo —
 * ela é a mesma informação atrás de autenticação de ADMIN.
 */
@ApiTags('health')
@Controller('versao')
@Papeis('ADMIN')
@ApiBearerAuth('jwt')
export class VersaoController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Commit publicado e há quanto tempo esta instância está de pé',
    description: 'Só ADMIN. Serve para conferir, depois de um deploy, se a versão nova assumiu.',
  })
  versao() {
    /* Quem preenche é a Render, a cada deploy. Fora dela — máquina de
       desenvolvimento, suíte — a variável não existe, e isso é um estado
       legítimo, não um erro. */
    const commit = this.config.get<string>('RENDER_GIT_COMMIT') ?? null;

    /* Quando esta instância subiu. É o segundo sinal que se quer depois de
       publicar: um commit igual ao anterior COM tempo de pé zerado significa
       que o deploy rodou e o código simplesmente não mudou naquele serviço. */
    const noArDesde = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

    return {
      /* `null`, e não uma string bonita: quem consome precisa distinguir "não
         sei" de um valor. Um 'desconhecido' de texto passaria por SHA numa
         comparação desatenta. */
      commit,
      curto: commit ? commit.slice(0, 7) : null,
      ambiente: this.config.get<string>('NODE_ENV') ?? null,
      noArDesde,
    };
  }
}
