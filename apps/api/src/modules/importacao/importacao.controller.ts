import {
  BadRequestException, Controller, Get, NotFoundException, Param, Post, Query, Req, Res,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { ImportacaoService } from './importacao.service';
import type { LoteCarteira } from '../carteira/carteira.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Papeis, UsuarioAtual, type UsuarioAutenticado } from '../../common/decorators/papeis.decorator';

const MAX_MB = 25;

@ApiTags('importacao')
@ApiBearerAuth('jwt')
@Controller('importacao')
@Papeis('ADMIN', 'OPERADOR')
export class ImportacaoController {
  constructor(
    private readonly servico: ImportacaoService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Recebe a planilha CSV/XLSX e a coloca na fila de processamento',
    description:
      'Valida na hora (cabeçalho, perfil, tribunal, duplicidade) e devolve 202 com o id. ' +
      'O processamento acontece no worker; acompanhe por GET /importacao/:id. ' +
      'Com dryRun=true nada é gravado e a resposta é a simulação, síncrona.',
  })
  /* O código sai do corpo do método, não de um `@HttpCode` fixo: a MESMA rota
     responde duas coisas diferentes. A simulação é um cálculo que terminou
     (200); a importação de verdade é um aceite (202), e o corpo traz o id para
     acompanhar em vez dos números da carga, que nesse instante não existem. */
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('arquivo', {
      limits: { fileSize: MAX_MB * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        /* `.xls` (Excel 97-2003) SAIU. Só o SheetJS lia aquele formato binário,
           e ele carregava uma vulnerabilidade alta sem correção publicada —
           manter a biblioteca por causa de um formato que nunca foi usado aqui
           (o histórico tem uma importação, .xlsx) seria a troca errada.
           A mensagem diz o que fazer, em vez de só recusar. */
        if (/\.xls$/i.test(file.originalname)) {
          return cb(
            new BadRequestException(
              'O formato .xls (Excel 97-2003) não é mais aceito. ' +
                'Abra o arquivo no Excel e salve como .xlsx.',
            ),
            false,
          );
        }
        const ok = /\.(csv|xlsx)$/i.test(file.originalname);
        cb(ok ? null : new BadRequestException('Envie um arquivo .csv ou .xlsx'), ok);
      },
    }),
  )
  async importar(
    @UploadedFile() arquivo: Express.Multer.File,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Query('dryRun') dryRun?: string,
    @Query('tribunal') tribunal?: string,
    @Query('exercicio') exercicio?: string,
    /**
     * O perfil de leitura, quando o tribunal vem DA PLANILHA.
     *
     * ── POR QUE ISTO FALTAVA, E O QUE O SILÊNCIO CUSTAVA ──
     *
     * O serviço aceita `perfilId` desde 04/09/2026, o worker sabe processar
     * carga multi-tribunal e o perfil "Pré-precatórios (multi-tribunal)" está
     * gravado. Só que NINGUÉM passava o parâmetro: um `grep perfilId` em toda a
     * `apps/api/src` não achava um único chamador fora do próprio serviço.
     *
     * O motor existia inteiro e não havia estrada até ele. A suíte não pegou
     * porque testava o serviço direto — que é justamente contornar o trecho que
     * faltava. Por isso o caso novo desta rota sobe pelo HTTP.
     */
    @Query('perfilId') perfilId?: string,
  ) {
    if (!arquivo) throw new BadRequestException('Nenhum arquivo enviado.');
    const u = req.user as UsuarioAutenticado;

    /* Os dois andam juntos, como na carteira: aceitar só o tribunal faria a
       planilha do TRF1 entrar no exercício padrão sem ninguém pedir. */
    if ((tribunal === undefined) !== (exercicio === undefined)) {
      throw new BadRequestException('Informe "tribunal" e "exercicio" juntos, ou nenhum dos dois.');
    }
    /* ⚠ PERFIL E TRIBUNAL SÃO EXCLUDENTES, e a recusa é explícita.
       Sem isto o `perfilId` venceria calado dentro do serviço: o operador
       escolheria TRF1 na tela, a planilha entraria pelo modo multi-tribunal, e
       a única pista seria o resumo da simulação dizendo outro destino. Recusar
       aqui transforma um engano silencioso numa mensagem. */
    if (perfilId !== undefined && (tribunal !== undefined || exercicio !== undefined)) {
      throw new BadRequestException(
        'Escolha o destino de um jeito só: "perfilId" (o tribunal vem da planilha) ' +
          'OU "tribunal" e "exercicio" juntos.',
      );
    }

    let lote: LoteCarteira | undefined;
    if (tribunal !== undefined && exercicio !== undefined) {
      const ano = Number(exercicio);
      if (!Number.isInteger(ano) || ano < 1988 || ano > 2100) {
        throw new BadRequestException('O "exercicio" deve ser um ano válido.');
      }
      lote = { tribunal: tribunal.toUpperCase().replace(/-/g, ''), exercicio: ano };
    }

    /* Só a string 'true' liga a simulação. Qualquer outro valor grava de
       verdade — o padrão seguro aqui é o comportamento explícito, e um
       `Boolean('false')` seria true, ligando dry-run sem querer. */
    const simulando = dryRun === 'true';

    const r = await this.servico.importar({
      arquivo,
      organizationId: u.organizationId,
      userId: u.id,
      lote,
      perfilId,
      dryRun: simulando,
    });

    res.status(simulando ? 200 : 202);
    return r;
  }

  /**
   * O estado de UMA importação — a rota que a tela consulta enquanto a carga roda.
   *
   * Nasceu com a fila: enquanto o trabalho cabia na requisição, o resultado
   * vinha na resposta do POST e não havia o que acompanhar. Agora a resposta é
   * só um id, e sem esta rota o operador ficaria com uma tela que diz "recebida"
   * e nunca mais muda.
   *
   * Devolve o resumo GRAVADO, e não recalculado: os campos de resultado moram na
   * própria importação justamente para esta consulta ser barata o bastante para
   * rodar em ciclo, sem varrer as linhas a cada segundo.
   */
  /**
   * OS PERFIS DE LEITURA DISPONÍVEIS.
   *
   * Existe para a tela poder oferecer o modo multi-tribunal pelo NOME. Sem ela,
   * escolher esse modo exigiria um uuid cravado no código do front — que
   * quebraria calado no dia em que o perfil fosse recriado, e que não existiria
   * de forma alguma num banco novo.
   *
   * ⚠ A ORDEM DESTE MÉTODO NO ARQUIVO É PARTE DA CORREÇÃO.
   *
   * Ele precisa vir ANTES de `@Get(':id')`. O Nest casa as rotas na ordem em
   * que são declaradas, então com `:id` primeiro a chamada a /importacao/perfis
   * entraria no handler de estado com `id = "perfis"` — e a resposta seria um
   * 404 de "importação não encontrada", que manda procurar o defeito no lugar
   * errado.
   */
  @Get('perfis')
  @ApiOperation({ summary: 'Perfis de leitura de planilha disponíveis' })
  async perfis() {
    const perfis = await this.prisma.perfilImportacao.findMany({
      where: { ativo: true },
      orderBy: [{ tribunalId: 'asc' }, { nome: 'asc' }],
      select: {
        id: true,
        nome: true,
        tribunal: { select: { sigla: true } },
      },
    });

    return perfis.map((p) => ({
      id: p.id,
      nome: p.nome,
      /* `tribunal` nulo NÃO é dado faltando: é a declaração de que este perfil
         lê o tribunal de uma coluna. O campo derivado evita que cada cliente
         reinvente esse teste — e divirja. */
      tribunal: p.tribunal?.sigla ?? null,
      multiTribunal: p.tribunal === null,
    }));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Estado e resultado de uma importação' })
  async estado(@Param('id') id: string, @UsuarioAtual() u: UsuarioAutenticado) {
    const imp = await this.prisma.importacao.findFirst({
      /* Amarrado à organização, como a rota de erros: sem isto bastaria
         adivinhar um uuid para ler o andamento da carga de outro tenant. */
      where: { id, organizationId: u.organizationId },
      select: {
        id: true, arquivoNome: true, status: true, mensagemErro: true,
        totalLinhas: true, processadas: true, sucesso: true, falhas: true, ignoradas: true,
        processosCriados: true, processosAtualizados: true, processosInalterados: true,
        enfileirados: true, criadoEm: true, iniciadoEm: true, concluidoEm: true,
        exercicio: true,
        tribunal: { select: { sigla: true } },
      },
    });
    if (!imp) throw new NotFoundException('Importação não encontrada.');

    const { tribunal, exercicio, ...resto } = imp;
    return {
      ...resto,
      /* `null` quando a importação é anterior ao B5, que não gravava destino.
         Inventar o TRF5 aqui — que é o histórico — seria devolver um palpite
         com cara de fato. */
      destino: tribunal && exercicio !== null ? { tribunal: tribunal.sigla, exercicio } : null,
      /* Estados finais num campo só: a tela precisa saber quando PARAR de
         consultar, e enumerar os três status em cada cliente é a regra que
         diverge quando alguém acrescentar um quarto. */
      terminou: ['CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU'].includes(imp.status),
    };
  }

  @Get()
  @ApiOperation({ summary: 'Histórico de importações' })
  async listar(
    @Query('limite') limite = '20',
    @UsuarioAtual() u: UsuarioAutenticado,
  ) {
    return this.prisma.importacao.findMany({
      /* Importacao tem organizationId próprio — sem este filtro, o histórico de
         um tenant apareceria para o outro assim que houvesse um segundo. */
      where: { organizationId: u.organizationId },
      take: Math.min(100, Number(limite) || 20),
      orderBy: { criadoEm: 'desc' },
      select: {
        id: true, arquivoNome: true, status: true, totalLinhas: true,
        /* `processadas` entrou com o B5: com o trabalho na fila, uma importação
           pode estar em andamento QUANDO o histórico é aberto, e a linha
           precisa mostrar 3.400 de 12.000 em vez de zeros que parecem falha. */
        processadas: true,
        sucesso: true, falhas: true, criadoEm: true, concluidoEm: true,
        user: { select: { nome: true, email: true } },
      },
    });
  }

  @Get(':id/erros')
  @ApiOperation({ summary: 'Linhas que falharam numa importação' })
  async erros(
    @Param('id') id: string,
    @Query('limite') limite = '50',
    @UsuarioAtual() u: UsuarioAutenticado,
  ) {
    return this.prisma.importacaoLinha.findMany({
      /* O id da importação vem da URL: sem amarrar à organização, bastaria
         adivinhar um uuid para ler as linhas de erro — com CPF — de outro tenant. */
      where: { importacaoId: id, status: 'ERRO', importacao: { organizationId: u.organizationId } },
      take: Math.min(200, Number(limite) || 50),
      orderBy: { numeroLinha: 'asc' },
      select: { numeroLinha: true, cpf: true, numeroProcesso: true, mensagemErro: true },
    });
  }
}
