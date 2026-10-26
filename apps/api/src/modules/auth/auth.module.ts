import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';

import { AuthService } from './application/auth.service';
import { MfaService } from './application/mfa.service';
import { TokenService } from './application/token.service';
import { JwtStrategy } from './infrastructure/jwt.strategy';
import { AuthController } from './presentation/auth.controller';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [
    ConfigModule,
    PassportModule.register({ defaultStrategy: 'jwt', session: false }),
    // Segredos e TTL vêm do ConfigService em tempo de assinatura (TokenService),
    // por isso o registro aqui é vazio: evita fixar o segredo no bootstrap.
    JwtModule.register({}),
    /* A porta de e-mail entra aqui por causa do "esqueci minha senha": o link
       de resgate é a única forma de alguém trancado do lado de fora voltar. */
    EmailModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, MfaService, TokenService, JwtStrategy],
  /* MfaService exportado porque o MfaObrigatorioGuard, registrado como
     APP_GUARD no AppModule, depende dele. */
  exports: [AuthService, MfaService, TokenService],
})
export class AuthModule {}
