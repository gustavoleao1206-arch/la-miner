import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global: um único pool de conexões para toda a aplicação.
 * Nenhum módulo deve instanciar PrismaClient por conta própria.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
