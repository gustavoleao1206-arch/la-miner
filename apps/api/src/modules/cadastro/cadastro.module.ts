import { Module } from '@nestjs/common';

import { CadastroController } from './cadastro.controller';
import { CadastroService } from './cadastro.service';
import { CobrancaModule } from '../cobranca/cobranca.module';
import { EmailModule } from '../email/email.module';

/**
 * O cadastro DEPENDE do módulo de cobrança, e não o contrário.
 *
 * A seta aponta para cá porque quem vende é que precisa saber cobrar; a
 * cobrança não precisa saber que existe um formulário na internet. Inverter
 * — pôr o cadastro dentro do CobrancaModule — faria o cron de vencimentos
 * carregar, por transitividade, o controller público de criação de contas.
 */
@Module({
  imports: [CobrancaModule, EmailModule],
  controllers: [CadastroController],
  providers: [CadastroService],
})
export class CadastroModule {}
