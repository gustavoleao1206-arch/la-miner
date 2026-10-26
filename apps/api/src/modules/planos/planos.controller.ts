import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../../prisma/prisma.service';
import { Publico } from '../../common/decorators/papeis.decorator';

/**
 * A vitrine de planos — a única rota que a landing comercial consome.
 *
 * ── POR QUE É PÚBLICA ──
 *
 * A landing mora no ápice do domínio e é lida por quem ainda não tem conta.
 * Não há token para apresentar. É a mesma decisão do HealthController, e pelo
 * mesmo critério: pública porque o chamador legítimo não pode se autenticar, e
 * por isso mesmo responde o MENOS possível.
 *
 * ── O QUE NÃO SAI DAQUI ──
 *
 * Só o que um cartaz de preço mostraria. Nada de contagem de assinantes, de
 * receita, de quantos clientes cada plano tem — números que a tabela `planos`
 * não guarda, mas que um `select: *` traria assim que alguém os acrescentasse.
 * Listar campo a campo é o que faz esta rota continuar segura quando o modelo
 * crescer; `select` explícito não vaza coluna que ainda não existe.
 *
 * ── POR QUE `precoCentavos`, E NÃO `preco` ──
 *
 * `preco` é `Decimal(12,2)` no banco. Serializado como número de ponto
 * flutuante, R$ 799,00 pode chegar ao navegador como 798.9999999999999 — e o
 * preço na vitrine passa a divergir do preço cobrado, que é o defeito mais
 * caro que uma página de vendas pode ter. Inteiro em centavos não tem esse
 * problema: 79900 é 79900 em qualquer linguagem, e quem formata é a interface.
 *
 * É a mesma disciplina do parcelamento da cessão, onde a divisão acontece em
 * centavos inteiros justamente para o resíduo não sumir.
 *
 * ── SOBRE EXPOR O `id` ──
 *
 * O id do plano é dado de catálogo, não segredo: ele vai precisar viajar no
 * checkout para dizer O QUE está sendo assinado. O que NUNCA pode vir do
 * cliente é o PREÇO — a fatura se emite relendo `planos.preco` do banco pelo
 * id. Cliente escolhe o plano; o servidor decide quanto custa.
 */
@ApiTags('planos')
@Controller('planos')
@Publico()
export class PlanosController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Planos ativos, para a vitrine pública' })
  async listar() {
    const planos = await this.prisma.plano.findMany({
      /* Plano desativado some da vitrine mas continua no banco: quem já assina
         precisa que a linha exista para a fatura seguir sendo emitida. Filtrar
         na leitura, e não apagar, é o que separa "parar de vender" de "quebrar
         quem já comprou". */
      where: { ativo: true },
      select: {
        id: true,
        nome: true,
        descricao: true,
        processosPorCiclo: true,
        preco: true,
        intervaloMeses: true,
      },
      /* Do mais barato para o mais caro: é a ordem que a página desenha, e
         deixá-la aqui evita que cada cliente da API invente a sua. */
      orderBy: { preco: 'asc' },
    });

    return planos.map(({ preco, ...resto }) => ({
      ...resto,
      /* `Decimal.mul(100)` e não `Number(preco) * 100`: a multiplicação em
         decimal exato acontece ANTES de virar binário, então 7,99 * 100 dá 799
         e não 798,9999. O `.toNumber()` no fim é seguro porque o resultado já
         é inteiro. */
      precoCentavos: preco.mul(100).toNumber(),
    }));
  }
}
