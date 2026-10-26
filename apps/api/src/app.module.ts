import { Module } from '@nestjs/common';
import { join } from 'node:path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { validarEnv } from './config/env.validation';
import { CAMINHOS_REDIGIDOS, CENSURA } from './config/log-redact';
import { THROTTLERS } from './config/throttlers';
import { serializarRequisicaoSemDocumento } from './common/mascarar-documento';
import { ehWorker } from './config/papel-do-processo';
import { PrismaModule } from './prisma/prisma.module';
import { AuditoriaModule } from './modules/auditoria/auditoria.module';
import { MinhaContaModule } from './modules/minha-conta/minha-conta.module';
import { AuthModule } from './modules/auth/auth.module';
import { CadastroModule } from './modules/cadastro/cadastro.module';
import { CarteiraModule } from './modules/carteira/carteira.module';
import { ClientesModule } from './modules/clientes/clientes.module';
import { CobrancaModule } from './modules/cobranca/cobranca.module';
import { CrmModule } from './modules/crm/crm.module';
import { NegociacaoModule } from './modules/negociacao/negociacao.module';
import { DistribuicaoModule } from './modules/distribuicao/distribuicao.module';
import { FilaModule } from './modules/fila/fila.module';
import { HealthModule } from './modules/health/health.module';
import { ImportacaoModule } from './modules/importacao/importacao.module';
import { PlanosModule } from './modules/planos/planos.module';
import { TitularModule } from './modules/titular/titular.module';
import { UsuariosModule } from './modules/usuarios/usuarios.module';
import { EnriquecimentoModule } from './modules/enriquecimento/enriquecimento.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MfaObrigatorioGuard } from './common/guards/mfa-obrigatorio.guard';
import { EmailConfirmadoGuard } from './common/guards/email-confirmado.guard';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // EXPLÍCITO de propósito: em monorepo, deixar o dotenv resolver pelo cwd
      // faz a API pegar o .env errado dependendo de onde foi iniciada.
      // A fonte da verdade é um só arquivo — a raiz do repositório.
      envFilePath: [join(__dirname, '..', '..', '..', '.env')],
      validate: validarEnv, // falha no boot se faltar variável — melhor que quebrar em produção
    }),

    // Logs estruturados. `redact` impede que CPF/token/senha caiam no arquivo de log.
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const ambiente = config.get('NODE_ENV');
        return {
        pinoHttp: {
          /* `test` silencia (só fatal): os testes de controller fazem centenas
             de requisições e o log de cada uma afogaria o resultado do jest.
             Não muda nada em dev nem em produção. */
          level: ambiente === 'test' ? 'fatal' : ambiente === 'production' ? 'info' : 'debug',
          transport:
            ambiente !== 'production' && ambiente !== 'test'
              ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } }
              : undefined,
          /* A lista mora em `config/log-redact.ts`. Dentro deste closure ela era
             inalcançável por teste, e foi assim que o cabeçalho do webhook do
             Asaas ficou de fora sem ninguém notar. Lá ela tem um teste que
             exercita a redação com um pino de verdade. */
          redact: { paths: [...CAMINHOS_REDIGIDOS], censor: CENSURA },
          /* `redact` acima trabalha por CAMINHO e só alcança campo nomeado. O
             CPF também viajava DENTRO da url e da query — /auditoria/cpf/:cpf,
             ?cpfConsultado= e ?termo= — e ia em claro para o log. Este
             serializer limpa as duas antes de qualquer coisa ser escrita. */
          serializers: { req: serializarRequisicaoSemDocumento },
          /* A sonda bate a cada poucos segundos: logá-la afogaria o resto.
             O caminho real inclui o versionamento (/api/v1/health) — antes esta
             linha citava /api/health, que nunca existiu, e o filtro não filtrava
             nada. `startsWith` cobre /health e /health/ready. */
          autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/api/v1/health') },
        },
        };
      },
    }),

    /* Os baldes moram em `config/throttlers.ts` para que um teste possa cruzar
       cada `@Throttle({ nome: ... })` dos controllers com os nomes REGISTRADOS
       aqui — o erro que passou despercebido foi um nome que não existia. */
    ThrottlerModule.forRoot(THROTTLERS),

    /**
     * Os crons rodam SÓ no papel de worker.
     *
     * Sem `ScheduleModule`, os `@Cron` viram decorator inerte — as classes
     * continuam existindo e injetáveis (o FilaController usa a
     * `SincronizacaoAgendada`), só ninguém as dispara sozinho.
     *
     * Isso conserta uma fragilidade que a instância única escondia: os quatro
     * crons rodam em TODA instância que tenha o Schedule ligado. Com duas APIs
     * atrás do balanceador, a sincronização dispararia duas vezes — e ela gasta
     * crédito da Contactra. Concentrando no worker, a duplicidade deixa de
     * depender de ninguém lembrar de não escalar.
     */
    ...(ehWorker() ? [ScheduleModule.forRoot()] : []),

    PrismaModule,
    AuditoriaModule,
    MinhaContaModule,
    AuthModule,
    CadastroModule,
    CarteiraModule,
    ClientesModule,
    CobrancaModule,
    CrmModule,

    NegociacaoModule,
    DistribuicaoModule,
    EnriquecimentoModule,
    FilaModule,
    HealthModule,
    ImportacaoModule,
    PlanosModule,
    TitularModule,
    UsuariosModule,
  ],
  providers: [
    // A ORDEM IMPORTA: throttle → autenticação → autorização.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Autenticação GLOBAL e fechada por padrão: toda rota exige JWT,
    // salvo as marcadas com @Publico(). Esquecer de proteger uma rota nova
    // não pode virar vazamento de dado pessoal.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Autorização por papel, para as rotas marcadas com @Papeis(...).
    { provide: APP_GUARD, useClass: RolesGuard },
    /* A política de MFA vem DEPOIS da autorização por papel, e a ordem importa:
       ela pergunta o papel do usuário para decidir se o exige. Desligada
       (MFA_OBRIGATORIO=nenhum, o padrão) sai na primeira linha, sem custo. */
    { provide: APP_GUARD, useClass: MfaObrigatorioGuard },
    /* Depois do MFA e antes de tudo que lê dados: quem não confirmou o e-mail
       entra (o login passa) mas não alcança nada além das rotas públicas. */
    { provide: APP_GUARD, useClass: EmailConfirmadoGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
