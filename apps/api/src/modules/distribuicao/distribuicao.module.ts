import { Module } from '@nestjs/common';
import { DistribuicaoService } from './distribuicao.service';
import { DistribuicaoController } from './distribuicao.controller';
import { DistribuicaoAgendada } from './distribuicao.agendada';

@Module({
  controllers: [DistribuicaoController],
  providers: [DistribuicaoService, DistribuicaoAgendada],
  exports: [DistribuicaoService],
})
export class DistribuicaoModule {}
