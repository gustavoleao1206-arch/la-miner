import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ENRICHMENT_PROVIDER } from './domain/enrichment-provider.port';
import { ContactraProvider } from './providers/contactra/contactra.provider';
import { FakeProvider } from './providers/fake/fake.provider';
import { TetoConsumoService } from './application/teto-consumo.service';
import { ReconferenciaService } from './application/reconferencia.service';

/**
 * Seleção do provider por configuração (ENRICHMENT_PROVIDER).
 * Nenhum caso de uso importa uma implementação concreta —
 * todos injetam o token ENRICHMENT_PROVIDER.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    ContactraProvider,
    FakeProvider,
    TetoConsumoService,
    ReconferenciaService,
    {
      provide: ENRICHMENT_PROVIDER,
      inject: [ConfigService, ContactraProvider, FakeProvider],
      useFactory: (config: ConfigService, contactra: ContactraProvider, fake: FakeProvider) => {
        const escolhido =
          config.get<string>('ENRICHMENT_PROVIDER', 'fake') === 'contactra' ? contactra : fake;

        /* A TRAVA DE PRODUÇÃO MORA AQUI, e não no construtor do FakeProvider.
           Ambos os providers são instanciados — é o `inject` acima que obriga —,
           então uma trava no construtor do fake derrubava a API mesmo com a
           Contactra selecionada. Foi o que aconteceu no primeiro deploy: a
           mensagem mandava "configure ENRICHMENT_PROVIDER=contactra" quando ele
           JÁ estava contactra.

           A pergunta certa é sobre o ESCOLHIDO, e é a que se faz agora. Segue
           sendo falha alta e no boot, no mesmo instante do ciclo de vida — e
           continua havendo uma segunda defesa independente, o refine de
           env.validation.ts, que recusa ENRICHMENT_PROVIDER=fake em produção
           antes de o Nest sequer começar. */
        if (escolhido === fake && config.get<string>('NODE_ENV') === 'production') {
          throw new Error(
            'ENRICHMENT_PROVIDER=fake é proibido em produção: o banco tem CPF de gente ' +
              'real e o provider falso fingiria enriquecimento.',
          );
        }

        // Log AQUI, não no construtor: ambos os providers são instanciados,
        // então avisar no construtor mentia sobre qual está ativo.
        const log = new Logger('EnriquecimentoModule');
        if (escolhido === fake) {
          log.warn('Provider ativo: FAKE — nenhum enriquecimento real será feito.');
        } else {
          log.log(`Provider ativo: ${escolhido.nome} (teto diário: ${config.get('CONTACTRA_TETO_DIARIO', 500)})`);
        }
        return escolhido;
      },
    },
  ],
  exports: [ENRICHMENT_PROVIDER, TetoConsumoService, ReconferenciaService],
})
export class EnriquecimentoModule {}
