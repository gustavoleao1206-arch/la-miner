/**
 * Ponto único de acesso ao Prisma Client.
 * A API importa daqui — nunca instancia PrismaClient por conta própria,
 * para não abrir múltiplos pools de conexão.
 */
export * from './generated/client';
export { PrismaClient } from './generated/client';
