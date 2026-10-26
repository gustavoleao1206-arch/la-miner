import { Module } from '@nestjs/common';
import { AuditoriaController } from './auditoria.controller';
import { AuditoriaService } from './auditoria.service';
import { RetencaoAgendada } from './retencao.agendada';

@Module({
  controllers: [AuditoriaController],
  /* RetencaoAgendada só DISPARA no papel worker (o ScheduleModule mora lá),
     como os outros crons; aqui ele apenas existe. */
  providers: [AuditoriaService, RetencaoAgendada],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}
