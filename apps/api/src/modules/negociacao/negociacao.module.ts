import { Module } from '@nestjs/common';
import { NegociacaoService } from './negociacao.service';
import { NegociacaoController } from './negociacao.controller';

@Module({
  controllers: [NegociacaoController],
  providers: [NegociacaoService],
  exports: [NegociacaoService],
})
export class NegociacaoModule {}
