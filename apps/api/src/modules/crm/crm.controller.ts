import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AssinaturaAtivaGuard } from '../../common/guards/assinatura-ativa.guard';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CrmService, type Autor } from './crm.service';
import {
  diasDaQuery,
  filtrosDaQuery,
  loteDaQuery,
} from '../carteira/filtros-da-query';
import {
  AcaoEmLoteDto,
  CriarAnotacaoDto,
  CriarEtiquetaDto,
  CriarTarefaDto,
  DefinirEtiquetasDto,
  DefinirPrioridadeDto,
  DefinirResponsavelDto,
  EditarAnotacaoDto,
  DefinirEstagioDto,
  EditarTarefaDto,
  RegistrarContatoDto,
} from './crm.dto';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { Papeis, UsuarioAtual } from '../../common/decorators/papeis.decorator';

/**
 * Escrita do CRM sobre um processo.
 *
 * Prefixo `carteira` para as URLs ficarem coerentes com a leitura, que mora em
 * CarteiraController (`GET /carteira/processos/:id`). São controllers separados
 * porque as responsabilidades são diferentes — um lê a carteira importada, o
 * outro mantém o estado que a equipe escreve — e juntar tudo faria um arquivo
 * que ninguém termina de ler.
 */
@ApiTags('crm')
@ApiBearerAuth('jwt')
@Controller('carteira')
/* Suspenso não escreve — mesma trava da leitura. */
@UseGuards(AssinaturaAtivaGuard)
/* CLIENTE escreve no CRM desde a Fase D — no OVERLAY dele. O que torna isso
   seguro não é o papel: é o `processoVisivel` do serviço, que usa o MESMO
   `escopoProcessos` da leitura. O cliente só escreve em processo liberado a ele, e
   o que escreve (anotação, tarefa, prioridade, responsável) nasce carimbado com a
   org dele — invisível para o time interno e para os outros clientes. */
@Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  /** O autor vem SEMPRE do token — nunca de um campo do corpo, que o cliente controla. */
  private autor(usuario: UsuarioAutenticado): Autor {
    return {
      id: usuario.id,
      papel: usuario.papel,
      organizationId: usuario.organizationId,
      tipo: usuario.tipo,
    };
  }

  // ── Anotações ──

  @Post('processos/:id/anotacoes')
  @ApiOperation({ summary: 'Cria uma anotação no processo' })
  async criarAnotacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CriarAnotacaoDto,
  ) {
    return this.crm.criarAnotacao(id, this.autor(usuario), dto);
  }

  @Patch('processos/:id/anotacoes/:anotacaoId')
  @ApiOperation({ summary: 'Edita a própria anotação' })
  async editarAnotacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('anotacaoId', ParseUUIDPipe) anotacaoId: string,
    @Body() dto: EditarAnotacaoDto,
  ) {
    return this.crm.editarAnotacao(id, anotacaoId, this.autor(usuario), dto);
  }

  @Delete('processos/:id/anotacoes/:anotacaoId')
  @ApiOperation({ summary: 'Remove uma anotação (autor, ou ADMIN para atender exclusão do titular)' })
  async removerAnotacao(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('anotacaoId', ParseUUIDPipe) anotacaoId: string,
  ) {
    return this.crm.removerAnotacao(id, anotacaoId, this.autor(usuario));
  }

  // ── Tarefas e follow-ups ──

  @Post('processos/:id/tarefas')
  @ApiOperation({ summary: 'Cria uma tarefa ou follow-up no processo' })
  async criarTarefa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CriarTarefaDto,
  ) {
    return this.crm.criarTarefa(id, this.autor(usuario), dto);
  }

  @Patch('processos/:id/tarefas/:tarefaId')
  @ApiOperation({ summary: 'Edita, atribui, conclui ou reabre uma tarefa' })
  async editarTarefa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tarefaId', ParseUUIDPipe) tarefaId: string,
    @Body() dto: EditarTarefaDto,
  ) {
    return this.crm.editarTarefa(id, tarefaId, this.autor(usuario), dto);
  }

  @Delete('processos/:id/tarefas/:tarefaId')
  @ApiOperation({ summary: 'Remove uma tarefa (quem criou, ou ADMIN)' })
  async removerTarefa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tarefaId', ParseUUIDPipe) tarefaId: string,
  ) {
    return this.crm.removerTarefa(id, tarefaId, this.autor(usuario));
  }

  /**
   * Fica ANTES de `processos/:id/...` na leitura do arquivo, mas o Nest casa
   * por caminho literal e não por ordem aqui — `tarefas/minhas` não colide com
   * nada. O `:id` de processo é um segmento diferente.
   */
  @Get('tarefas/minhas')
  @ApiOperation({ summary: 'Tarefas abertas do usuário, mais as sem responsável da organização' })
  async minhasTarefas(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.crm.minhasTarefas(this.autor(usuario));
  }

  /**
   * Ação em massa sobre a seleção da fila.
   *
   * `processos/lote` não colide com `processos/:id/...`: são contagens de
   * segmento diferentes, e o Nest casa por caminho literal.
   */
  @Patch('processos/lote')
  @ApiOperation({
    summary: 'Aplica a mesma mudança a vários processos (atribuir, priorizar, mover no funil)',
    description:
      'Ids invisíveis são IGNORADOS e contados, em vez de derrubarem o lote inteiro: a lista ' +
      'vem de uma tela que pode estar desatualizada. A resposta diz quantos foram, quantos ' +
      'de fato mudaram de valor e quantos ficaram de fora.',
  })
  async acaoEmLote(@UsuarioAtual() usuario: UsuarioAutenticado, @Body() dto: AcaoEmLoteDto) {
    return this.crm.acaoEmLote(this.autor(usuario), {
      processoIds: dto.processoIds,
      estagio: dto.estagio,
      motivoPerda: dto.motivoPerda,
      prioridade: dto.prioridade,
      responsavelId: dto.responsavelId,
      etiquetaIds: dto.etiquetaIds,
    });
  }

  // ── Funil comercial ──

  @Patch('processos/:id/estagio')
  @ApiOperation({
    summary: 'Move o processo no funil (NOVO → EM_CONTATO → PROPOSTA → FECHADO/PERDIDO)',
  })
  async definirEstagio(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DefinirEstagioDto,
  ) {
    return this.crm.definirEstagio(id, this.autor(usuario), {
      estagio: dto.estagio,
      motivoPerda: dto.motivoPerda,
    });
  }

  @Post('processos/:id/contatos')
  @ApiOperation({
    summary: 'Registra uma tentativa de contato',
    description:
      'Estruturado, para poder contar: quantas ligações até uma proposta, quantos números ' +
      'errados, quem ainda não foi tocado. Tira o processo de NOVO automaticamente.',
  })
  async registrarContato(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RegistrarContatoDto,
  ) {
    return this.crm.registrarContato(id, this.autor(usuario), {
      canal: dto.canal,
      resultado: dto.resultado,
      observacao: dto.observacao,
    });
  }

  @Get('processos/:id/contatos')
  @ApiOperation({ summary: 'Tentativas de contato deste processo, da mais recente para a mais antiga' })
  async contatos(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crm.contatos(id, this.autor(usuario));
  }

  @Get('funil')
  @ApiOperation({
    summary: 'O funil em números: quantos processos da carteira em cada estágio',
    description:
      'Inclui `semContato`, que é o número que diz se a carteira está sendo TRABALHADA e não ' +
      'apenas triada.',
  })
  async funil(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
    @Query('dias') dias?: string,
    @Query('termo') termo?: string,
    @Query('estagio') estagio?: string,
    @Query('prioridade') prioridade?: string,
    @Query('responsavelId') responsavelId?: string,
    @Query('etiquetaId') etiquetaId?: string,
    @Query('semContato') semContato?: string,
    @Query('frioDias') frioDias?: string,
    @Query('tarefaAtrasada') tarefaAtrasada?: string,
  ) {
    /* Os MESMOS filtros da fila, lidos pelo MESMO código. Sem eles, ligar
       "responsável = Ana" na tela deixaria o chip contando a carteira inteira e
       a lista mostrando a de Ana — a mesma classe de divergência que já apareceu
       aqui como "funil 500, fila 183". */
    return this.crm.funil(this.autor(usuario), {
      lote: loteDaQuery(tribunal, exercicio),
      dias: diasDaQuery(dias),
      filtros: filtrosDaQuery({
        termo,
        estagio,
        prioridade,
        responsavelId,
        etiquetaId,
        semContato,
        frioDias,
        tarefaAtrasada,
      }),
    });
  }

  @Get('funil/safras')
  @ApiOperation({
    summary: 'Conversão por SAFRA: dos N que entraram no ciclo X, quantos estão hoje em cada estágio',
    description:
      'Agrupado pela COMPETÊNCIA do ciclo, não pela data de liberação — regerar um mês passado ' +
      'jogaria aquele ciclo na safra errada. Devolve também "noRecorte", quantos daquela safra ' +
      'caem no lote que a tela mostra: o sorteio do ciclo não filtra por tribunal, e sem esse ' +
      'número o total do ciclo pareceria não bater com a fila. Organização INTERNA não tem ' +
      'safra (é ela quem libera) e recebe lista vazia.',
  })
  async safras(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('meses') meses?: string,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.crm.safras(this.autor(usuario), {
      meses: meses ? Number(meses) : undefined,
      lote: loteDaQuery(tribunal, exercicio),
    });
  }

  @Get('funil/perdas')
  @ApiOperation({
    summary: 'Os motivos de perda escritos, do mais recente para o mais antigo',
    description:
      'Texto livre de propósito: com "perdido" ainda perto de zero, categorias inventadas ' +
      'produziriam um gráfico em que "Outro" domina. As categorias saem daqui quando houver ' +
      'o que ler.',
  })
  async perdas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('limite') limite?: string,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.crm.perdas(this.autor(usuario), {
      limite: limite ? Number(limite) : undefined,
      lote: loteDaQuery(tribunal, exercicio),
    });
  }

  // ── Prioridade e responsável ──

  @Patch('processos/:id/prioridade')
  @ApiOperation({ summary: 'Define a prioridade do processo' })
  async definirPrioridade(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DefinirPrioridadeDto,
  ) {
    return this.crm.definirPrioridade(id, this.autor(usuario), dto.prioridade);
  }

  @Patch('processos/:id/responsavel')
  @ApiOperation({ summary: 'Define o responsável (null remove)' })
  async definirResponsavel(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DefinirResponsavelDto,
  ) {
    return this.crm.definirResponsavel(id, this.autor(usuario), dto.responsavelId);
  }

  // ── Etiquetas ──

  @Get('etiquetas')
  @ApiOperation({ summary: 'Vocabulário de etiquetas da organização' })
  async listarEtiquetas(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.crm.listarEtiquetas(usuario.organizationId);
  }

  @Post('etiquetas')
  @ApiOperation({ summary: 'Cria uma etiqueta (idempotente: nome repetido devolve a existente)' })
  async criarEtiqueta(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Body() dto: CriarEtiquetaDto,
  ) {
    return this.crm.criarEtiqueta(usuario.organizationId, dto);
  }

  @Put('processos/:id/etiquetas')
  @ApiOperation({ summary: 'Substitui o conjunto de etiquetas do processo' })
  async definirEtiquetas(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DefinirEtiquetasDto,
  ) {
    return this.crm.definirEtiquetas(id, this.autor(usuario), dto.etiquetaIds);
  }

  // ── Equipe ──

  @Get('equipe')
  @ApiOperation({ summary: 'Usuários que podem ser responsáveis por um processo' })
  async equipe(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.crm.equipe(usuario.organizationId);
  }
}
