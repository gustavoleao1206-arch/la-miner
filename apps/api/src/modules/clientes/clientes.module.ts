import { Module } from '@nestjs/common';

import { ClientesController } from './clientes.controller';
import { ClientesService } from './clientes.service';

/**
 * Fim de vida da conta de cliente: sondar e excluir/anonimizar.
 *
 * Módulo próprio, e não um apêndice de `cobranca` ou `distribuicao`, porque o
 * assunto é o CICLO DE VIDA DA ORGANIZAÇÃO — não o dinheiro dela nem a entrega
 * dela. Pendurar exclusão de conta no módulo de cobrança faria parecer que
 * apagar cliente é assunto financeiro, e é justamente o contrário: o financeiro
 * é o que se RECUSA a deixar apagar.
 *
 * O PrismaService chega pelo módulo global, como em todos os outros.
 */
@Module({
  controllers: [ClientesController],
  providers: [ClientesService],
})
export class ClientesModule {}
