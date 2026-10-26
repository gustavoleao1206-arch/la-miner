import { Injectable, Logger } from '@nestjs/common';
import type {
  EnrichmentProvider,
  ResultadoEnriquecimento,
  SaudeProvider,
} from '../../domain/enrichment-provider.port';

/**
 * Provider de DESENVOLVIMENTO.
 *
 * Não inventa dado de pessoa real: devolve SEM_DADOS para qualquer CPF.
 * Serve só para exercitar fila, retry e persistência sem gastar crédito
 * de API nem fabricar telefone/endereço falso num banco que contém
 * gente de verdade.
 *
 * Recusa-se a rodar em produção — de propósito. A trava NÃO mora aqui, e a
 * diferença custou um deploy inteiro: ela ficava no construtor, perguntando
 * "estou sendo construído em produção?". A pergunta certa é "sou o provider
 * ESCOLHIDO em produção?", e só quem escolhe sabe responder — por isso ela
 * agora vive na `useFactory` do módulo. O construtor daqui era executado
 * SEMPRE, porque a fábrica injeta os dois providers para decidir entre eles, e
 * derrubava a API inteira mesmo com a Contactra devidamente selecionada.
 */
@Injectable()
export class FakeProvider implements EnrichmentProvider {
  readonly nome = 'FAKE';
  private readonly logger = new Logger(FakeProvider.name);

  async healthCheck(): Promise<SaudeProvider> {
    return { disponivel: true, detalhe: 'provider de desenvolvimento' };
  }

  async consultarPorCpf(cpf: string): Promise<ResultadoEnriquecimento> {
    const inicio = Date.now();
    await new Promise((r) => setTimeout(r, 40)); // simula latência de rede
    return {
      status: 'SEM_DADOS',
      dadosBrutos: { _fake: true, cpfConsultado: cpf.slice(0, 3) + '********' },
      latenciaMs: Date.now() - inicio,
    };
  }
}
