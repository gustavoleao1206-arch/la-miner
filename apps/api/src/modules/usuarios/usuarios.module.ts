import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsuariosService } from './usuarios.service';
import { UsuariosController } from './usuarios.controller';

/* AuthModule entra por causa do TokenService: encerrar sessão é revogar
   refresh E carimbar o marco no usuário, e quem sabe fazer as duas coisas
   juntas é ele. Duplicar a lógica aqui deixaria dois lugares para esquecer
   o carimbo — que é justamente o que tornava a revogação incompleta. */
@Module({
  imports: [AuthModule],
  controllers: [UsuariosController],
  providers: [UsuariosService],
  exports: [UsuariosService],
})
export class UsuariosModule {}
