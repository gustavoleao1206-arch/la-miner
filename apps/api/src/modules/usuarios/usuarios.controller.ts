import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Papeis, UsuarioAtual } from '../../common/decorators/papeis.decorator';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { UsuariosService, type Ator } from './usuarios.service';
import { AtualizarUsuarioDto, CriarUsuarioDto } from './usuarios.dto';

/**
 * Equipe da PRÓPRIA organização.
 *
 * Aberto aos três papéis porque um gestor de cliente tem papel CLIENTE — quem
 * de fato autoriza é o `podeGerenciarEquipe` do serviço, que exige ADMIN ou
 * gestão. Fechar por papel aqui trancaria justamente o assinante, que é quem
 * esta superfície existe para atender.
 *
 * Toda operação é escopada à organização do ATOR, tirada do token. Nenhuma rota
 * aceita organizationId por parâmetro — não há o que "esquecer de filtrar".
 */
@ApiTags('usuarios')
@ApiBearerAuth('jwt')
@Controller('usuarios')
@Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
export class UsuariosController {
  constructor(private readonly usuarios: UsuariosService) {}

  private ator(u: UsuarioAutenticado): Ator {
    return {
      id: u.id,
      papel: u.papel,
      organizationId: u.organizationId,
      tipo: u.tipo,
      gestor: u.gestor,
    };
  }

  @Get()
  @ApiOperation({ summary: 'Usuários da própria organização' })
  async listar(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.usuarios.listar(this.ator(usuario));
  }

  @Post()
  @ApiOperation({ summary: 'Cria um usuário na própria organização (senha exibida uma vez)' })
  async criar(@UsuarioAtual() usuario: UsuarioAutenticado, @Body() dto: CriarUsuarioDto) {
    return this.usuarios.criar(this.ator(usuario), dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Ativa/desativa o acesso ou promove/rebaixa a gestão' })
  async atualizar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AtualizarUsuarioDto,
  ) {
    return this.usuarios.atualizar(this.ator(usuario), id, dto);
  }

  @Post(':id/senha')
  @ApiOperation({ summary: 'Redefine a senha e encerra as sessões abertas do usuário' })
  async redefinirSenha(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usuarios.redefinirSenha(this.ator(usuario), id);
  }

  @Get(':id/sessoes')
  @ApiOperation({
    summary: 'Sessões vivas do usuário, uma por dispositivo',
    description:
      'Uma linha por família de refresh token — a rotação cria um registro a cada renovação, ' +
      'e listar token a token mostraria a mesma aba dezenas de vezes.',
  })
  async sessoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usuarios.sessoes(this.ator(usuario), id);
  }

  @Post(':id/encerrar-sessoes')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Encerra as sessões do usuário SEM mexer na conta',
    description:
      'Para desligamento e suspeita: derruba os acessos sem desativar o usuário nem trocar a ' +
      'senha dele. Efeito IMEDIATO — os access tokens já emitidos passam a ser recusados, em vez ' +
      'de valerem até expirar.',
  })
  async encerrarSessoes(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.usuarios.encerrarSessoes(this.ator(usuario), id);
  }
}
