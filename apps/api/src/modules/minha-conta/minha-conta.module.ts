import { Module } from '@nestjs/common';

import { MinhaContaController } from './minha-conta.controller';
import { MinhaContaService } from './minha-conta.service';

/**
 * Modulo proprio, e nao uma rota dentro de `clientes`: aquele controller e
 * inteiro `@Papeis('ADMIN')` e existe para operar a conta DOS OUTROS. Este aqui
 * e o oposto — cada um mexe na propria — e juntar os dois num arquivo so faria
 * a proxima rota nascer com o guard errado por vizinhanca.
 */
@Module({
  controllers: [MinhaContaController],
  providers: [MinhaContaService],
})
export class MinhaContaModule {}
