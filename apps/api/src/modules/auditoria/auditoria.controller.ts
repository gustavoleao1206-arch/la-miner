import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Papeis, UsuarioAtual, type UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { OrganizacaoInternaGuard } from '../../common/guards/organizacao-interna.guard';
import { AuditoriaService } from './auditoria.service';
import { ConsultasQueryDto, ResumoQueryDto, TrilhaCpfDto } from './auditoria.dto';

/**
 * Trilha de accountability — SOMENTE LEITURA.
 *
 * ⚠ NENHUMA ROTA DESTE CONTROLLER ESCREVE NA TRILHA. Uma trilha que a própria
 * aplicação consegue editar ou apagar não vale como prova perante a ANPD nem em
 * juízo: bastaria alegar que o registro incômodo foi removido pelo mesmo
 * sistema que o produziu. Correção de dado gravado errado é assunto de
 * migration versionada, com rastro no repositório — nunca de endpoint. Quem
 * escreve aqui é o fluxo de consulta (CarteiraController) e o worker de
 * enriquecimento.
 *
 * A regra dizia "nenhum POST/PATCH/PUT/DELETE", o que era fácil de conferir mas
 * confundia VERBO com EFEITO. O `POST trilha-cpf` abaixo é uma CONSULTA: existe
 * só para tirar o CPF da URL, que vaza para o log de acesso do proxy. Ele lê e
 * devolve; não grava nada. A regra acima é a que sempre importou, e continua
 * conferível — basta ver que nenhum método chama `create`/`update`/`delete`.
 *
 * O que continua PROIBIDO aqui, em qualquer verbo: rota que escreva, altere ou
 * remova linha de trilha.
 *
 * ADMIN apenas: a trilha concentra CPF, IP e termo de busca de todo mundo.
 * Ler quem consultou o quê é mais sensível que qualquer consulta isolada.
 */
@ApiTags('auditoria')
@ApiBearerAuth('jwt')
@Controller('auditoria')
@Papeis('ADMIN')
export class AuditoriaController {
  constructor(private readonly auditoria: AuditoriaService) {}

  @Get('consultas')
  @ApiOperation({ summary: 'Quem consultou o quê, paginado e filtrável' })
  consultas(@Query() dto: ConsultasQueryDto, @UsuarioAtual() u: UsuarioAutenticado) {
    return this.auditoria.listarConsultas(dto, u.organizationId);
  }

  @Get('resumo')
  @ApiOperation({ summary: 'Agregados do período e série diária para gráfico' })
  resumo(@Query() dto: ResumoQueryDto, @UsuarioAtual() u: UsuarioAutenticado) {
    return this.auditoria.resumo(dto, u.organizationId);
  }

  @Get('usuarios')
  @ApiOperation({
    summary: 'Quem já registrou consulta — opções do filtro "Usuário"',
    description:
      'Só quem TEM consulta registrada, escopado pela organização. Sem CPF na resposta: ' +
      'é lista de operadores, não de titulares.',
  })
  usuarios(@UsuarioAtual() u: UsuarioAutenticado) {
    return this.auditoria.usuariosComConsulta(u.organizationId);
  }

  /**
   * POST porque o CPF vai no CORPO. No caminho, ele entraria no log de acesso
   * do proxy — que não é nosso e não se apaga a pedido do titular.
   *
   * `@HttpCode(200)`: o padrão do Nest para POST é 201 Created, e aqui nada foi
   * criado. Devolver 201 numa consulta faria o cliente e qualquer monitoração
   * lerem escrita onde houve leitura, justo na rota que existe para provar que
   * a trilha não é escrita por endpoint.
   */
  @Post('trilha-cpf')
  @HttpCode(200)
  /* ── R-13: SO A OPERACAO INTERNA ──
     As demais rotas deste controller ja sao recortadas pela organizacao do
     ator. Esta nao: os blocos de `pessoa` e `enriquecimento` consultam a base
     compartilhada de titulares, que nao tem dono — entao um ADMIN de escritorio
     cliente confirmava a existencia de QUALQUER CPF e lia o nome e o historico
     de consultas dele, inclusive de titular nunca liberado a ele.
     A parte que interessa a um admin de escritorio — quem da equipe DELE
     consultou o que — continua acessivel em `GET /auditoria/consultas`, que e
     escopada. */
  @UseGuards(OrganizacaoInternaGuard)
  @ApiOperation({
    summary: 'Trilha completa de um CPF (LGPD art. 18): consultas e enriquecimentos',
    description:
      'Consulta, apesar do verbo: o CPF vai no corpo para não aparecer na URL nem no log de acesso.',
  })
  trilha(@Body() dto: TrilhaCpfDto, @UsuarioAtual() u: UsuarioAutenticado) {
    return this.auditoria.trilhaCpf(dto.cpf, u.organizationId);
  }
}
