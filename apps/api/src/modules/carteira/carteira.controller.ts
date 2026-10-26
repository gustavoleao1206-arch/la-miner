import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AssinaturaAtivaGuard } from '../../common/guards/assinatura-ativa.guard';
import { anonimizarIp } from '../../common/ip';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CarteiraService, type LoteCarteira } from './carteira.service';
import { filtrosDaQuery, loteDaQuery, type QueryDaFila } from './filtros-da-query';
import type { FaseProcesso } from '@miner/database';

/**
 * O recorte do módulo de pré-precatórios.
 *
 * A lista fechada, e não "tudo menos PRECATORIO_EXPEDIDO": uma fase nova no
 * enum entraria sozinha neste módulo se fosse por exclusão, e a primeira
 * notícia seria o cliente vendo algo que ninguém decidiu pôr aqui. Mesmo
 * raciocínio de `FASES_DISTRIBUIVEIS`. Uma constante só porque a lista e o
 * resumo precisam do MESMO recorte — duas cópias divergem.
 */
const FASES_PRE_PRECATORIO: FaseProcesso[] = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
];
import { PrismaService } from '../../prisma/prisma.service';
import { cpfEmTexto } from '../cadastro/documento';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';
import { Papeis, UsuarioAtual } from '../../common/decorators/papeis.decorator';

@ApiTags('carteira')
@ApiBearerAuth('jwt')
@Controller('carteira')
/* Suspensão com dentes: cliente com assinatura suspensa recebe 402 e para de ler
   a carteira — os dados dele continuam intactos, esperando a regularização. Só
   avalia CLIENTE; a operação interna não tem assinatura. */
@UseGuards(AssinaturaAtivaGuard)
/* Sem esta linha, o RolesGuard liberava a rota para QUALQUER autenticado —
   inclusive papel CLIENTE — expondo os 3.974 documentos com telefone, e-mail
   e cidade. Era a única entre os controllers sem papéis declarados.

   CLIENTE entrou aqui na Fase B, mas o que torna isso seguro NÃO é o papel: é o
   `escopoProcessos` do serviço, que troca "processos que a org POSSUI" por
   "processos LIBERADOS a ela". Sem aquele filtro, esta linha seria exatamente o
   vazamento que o parágrafo acima descreve. `resumo` segue fora — ver lá. */
@Papeis('ADMIN', 'OPERADOR', 'CLIENTE')
export class CarteiraController {
  constructor(
    private readonly carteira: CarteiraService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('tribunais')
  @ApiOperation({ summary: 'Catálogo de tribunais, suas UFs e os lotes existentes' })
  async tribunais(@UsuarioAtual() usuario: UsuarioAutenticado) {
    return this.carteira.tribunais(usuario);
  }

  @Get('resumo')
  @ApiOperation({ summary: 'Indicadores consolidados da carteira' })
  /* Aberto ao CLIENTE, mas PROJETADO: `enriquecidas`/`pendentes` são métrica da
     operação de enriquecimento e somem da resposta dele. Manter a rota fechada
     obrigaria o cliente a ter um dashboard próprio só por causa de dois campos —
     escopar e projetar sai mais barato e deixa UMA tela. */
  async resumo(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.carteira.resumo({ usuario, lote: loteDaQuery(tribunal, exercicio) });
  }

  @Get('painel')
  @ApiOperation({ summary: 'BI: alcançabilidade da carteira e operação em agregado' })
  async painel(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    /* `hoje` vem do cliente porque "atrasada" depende do fuso de quem olha.
       Formato validado aqui: um valor livre chegaria ao `new Date()` e uma
       string inválida viraria Invalid Date, que o Prisma rejeita com erro de
       500 — 400 com motivo é a resposta honesta. */
    @Query('hoje') hoje?: string,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    if (hoje !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(hoje)) {
      throw new BadRequestException('O parâmetro "hoje" deve estar no formato AAAA-MM-DD.');
    }
    return this.carteira.painel({
      usuario,
      hoje,
      lote: loteDaQuery(tribunal, exercicio),
    });
  }

  @Get('mapa')
  @ApiOperation({ summary: 'Requerentes por UF, para o heatmap do mapa' })
  async mapa(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.carteira.mapa({
      usuario,
      lote: loteDaQuery(tribunal, exercicio),
    });
  }

  @Get('tendencias')
  @ApiOperation({ summary: 'Série diária dos indicadores, para os sparklines' })
  async tendencias(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('dias') dias?: string,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.carteira.tendencias({
      organizationId: usuario.organizationId,
      lote: loteDaQuery(tribunal, exercicio),
      dias: dias ? Math.min(90, Math.max(2, Number(dias) || 30)) : 30,
    });
  }

  /**
   * A FILA DE TRABALHO — a carteira como lista acionável.
   *
   * Rota separada da `buscar` porque a UNIDADE de resposta é outra: `buscar`
   * devolve PESSOAS (entra-se por CPF ou nome), a fila devolve PROCESSOS, que é
   * onde moram estágio, prioridade, responsável, etiqueta e contato.
   *
   * ── SEM TRILHA DE CONSULTA, AO CONTRÁRIO DA BUSCA ──
   *
   * A `buscar` grava `ConsultaCliente` porque ela é a porta de "procurar uma
   * pessoa pelo CPF" — o acesso a dado pessoal que a LGPD manda registrar.
   * A fila é a lista de trabalho da carteira que o cliente já possui: gravar
   * uma linha de auditoria a cada troca de filtro encheria a trilha de ruído e
   * afogaria justamente as consultas que ela existe para evidenciar.
   */
  @Get('fila')
  @ApiOperation({
    summary: 'Fila de trabalho: processos da carteira com o estado do CRM, filtráveis',
    description:
      'Filtra por estágio, prioridade, responsável, etiqueta, "ainda sem contato", ' +
      '"sem contato há N dias" (frioDias=7|15|30) e "com tarefa atrasada". Processo sem ' +
      'overlay conta como NOVO, prioridade NORMAL, sem responsável e sem contato — que é ' +
      'o estado da maior parte da carteira no começo de cada mês.',
  })
  async fila(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('termo') termo?: string,
    @Query('estagio') estagio?: string,
    @Query('prioridade') prioridade?: string,
    @Query('responsavelId') responsavelId?: string,
    @Query('etiquetaId') etiquetaId?: string,
    @Query('semContato') semContato?: string,
    @Query('frioDias') frioDias?: string,
    @Query('tarefaAtrasada') tarefaAtrasada?: string,
    @Query('pagina') pagina = '1',
    @Query('porPagina') porPagina = '25',
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    return this.carteira.fila({
      ...filtrosDaQuery({
        termo,
        estagio,
        prioridade,
        responsavelId,
        etiquetaId,
        semContato,
        frioDias,
        tarefaAtrasada,
      }),
      pagina: Math.max(1, Number(pagina) || 1),
      porPagina: Math.min(100, Math.max(1, Number(porPagina) || 25)),
      lote: loteDaQuery(tribunal, exercicio),
      usuario,
    });
  }

  /**
   * O MÓDULO DE PRÉ-PRECATÓRIOS.
   *
   * ── POR QUE ROTA PRÓPRIA, E NÃO UM FILTRO NA FILA ──
   *
   * Porque duas coisas mudam juntas, e uma delas não é filtro:
   *
   *  1. O RECORTE. Pré-precatório não tem exercício, e o lote é
   *     (tribunal + exercício). Na fila comum, a operação interna cai em
   *     TRF5/2027 e eles simplesmente não aparecem — o time não enxergava o que
   *     o cliente já estava recebendo.
   *  2. O SENTIDO. A carteira é sobre precatórios; estes são o estágio anterior,
   *     de 42 tribunais, com valor indicativo e sem exigibilidade formada.
   *     Misturá-los numa aba de filtro faria a lista mudar de natureza sem
   *     mudar de nome.
   *
   * O que NÃO muda: a montagem das condições, o overlay do CRM, a paginação e a
   * projeção são os MESMOS da fila. Uma consulta própria divergiria da fila no
   * primeiro ajuste de filtro — é a lição que `condicoes-da-fila.ts` carrega.
   *
   * Sem `@Papeis` próprio: herda o da classe. O cliente também alcança, e deve —
   * é ele quem recebe estes processos no sorteio.
   */
  @Get('pre-precatorios')
  @ApiOperation({
    summary: 'Os processos em fase ANTERIOR ao precatório expedido, de todos os tribunais',
    description:
      'Mesma fila, mesmos filtros, sem recorte de lote — pré-precatório não tem ' +
      'exercício orçamentário, então nenhum lote o alcançaria.',
  })
  async prePrecatorios(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    /* A query inteira, e não um parâmetro por linha: são onze, e a rota de
       resumo logo abaixo lê EXATAMENTE os mesmos. Duas listas de onze divergem
       na primeira que ganhar um filtro novo. */
    @Query() q: QueryDaFila & { pagina?: string; porPagina?: string },
  ) {
    return this.carteira.fila({
      ...filtrosDaQuery(q),
      fases: FASES_PRE_PRECATORIO,
      /* Os 1.050 que não são Fazenda (decisão de 03/10/2026). Ver o campo. */
      semForaDaDistribuicao: true,
      pagina: Math.max(1, Number(q.pagina) || 1),
      porPagina: Math.min(100, Math.max(1, Number(q.porPagina) || 25)),
      semLote: true,
      usuario,
    });
  }

  /**
   * Os números em cima da lista do módulo: cartões e chips com contagem.
   *
   * Mesmo recorte da rota acima (as quatro fases, sem lote, mesmo escopo), lido
   * pelo MESMO `filtrosDaQuery` — o chip conta o que a lista mostraria. O que o
   * serviço ignora de propósito (os três chips) está explicado nele.
   */
  @Get('pre-precatorios/resumo')
  @ApiOperation({
    summary: 'Resumo dos pré-precatórios: total, soma indicativa, por fase, esfera e veredito do CPF',
  })
  async resumoPrePrecatorios(
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query() q: QueryDaFila,
  ) {
    return this.carteira.resumoDaFila({
      ...filtrosDaQuery(q),
      fases: FASES_PRE_PRECATORIO,
      /* O mesmo recorte da lista: o cartão soma o que a lista mostra. */
      semForaDaDistribuicao: true,
      semLote: true,
      usuario,
    });
  }

  @Get('buscar')
  @ApiOperation({ summary: 'Busca no banco interno (nunca consulta provider externo)' })
  async buscar(
    @Req() req: Request,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Query('termo') termo?: string,
    @Query('uf') uf?: string,
    @Query('pagina') pagina = '1',
    @Query('porPagina') porPagina = '20',
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
  ) {
    const p = Math.max(1, Number(pagina) || 1);
    const pp = Math.min(100, Math.max(1, Number(porPagina) || 20));
    const resultado = await this.carteira.buscar({
      termo,
      uf,
      pagina: p,
      porPagina: pp,
      lote: loteDaQuery(tribunal, exercicio),
      usuario,
    });

    // Trilha de auditoria: quem consultou o quê. Sustenta a política de
    // exibição de contato completo perante a LGPD. `usuario` agora vem do
    // decorator (sempre presente atrás do guard), não de um cast de req.user.
    if (termo) {
      const digitos = termo.replace(/\D/g, '');
      await this.prisma.consultaCliente.create({
        data: {
          userId: usuario.id,
          tipo: digitos.length >= 6 ? 'CPF' : 'NOME',
          termo: termo.slice(0, 120),
          /* O CPF é extraído do texto, e não só do caso "a string inteira tem
             11 dígitos".
             `39053344705 81` é uma busca real — CPF mais DDD — e ali `digitos`
             dá 13, então a coluna nascia NULA e o CPF ficava só no texto. A
             trilha do titular ainda o encontrava por `termo contains`, mas o
             termo agora tem prazo: o que não estiver estruturado some com ele.
             Extrair AQUI, onde o texto acabou de ser digitado, é melhor que
             inferir no cron 90 dias depois — e faz a promoção da retenção ser
             um acerto de acervo antigo, não uma máquina permanente de adivinhar. */
          cpfConsultado: digitos.length === 11 ? digitos : cpfEmTexto(termo),
          totalResultados: resultado.total,
          contatoExibido: true,
          /* Truncado na origem: a trilha responde QUEM consultou (o usuário);
             o IP é coadjuvante e não precisa identificar a máquina. */
          ip: anonimizarIp(req.ip),
          userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
        },
      }).catch(() => undefined); // auditoria não pode derrubar a consulta
    }

    return resultado;
  }

  /**
   * Um processo por inteiro — a página do CRM.
   *
   * `ParseUUIDPipe` responde 400 a id malformado. Sem ele o texto ia direto
   * para uma coluna @db.Uuid e o Postgres devolvia erro de sintaxe, que sobe
   * como 500: um erro do cliente disfarçado de falha do servidor, poluindo o
   * monitoramento com alarme que ninguém consegue agir.
   *
   * ABERTO ao CLIENTE desde a Fase B. O comentário antigo dizia que faltava o
   * vínculo User→Pessoa para isso; o vínculo que faltava acabou sendo outro, e
   * melhor: a LIBERAÇÃO (ProcessoLiberado). O cliente abre o processo que lhe foi
   * liberado — e só esse, porque `escopoProcessos` entra no mesmo `where` que
   * resolve o 404. O que ele recebe passa ainda pela projeção do cliente: sem
   * provedor, sem custo, e sem o CRM de nenhum outro tenant.
   */
  @Get('processos/:id')
  @ApiOperation({ summary: 'Processo completo: dados, partes e linha do tempo' })
  async processo(
    @Req() req: Request,
    @UsuarioAtual() usuario: UsuarioAutenticado,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const processo = await this.carteira.processo(id, usuario);
    if (!processo) throw new NotFoundException('Processo não encontrado');

    /* A página exibe nome, CPF e contato das partes — é consulta a dado pessoal
       e precisa da mesma trilha da busca. Só depois do 404: nada foi divulgado
       quando não há o que divulgar, e registrar a tentativa como consulta
       inflaria os indicadores da auditoria. */
    const partes = processo.partes;
    await this.prisma.consultaCliente
      .create({
        data: {
          userId: usuario.id,
          tipo: 'PROCESSO',
          /* O número do precatório, não o UUID: quem lê a auditoria depois
             precisa saber QUAL processo foi aberto sem ter de cruzar id. */
          termo: processo.numeroPrecatorio.slice(0, 120),
          /* Só quando há uma única parte. Com mais de uma não existe "o CPF
             consultado" — a coluna é singular e escolher um deles registraria
             mentira sobre os demais. A rastreabilidade fica pelo `termo`. */
          cpfConsultado: partes.length === 1 ? partes[0].pessoa.cpf : null,
          totalResultados: partes.length,
          /* Medido, não presumido. `buscar` fixa `true`; aqui dá para saber: se
             a parte está PENDENTE e sem telefone, e-mail ou endereço, a tela
             não exibiu contato nenhum, e marcar que exibiu inflaria justamente
             o indicador que a auditoria usa para dimensionar exposição. */
          contatoExibido: partes.some(
            (p) =>
              p.pessoa.telefones.length > 0 ||
              p.pessoa.emails.length > 0 ||
              p.pessoa.enderecos.length > 0,
          ),
          /* Truncado na origem: a trilha responde QUEM consultou (o usuário);
             o IP é coadjuvante e não precisa identificar a máquina. */
          ip: anonimizarIp(req.ip),
          userAgent: req.headers['user-agent']?.slice(0, 200) ?? null,
        },
      })
      .catch(() => undefined); // auditoria não pode derrubar a leitura

    return processo;
  }
}
