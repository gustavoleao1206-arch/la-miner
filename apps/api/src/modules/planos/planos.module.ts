import { Module } from '@nestjs/common';
import { PlanosController } from './planos.controller';

/**
 * Módulo da vitrine de planos.
 *
 * Só um controller: não há serviço porque não há regra de negócio: é uma
 * leitura filtrada. Criar um `PlanosService` que apenas repassa o Prisma
 * acrescentaria um arquivo e nenhuma clareza.
 *
 * O PrismaService chega pelo módulo global — o mesmo caminho de todos os
 * outros módulos deste app.
 */
@Module({
  controllers: [PlanosController],
})
export class PlanosModule {}
