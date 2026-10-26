import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { AssinaturaAtivaGuard } from '../../common/guards/assinatura-ativa.guard';
import { NegociacaoService } from './negociacao.service';
import {
  AjustarPropostaDto,
  CriarPropostaDto,
  CronogramaDto,
  DecisaoDto,
} from './negociacao.dto';
import type { Autor } from '../crm/crm.service';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { Papeis, UsuarioAtual } from '../../common/decorators/papeis.decorator';

/**
 * A NEGOCIAÇÃO de um precatório.
 *
 * Controller próprio, e não mais uma seção do CrmController — que já passa de
 * 290 linhas de rota. Mas as DUAS travas são copiadas com intenção, e não por
 * hábito: `AssinaturaAtivaGuard` NÃO é global (é escrito controller a
 * controller), e esquecê-lo aqui deixaria um cliente suspenso ou cancelado
 * registrando propostas de graça, sem que nenhum teste acusasse.
 */
@ApiTags('negociacao')
@ApiBearerAuth('jwt')
@Controller('carteira/processos/:id/negociacao')
@UseGuards(AssinaturaAtivaGuard)
@Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
export class NegociacaoController {
  constructor(private readonly negociacao: NegociacaoService) {}

  /** O autor vem SEMPRE do token — nunca de um campo do corpo. */
  private autor(usuario: UsuarioAutenticado): Autor {
    return {
      id: usuario.id,
      papel: usuario.papel,
      organizationId: usuario.organizationId,
      tipo: usuario.tipo,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'A negociação do processo: todas as rodadas, a viva e a aceita',
    description:
      'Traz também a base de cálculo ATUAL do processo, ao lado da congelada em cada rodada — ' +
      'é assim que a tela avisa "a base mudou depois desta proposta" em vez de deixar os dois ' +
      'números se contradizerem em silêncio.',
  })
  async resumo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.negociacao.resumo(id, this.autor(usuario));
  }

  @Post()
  @ApiOperation({
    summary: 'Abre a rodada seguinte (a anterior vira SUBSTITUIDA)',
    description:
      'É assim que se "ajusta" uma proposta já apresentada: criando a próxima. O que se ' +
      'preserva com isso é a contraproposta anterior — o número de onde se saiu, que é o que ' +
      'explica onde se chegou.',
  })
  async criar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CriarPropostaDto,
  ) {
    return this.negociacao.criar(id, this.autor(usuario), dto);
  }

  @Patch(':propostaId')
  @ApiOperation({ summary: 'Ajusta o RASCUNHO (409 em qualquer outro estado)' })
  async ajustar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Body() dto: AjustarPropostaDto,
  ) {
    return this.negociacao.ajustar(id, propostaId, this.autor(usuario), dto);
  }

  @Post(':propostaId/enviar')
  @ApiOperation({
    summary: 'Apresenta a proposta ao titular: congela a rodada e move o funil para PROPOSTA',
  })
  async enviar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
  ) {
    return this.negociacao.enviar(id, propostaId, this.autor(usuario));
  }

  @Post(':propostaId/decisao')
  @ApiOperation({
    summary: 'Registra a resposta do titular',
    description:
      'ACEITA move o funil para FECHADO. RECUSADA NÃO mexe no estágio: recusar uma proposta ' +
      'não encerra a negociação, e mandar o processo para PERDIDO aqui tiraria da mesa um ' +
      'titular que talvez aceite a rodada seguinte.',
  })
  async decidir(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Body() dto: DecisaoDto,
  ) {
    return this.negociacao.decidir(id, propostaId, this.autor(usuario), dto.decisao);
  }

  @Get(':propostaId/relatorio')
  @ApiOperation({
    summary: 'O conteúdo da folha da proposta, montado por DESTINO',
    description:
      'A folha do TITULAR nunca RECEBE a margem do escritório — ela não é apagada, é que nunca ' +
      'entra no pacote. Campo novo acrescentado no futuro não vaza por omissão. Sem `destino`, ' +
      'o padrão é TITULAR: um parâmetro esquecido entrega a folha SEM margem, não com ela. ' +
      'Imprimir deixa trilha: é o momento em que nome e CPF saem do sistema em papel.',
  })
  async relatorio(
    @Req() req: Request,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Query('destino') destino?: string,
  ) {
    if (destino !== undefined && destino !== 'TITULAR' && destino !== 'INTERNO') {
      throw new BadRequestException('"destino" deve ser TITULAR ou INTERNO.');
    }
    return this.negociacao.relatorio(id, propostaId, this.autor(usuario), destino ?? 'TITULAR', {
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });
  }

  // ── Parcelamento ──

  @Get(':propostaId/parcelas')
  @ApiOperation({
    summary: 'O cronograma de pagamento ao titular',
    description:
      '"Vencida" vem calculada na leitura (vencimento < hoje) e NÃO dispara nada: não bloqueia ' +
      'cliente, não suspende assinatura, não cobra ninguém. O escritório atrasar o pagamento ao ' +
      'titular DELE não é motivo para tirar o acesso dele.',
  })
  async cronograma(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
  ) {
    return this.negociacao.cronograma(id, propostaId, this.autor(usuario));
  }

  @Post(':propostaId/parcelas')
  @ApiOperation({
    summary: 'Monta (ou refaz) o cronograma',
    description:
      'Pode ser montado JÁ NO RASCUNHO: "recebo em 6 vezes" é parte do que o titular aceita, e ' +
      'as parcelas saem impressas na folha que ele assina. Refazer apaga e gera de novo — não ' +
      'existe edição de parcela isolada, e é essa ausência que faz a soma fechar por construção. ' +
      'Depois que alguma parcela é PAGA, o cronograma congela.',
  })
  async gerarCronograma(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Body() dto: CronogramaDto,
  ) {
    return this.negociacao.gerarCronograma(id, propostaId, this.autor(usuario), dto);
  }

  @Post(':propostaId/parcelas/:numero/baixa')
  @ApiOperation({
    summary: 'Registra que a parcela saiu do caixa (só GESTOR ou ADMIN)',
    description:
      'Idempotente: chamar duas vezes não reescreve a data da primeira — o duplo clique moveria ' +
      'a data do pagamento, que é justamente o que vale numa conferência. A restrição a gestor ' +
      'mora no serviço, e não num @Papeis: "gestor" não é papel, é uma marca no usuário que ' +
      'convive com o papel CLIENTE, e o decorator não a enxerga.',
  })
  async baixar(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.negociacao.baixar(id, propostaId, numero, this.autor(usuario));
  }

  @Delete(':propostaId/parcelas/:numero/baixa')
  @ApiOperation({ summary: 'Desfaz a baixa (só GESTOR ou ADMIN)' })
  async desfazerBaixa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
    @Param('numero', ParseIntPipe) numero: number,
  ) {
    return this.negociacao.desfazerBaixa(id, propostaId, numero, this.autor(usuario));
  }

  @Delete(':propostaId/parcelas')
  @ApiOperation({ summary: 'Apaga o cronograma inteiro (409 se alguma parcela já foi paga)' })
  async removerCronograma(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
  ) {
    return this.negociacao.removerCronograma(id, propostaId, this.autor(usuario));
  }

  @Delete(':propostaId')
  @ApiOperation({ summary: 'Descarta o RASCUNHO (o resto é histórico e se cancela, não se apaga)' })
  async remover(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('propostaId', ParseUUIDPipe) propostaId: string,
  ) {
    return this.negociacao.remover(id, propostaId, this.autor(usuario));
  }
}
