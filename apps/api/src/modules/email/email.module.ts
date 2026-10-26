import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EMAIL_PORT } from './email.port';
import { EmailFakeProvider } from './email-fake.provider';
import { ResendProvider } from './resend.provider';

/**
 * Seleção do provedor de e-mail por configuração (EMAIL_PROVIDER), no mesmo
 * desenho da cobrança e do enriquecimento.
 *
 * A trava de produção mora AQUI e no zod, nunca no construtor do fake — ambos
 * os providers são instanciados sempre; a pergunta "sou o escolhido?" só a
 * fábrica responde (a lição registrada no módulo de enriquecimento).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    EmailFakeProvider,
    ResendProvider,
    {
      provide: EMAIL_PORT,
      inject: [ConfigService, EmailFakeProvider, ResendProvider],
      useFactory: (config: ConfigService, fake: EmailFakeProvider, resend: ResendProvider) => {
        const escolhido = config.get<string>('EMAIL_PROVIDER', 'fake').toLowerCase();
        const log = new Logger('EmailModule');

        if (escolhido === 'fake') {
          log.warn('Provedor de e-mail: FAKE — links de confirmação saem no LOG, nada é enviado.');
          return fake;
        }
        if (escolhido !== 'resend') {
          /* Falha ALTA, como na cobrança: provedor inexistente caindo no fake
             em silêncio seria um cadastro que ninguém confirma — e a descoberta
             viria pelo cliente reclamando que o e-mail nunca chegou. */
          throw new Error(`EMAIL_PROVIDER="${escolhido}" não tem adaptador. Use "fake" ou "resend".`);
        }
        /* As duas exigidas no BOOT, e não no primeiro envio de madrugada. */
        config.getOrThrow('RESEND_API_KEY');
        config.getOrThrow('EMAIL_REMETENTE');
        return resend;
      },
    },
  ],
  exports: [EMAIL_PORT],
})
export class EmailModule {}
