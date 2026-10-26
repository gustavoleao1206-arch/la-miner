import { Controller, Get, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Papeis, UsuarioAtual, type UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { MinhaContaService } from './minha-conta.service';

/**
 * Os dados da PRÓPRIA conta, para o próprio dono.
 *
 * ── A ORGANIZAÇÃO VEM DO TOKEN, NUNCA DA URL ──
 *
 * Não há parâmetro de organização e não deve haver. Aceitar um id aqui
 * transformaria a rota em "exportar a conta alheia" — e ela é justamente do
 * tipo que um cliente comum pode chamar. Mesma disciplina de
 * `cobranca/minha-assinatura`.
 *
 * ── SEM `AssinaturaAtivaGuard`, E ISSO É DELIBERADO ──
 *
 * O 402 existe como alavanca comercial sobre a CARTEIRA. Usá-lo aqui
 * transformaria a suspensão em retenção do dado do cliente — e o suspenso é
 * exatamente quem tende a estar tentando levar os dados embora. Bloquear a
 * portabilidade de quem está de saída é o oposto do que o art. 18 pede.
 */
@ApiTags('minha-conta')
@ApiBearerAuth('jwt')
@Controller('minha-conta')
export class MinhaContaController {
  constructor(private readonly minhaConta: MinhaContaService) {}

  @Get('exportacao')
  @HttpCode(200)
  @Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
  /* Balde `medio`, que existe (config/throttlers.ts) — um nome inexistente vira
     metadado morto sem erro. A consulta e pesada e o resultado nao muda entre
     dois cliques: 5/min e generoso para quem clica de novo e apertado para quem
     automatizou o botao. */
  @Throttle({ medio: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Exporta os dados desta conta (LGPD art. 18, V)',
    description:
      'Cadastro, usuarios, assinatura, faturas e historico de ciclos, em JSON. NAO inclui a ' +
      'carteira de precatorios nem os contatos dos titulares: sao dados de terceiros, e o ' +
      'documento diz isso por extenso na secao `naoIncluido`.',
  })
  exportar(@UsuarioAtual() ator: UsuarioAutenticado) {
    return this.minhaConta.exportar({ id: ator.id, organizationId: ator.organizationId });
  }
}
