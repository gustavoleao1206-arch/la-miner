import { Module } from '@nestjs/common';
import { ImportacaoService } from './importacao.service';
import { ImportacaoController } from './importacao.controller';
import { ImportacaoProcessor } from './importacao.processor';
import { FilaModule } from '../fila/fila.module';
import { ehWorker } from '../../config/papel-do-processo';

/**
 * O processador entra SÓ no papel de worker, e SÓ fora de teste — a mesma regra
 * do `EnriquecimentoProcessor`, pelos mesmos dois motivos.
 *
 * A API continua PRODUZINDO (a rota enfileira); o que ela não faz é consumir.
 * Sem esta separação, cada instância da API viraria mais um consumidor
 * disputando os mesmos jobs, e um deploy mataria a importação em voo.
 *
 * Em teste, `WorkerHost` abriria conexão com o Redis na carga do módulo — e o
 * Redis aqui roda em Docker, fora do alcance de um `jest`. A suíte quebraria
 * por infraestrutura ausente, não por regressão. Nada se perde de cobertura: o
 * `ImportacaoService.processarImportacao` é chamado direto pelos testes de
 * integração, que é onde a lógica mora.
 */
const CONSOME_FILA = process.env.NODE_ENV !== 'test' && ehWorker();

@Module({
  imports: [FilaModule],
  controllers: [ImportacaoController],
  providers: [ImportacaoService, ...(CONSOME_FILA ? [ImportacaoProcessor] : [])],
})
export class ImportacaoModule {}
