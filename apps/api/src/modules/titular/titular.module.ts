import { Module } from '@nestjs/common';
import { RetencaoAgendada } from './retencao.agendada';
import { SolicitacoesController } from './solicitacoes.controller';
import { SolicitacoesService } from './solicitacoes.service';
import { TitularController } from './titular.controller';
import { TitularService } from './titular.service';

/**
 * Direitos do titular dos dados.
 *
 * Módulo PRÓPRIO, e não uma rota dentro de `auditoria`: aquele controller é
 * somente leitura por decisão explícita — uma trilha que a aplicação consegue
 * alterar não vale como prova. Este aqui APAGA, e apagar não pode morar ao lado
 * do que existe para provar que nada foi apagado.
 */
@Module({
  controllers: [TitularController, SolicitacoesController],
  providers: [TitularService, RetencaoAgendada, SolicitacoesService],
  exports: [TitularService, RetencaoAgendada],
})
export class TitularModule {}
