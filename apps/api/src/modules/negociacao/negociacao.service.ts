import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@miner/database';
import type {
  ModalidadeNegociacao,
  OrigemDaBase,
  OrigemProposta,
  ParteQuePaga,
  StatusProposta,
} from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { escopoProcessos } from '../../common/escopo-processos';
import { anonimizarIp } from '../../common/ip';
import type { Autor } from '../crm/crm.service';
import { montarCronograma, somaDoCronograma } from './cronograma';

/**
 * A NEGOCIAÇÃO — a primeira vez que o sistema guarda dinheiro do NEGÓCIO.
 *
 * `Processo.valor` é o valor de FACE do precatório: o que o ente público deve ao
 * titular. Não é receita de ninguém. O que o escritório oferece, e o que ganha,
 * nunca existiu no banco — e é isso que passa a existir aqui.
 *
 * ── RODADAS, E NÃO UM CAMPO DE VALOR ──
 *
 * "Ajustar" uma proposta já apresentada não sobrescreve: fecha a atual e cria a
 * seguinte. Sem isso, a contraproposta do titular desaparece — e é justamente
 * ela que explica por que o negócio fechou naquele número. Um campo só guardaria
 * o fim da história sem o meio.
 */

/** Só o RASCUNHO é editável, e é a única regra de mutabilidade que existe. */
const EDITAVEL: StatusProposta = 'RASCUNHO';

/** Os dois estados que ocupam a vaga de "proposta em aberto". */
const VIVAS: StatusProposta[] = ['RASCUNHO', 'ENVIADA'];

@Injectable()
export class NegociacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Confirma que o processo existe e que quem pede PODE VÊ-LO.
   *
   * Mesmo `escopoProcessos` da leitura e do resto da escrita do CRM: uma regra
   * só, nos dois lados. O erro perigoso aqui é de OMISSÃO — uma rota nova que
   * esqueça a checagem não quebra teste nenhum, só passa a aceitar o UUID de
   * outro tenant.
   */
  private async processoVisivel(processoId: string, autor: Autor) {
    const processo = await this.prisma.processo.findFirst({
      where: { id: processoId, ...escopoProcessos(autor) },
      select: {
        id: true,
        numeroPrecatorio: true,
        partes: { select: { valorIndividual: true } },
      },
    });
    if (!processo) throw new NotFoundException('Processo não encontrado');
    return processo;
  }

  /**
   * A proposta, buscada pelos TRÊS: id, processo e organização.
   *
   * O tenant não é redundância. Como não há exclusividade, o mesmo precatório é
   * liberado a vários escritórios e `processoVisivel` responde SIM para todos —
   * sem o `organizationId` aqui, quem soubesse o UUID mexeria na proposta
   * alheia. Foi exatamente o buraco fechado na Etapa 0 para anotações e tarefas.
   *
   * 404, e nunca 403: um 403 confirmaria que a proposta do outro existe.
   */
  private async propostaParaEscrita(processoId: string, propostaId: string, autor: Autor) {
    await this.processoVisivel(processoId, autor);
    const proposta = await this.prisma.propostaNegociacao.findFirst({
      where: { id: propostaId, processoId, organizationId: autor.organizationId },
    });
    if (!proposta) throw new NotFoundException('Proposta não encontrada neste processo.');
    return proposta;
  }

  /**
   * A BASE DE CÁLCULO, congelada no dia da rodada.
   *
   * `Processo.valor` PARECE o total do precatório, mas é alimentado pela MESMA
   * célula que alimenta `ProcessoPessoa.valorIndividual` (ver a nota em
   * timeline-processo.ts). Nos 230 processos com mais de uma parte, usá-lo
   * erraria a base — por isso o número sai da SOMA das partes, e a origem vai
   * gravada junto para sair impressa na proposta.
   */
  private baseDe(partes: { valorIndividual: Prisma.Decimal | null }[]) {
    const comValor = partes.filter((p) => p.valorIndividual !== null);
    if (comValor.length === 0) return { baseValor: null, baseOrigem: null };

    const soma = comValor.reduce(
      (s, p) => s.add(p.valorIndividual as Prisma.Decimal),
      new Prisma.Decimal(0),
    );
    const baseOrigem: OrigemDaBase = comValor.length === 1 ? 'PARTE_UNICA' : 'SOMA_DAS_PARTES';
    return { baseValor: soma, baseOrigem };
  }

  /**
   * O que se calcula a partir do que está gravado — nunca gravado junto.
   *
   * Deságio e líquido são CONTA sobre valor e base. Guardá-los criaria duas
   * verdades que divergem no primeiro arredondamento, e a segunda a ser corrigida
   * seria a que ninguém lembra que existe.
   */
  private derivados(p: {
    modalidade: ModalidadeNegociacao;
    baseValor: Prisma.Decimal | null;
    valorProposto: Prisma.Decimal | null;
    custasEstimadas: Prisma.Decimal | null;
    custasPorContaDe: ParteQuePaga;
  }) {
    const base = p.baseValor;
    const proposto = p.valorProposto;

    /* Deságio só existe na CESSÃO, e só com base lançada. Sem base, é NULO — e
       não 100%: a diferença entre "não sei a margem" e "a margem é total" é o
       que separa um campo vazio de uma mentira na tela do sócio. */
    const desagioPercentual =
      p.modalidade === 'CESSAO' && base && proposto && base.gt(0)
        ? base.sub(proposto).div(base).mul(100).toDecimalPlaces(2).toString()
        : null;

    /* O que o titular efetivamente recebe: as custas só saem do bolso dele
       quando ficaram por conta dele. */
    const liquidoAoTitular =
      p.modalidade === 'CESSAO' && proposto
        ? (p.custasPorContaDe === 'TITULAR' && p.custasEstimadas
            ? proposto.sub(p.custasEstimadas)
            : proposto
          ).toString()
        : null;

    return { desagioPercentual, liquidoAoTitular };
  }

  private comoSai(p: Prisma.PropostaNegociacaoGetPayload<{ include: { autor: true } }>) {
    return {
      id: p.id,
      rodada: p.rodada,
      origem: p.origem,
      modalidade: p.modalidade,
      status: p.status,
      /* Dinheiro sai como TEXTO, nunca como número: `Decimal` vira float ao
         passar por JSON, e centavo perdido em valor de negociação é o tipo de
         erro que só aparece na conferência do contrato. */
      baseValor: p.baseValor?.toString() ?? null,
      baseOrigem: p.baseOrigem,
      valorProposto: p.valorProposto?.toString() ?? null,
      honorarioPercentual: p.honorarioPercentual?.toString() ?? null,
      custasEstimadas: p.custasEstimadas?.toString() ?? null,
      custasPorContaDe: p.custasPorContaDe,
      validaAte: p.validaAte,
      observacao: p.observacao,
      enviadaEm: p.enviadaEm,
      respondidaEm: p.respondidaEm,
      encerradaEm: p.encerradaEm,
      criadoEm: p.criadoEm,
      autor: { id: p.autor.id, nome: p.autor.nome },
      ...this.derivados(p),
    };
  }

  /** Todas as rodadas do processo, da mais recente para a mais antiga. */
  async resumo(processoId: string, autor: Autor) {
    const processo = await this.processoVisivel(processoId, autor);

    const rodadas = await this.prisma.propostaNegociacao.findMany({
      where: { processoId, organizationId: autor.organizationId },
      orderBy: { rodada: 'desc' },
      include: { autor: { select: { id: true, nome: true } } },
    });

    const saida = rodadas.map((r) => this.comoSai(r as never));
    const base = this.baseDe(processo.partes);

    return {
      /* A base ATUAL do processo, ao lado da congelada em cada rodada: é assim
         que a tela consegue avisar "a base mudou depois desta proposta" em vez
         de deixar os dois números se contradizerem em silêncio. */
      baseAtual: base.baseValor?.toString() ?? null,
      baseOrigemAtual: base.baseOrigem,
      viva: saida.find((r) => VIVAS.includes(r.status)) ?? null,
      aceita: saida.find((r) => r.status === 'ACEITA') ?? null,
      rodadas: saida,
    };
  }

  /**
   * Cria a rodada seguinte, fechando a anterior na MESMA transação.
   *
   * ── A ORDEM DAS ESCRITAS NÃO É DETALHE ──
   *
   * `ux_proposta_viva` é um índice parcial único, e no Postgres índice único é
   * imediato: não existe versão adiável. Se a inserção viesse antes do
   * fechamento da anterior, a trava dispararia e um fluxo legítimo viraria erro
   * 500. Fecha-se primeiro, insere-se depois.
   */
  async criar(
    processoId: string,
    autor: Autor,
    dados: {
      modalidade: ModalidadeNegociacao;
      origem?: OrigemProposta;
      valorProposto?: string;
      honorarioPercentual?: string;
      custasEstimadas?: string;
      custasPorContaDe?: ParteQuePaga;
      validaAte?: string;
      observacao?: string;
    },
  ) {
    const processo = await this.processoVisivel(processoId, autor);
    this.exigirCoerencia(dados);

    const base = this.baseDe(processo.partes);
    const chave = { organizationId: autor.organizationId, processoId };

    try {
      return await this.prisma.$transaction(async (tx) => {
        const anterior = await tx.propostaNegociacao.findFirst({
          where: { ...chave, status: { in: VIVAS } },
        });

        if (anterior) {
          if (anterior.status === 'RASCUNHO') {
            /* Rascunho que nunca foi apresentado é ABANDONADO, não arquivado:
               guardá-lo encheria o histórico de números que ninguém chegou a
               ver, e o histórico existe para contar a negociação de verdade. */
            await tx.propostaNegociacao.delete({ where: { id: anterior.id } });
          } else {
            await tx.propostaNegociacao.update({
              where: { id: anterior.id },
              data: { status: 'SUBSTITUIDA', encerradaEm: new Date() },
            });
          }
        }

        const ultima = await tx.propostaNegociacao.findFirst({
          where: chave,
          orderBy: { rodada: 'desc' },
          select: { rodada: true },
        });

        const criada = await tx.propostaNegociacao.create({
          data: {
            ...chave,
            autorId: autor.id,
            rodada: (ultima?.rodada ?? 0) + 1,
            origem: dados.origem ?? 'ESCRITORIO',
            modalidade: dados.modalidade,
            baseValor: base.baseValor,
            baseOrigem: base.baseOrigem,
            valorProposto: dados.valorProposto ?? null,
            honorarioPercentual: dados.honorarioPercentual ?? null,
            custasEstimadas: dados.custasEstimadas ?? null,
            custasPorContaDe: dados.custasPorContaDe ?? 'ESCRITORIO',
            validaAte: dados.validaAte ? new Date(dados.validaAte) : null,
            observacao: dados.observacao?.trim() || null,
          },
          include: { autor: { select: { id: true, nome: true } } },
        });

        return this.comoSai(criada as never);
      });
    } catch (e) {
      throw this.traduzirCorrida(e);
    }
  }

  /** Ajusta a rodada — e SÓ o rascunho aceita ajuste. */
  async ajustar(
    processoId: string,
    propostaId: string,
    autor: Autor,
    dados: {
      valorProposto?: string | null;
      honorarioPercentual?: string | null;
      custasEstimadas?: string | null;
      custasPorContaDe?: ParteQuePaga;
      validaAte?: string | null;
      observacao?: string | null;
    },
  ) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    if (proposta.status !== EDITAVEL) {
      /* 409, e não 400: o pedido está bem formado, o ESTADO é que não permite.
         A tela precisa da diferença para dizer "essa proposta já foi
         apresentada; crie a rodada seguinte" em vez de "dados inválidos". */
      throw new ConflictException(
        'Proposta já apresentada não se edita: crie a rodada seguinte. ' +
          'É o que preserva a contraproposta anterior no histórico.',
      );
    }

    const atualizada = await this.prisma.propostaNegociacao.update({
      where: { id: propostaId },
      data: {
        ...(dados.valorProposto !== undefined ? { valorProposto: dados.valorProposto } : {}),
        ...(dados.honorarioPercentual !== undefined
          ? { honorarioPercentual: dados.honorarioPercentual }
          : {}),
        ...(dados.custasEstimadas !== undefined ? { custasEstimadas: dados.custasEstimadas } : {}),
        ...(dados.custasPorContaDe !== undefined
          ? { custasPorContaDe: dados.custasPorContaDe }
          : {}),
        ...(dados.validaAte !== undefined
          ? { validaAte: dados.validaAte ? new Date(dados.validaAte) : null }
          : {}),
        ...(dados.observacao !== undefined
          ? { observacao: dados.observacao?.trim() || null }
          : {}),
      },
      include: { autor: { select: { id: true, nome: true } } },
    });

    return this.comoSai(atualizada as never);
  }

  /**
   * Apresenta a proposta ao titular: congela a rodada e move o funil.
   *
   * O funil vai para PROPOSTA junto, na MESMA transação. Deixar isso para o
   * operador fazer à mão criaria a carteira em que "proposta enviada" e
   * "estágio: em contato" convivem — e aí nenhum dos dois números vale nada.
   */
  async enviar(processoId: string, propostaId: string, autor: Autor) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    if (proposta.status !== EDITAVEL) {
      throw new ConflictException('Só um rascunho pode ser apresentado.');
    }
    if (proposta.modalidade === 'CESSAO' && proposta.valorProposto === null) {
      throw new BadRequestException(
        'Uma cessão sem valor proposto não é uma proposta: informe quanto foi oferecido.',
      );
    }
    if (proposta.modalidade === 'HONORARIOS' && proposta.honorarioPercentual === null) {
      throw new BadRequestException(
        'Um contrato de honorários sem percentual não é uma proposta: informe o percentual.',
      );
    }

    const agora = new Date();
    const [enviada] = await this.prisma.$transaction([
      this.prisma.propostaNegociacao.update({
        where: { id: propostaId },
        data: { status: 'ENVIADA', enviadaEm: agora },
        include: { autor: { select: { id: true, nome: true } } },
      }),
      this.prisma.carteiraProcesso.upsert({
        where: {
          organizationId_processoId: { organizationId: autor.organizationId, processoId },
        },
        create: {
          organizationId: autor.organizationId,
          processoId,
          estagio: 'PROPOSTA',
          estagioEm: agora,
        },
        update: { estagio: 'PROPOSTA', estagioEm: agora, motivoPerda: null },
      }),
      /* Evento SIM, e sem UM número dentro. A timeline é append-only e não se
         apaga a pedido do titular: registrar "proposta de R$ 300 mil" ali
         deixaria para sempre quanto foi oferecido a uma pessoa identificável. O
         QUE aconteceu é histórico; QUANTO é dado financeiro do titular. */
      this.prisma.eventoProcesso.create({
        data: {
          processoId,
          organizationId: autor.organizationId,
          tipo: 'STATUS_ALTERADO',
          descricao: `Proposta apresentada (rodada ${proposta.rodada})`,
          camposAlterados: ['estagio'],
          detalhe: { estagio: { de: 'EM_CONTATO', para: 'PROPOSTA' }, rodada: proposta.rodada },
          userId: autor.id,
        },
      }),
    ]);

    return this.comoSai(enviada as never);
  }

  /**
   * Registra a decisão do titular.
   *
   * ACEITA move o funil para FECHADO; RECUSADA não mexe no estágio — recusar uma
   * proposta não encerra a negociação, e mandar o processo para PERDIDO aqui
   * tiraria da mesa um titular que talvez aceite a rodada seguinte.
   */
  async decidir(
    processoId: string,
    propostaId: string,
    autor: Autor,
    decisao: 'ACEITA' | 'RECUSADA' | 'CANCELADA',
  ) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    if (proposta.status !== 'ENVIADA') {
      throw new ConflictException(
        'Só uma proposta APRESENTADA pode ser aceita, recusada ou cancelada.',
      );
    }

    const agora = new Date();
    const escritas: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.propostaNegociacao.update({
        where: { id: propostaId },
        data: {
          status: decisao,
          ...(decisao === 'CANCELADA'
            ? { encerradaEm: agora }
            : { respondidaEm: agora, respondidaPorId: autor.id }),
        },
        include: { autor: { select: { id: true, nome: true } } },
      }),
    ];

    if (decisao === 'ACEITA') {
      escritas.push(
        this.prisma.carteiraProcesso.upsert({
          where: {
            organizationId_processoId: { organizationId: autor.organizationId, processoId },
          },
          create: {
            organizationId: autor.organizationId,
            processoId,
            estagio: 'FECHADO',
            estagioEm: agora,
          },
          update: { estagio: 'FECHADO', estagioEm: agora, motivoPerda: null },
        }),
        this.prisma.eventoProcesso.create({
          data: {
            processoId,
            organizationId: autor.organizationId,
            tipo: 'STATUS_ALTERADO',
            descricao: `Proposta aceita (rodada ${proposta.rodada})`,
            camposAlterados: ['estagio'],
            detalhe: { estagio: { de: 'PROPOSTA', para: 'FECHADO' }, rodada: proposta.rodada },
            userId: autor.id,
          },
        }),
      );
    }

    try {
      const [atualizada] = await this.prisma.$transaction(escritas);
      return this.comoSai(atualizada as never);
    } catch (e) {
      throw this.traduzirCorrida(e);
    }
  }

  /** Descarta o rascunho. Só ele — o resto é histórico. */
  async remover(processoId: string, propostaId: string, autor: Autor) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);
    if (proposta.status !== EDITAVEL) {
      throw new ConflictException(
        'Proposta já apresentada faz parte do histórico e não é apagada. Cancele-a.',
      );
    }
    await this.prisma.propostaNegociacao.delete({ where: { id: propostaId } });
    return { removida: true };
  }

  /**
   * A FOLHA DA PROPOSTA — dois documentos, e a diferença não pode ser errada.
   *
   * ── POR QUE O PACOTE É MONTADO CAMPO A CAMPO, POR DESTINO ──
   *
   * O caminho fácil seria montar um objeto completo e apagar a margem quando o
   * destino é o titular. Errado: campo novo acrescentado no futuro entraria nos
   * DOIS por omissão, e o erro só apareceria depois de o papel estar na mão de
   * quem negocia contra o escritório. Aqui a folha do titular NUNCA RECEBE o
   * campo — não há o que esquecer de apagar.
   *
   * É a mesma técnica da projeção do cliente em carteira.service.ts, e pelo
   * mesmo motivo: "por REMONTAGEM, não por delete".
   *
   * ── O PADRÃO É O LADO SEGURO ──
   *
   * `destino` ausente vira TITULAR. Um parâmetro esquecido numa integração
   * futura entrega a folha SEM margem, e não a folha com ela.
   */
  async relatorio(
    processoId: string,
    propostaId: string,
    autor: Autor,
    destino: 'TITULAR' | 'INTERNO' = 'TITULAR',
    trilha?: { ip?: string; userAgent?: string },
  ) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    const processo = await this.prisma.processo.findUniqueOrThrow({
      where: { id: processoId },
      select: {
        numeroPrecatorio: true,
        numeroOriginario: true,
        entidadeDevedora: true,
        exercicio: true,
        /* ⚠ O ESTÁGIO É PARTE DO DOCUMENTO, não enfeite de tela.
           Esta folha é assinada pelo TITULAR. Sem a fase, ela chamava de
           "precatório" um crédito que pode estar em trânsito em julgado — e o
           escritório a entregava de boa-fé, porque a tela não lhe dizia a
           diferença. */
        fase: true,
        tribunal: { select: { sigla: true, nome: true } },
        partes: {
          select: { pessoa: { select: { nome: true, cpf: true } }, valorIndividual: true },
        },
      },
    });

    const parcelas = await this.prisma.parcelaCessao.findMany({
      where: { propostaId, organizationId: autor.organizationId },
      orderBy: { numero: 'asc' },
    });

    const organizacao = await this.prisma.organization.findUniqueOrThrow({
      where: { id: autor.organizationId },
      select: { nome: true, cnpj: true },
    });

    const p = this.comoSai(
      (await this.prisma.propostaNegociacao.findUniqueOrThrow({
        where: { id: propostaId },
        include: { autor: { select: { id: true, nome: true } } },
      })) as never,
    );

    /* ── A TRILHA ──
       Imprimir é o momento em que nome e CPF SAEM do sistema em papel — o elo
       mais grave da cadeia, e o único que hoje não deixaria registro. A fila não
       grava trilha de propósito (é lista de trabalho), mas isto não é lista: é
       egresso de dado pessoal. */
    await this.prisma.consultaCliente.create({
      data: {
        userId: autor.id,
        tipo: 'PROPOSTA',
        termo: processo.numeroPrecatorio.slice(0, 120),
        /* CPF só quando há UMA parte: com várias, gravar um só seria escolher
           arbitrariamente de quem é a trilha. */
        cpfConsultado: processo.partes.length === 1 ? processo.partes[0].pessoa.cpf : null,
        totalResultados: 1,
        contatoExibido: true,
        ip: anonimizarIp(trilha?.ip),
        userAgent: trilha?.userAgent,
      },
    });

    const comum = {
      /* O TIMBRE é do ESCRITÓRIO, nunca nosso: a marca MINER não pode aparecer
         no papel que o cliente entrega ao titular dele. Esconder a
         infraestrutura é a promessa central do produto. */
      escritorio: { nome: organizacao.nome, cnpj: organizacao.cnpj },
      precatorio: {
        numero: processo.numeroPrecatorio,
        numeroOriginario: processo.numeroOriginario,
        tribunal: `${processo.tribunal.sigla} — ${processo.tribunal.nome}`,
        entidadeDevedora: processo.entidadeDevedora,
        exercicio: processo.exercicio,
        fase: processo.fase,
      },
      /* Nome e CPF COMPLETOS: é um documento que identifica quem assina. É
         justamente por isso que ele deixa trilha. */
      titulares: processo.partes.map((x) => ({
        nome: x.pessoa.nome,
        cpf: x.pessoa.cpf,
        valorIndividual: x.valorIndividual?.toString() ?? null,
      })),
      proposta: {
        rodada: p.rodada,
        modalidade: p.modalidade,
        status: p.status,
        /* A ORIGEM da base sai impressa: é o que impede alguém de negociar sobre
           o número errado sem perceber. */
        baseValor: p.baseValor,
        baseOrigem: p.baseOrigem,
        valorProposto: p.valorProposto,
        honorarioPercentual: p.honorarioPercentual,
        custasEstimadas: p.custasEstimadas,
        custasPorContaDe: p.custasPorContaDe,
        liquidoAoTitular: p.liquidoAoTitular,
        validaAte: p.validaAte,
        emitidaEm: new Date(),
      },
      /* ── AS PARCELAS SAEM NA FOLHA, NOS DOIS DESTINOS ──
         É o que o titular assina: um documento que não diz QUANDO ele recebe não
         serve para o que foi feito. Vão só número, valor e vencimento — nunca a
         situação de cada uma. Assim o papel reimpresso em outubro diz a mesma
         coisa que dizia em março, que é o que se espera de um documento
         assinado; "esta já foi paga" é informação de tela, não de contrato. */
      pagamento: parcelas.length
        ? {
            parcelas: parcelas.map((x) => ({
              numero: x.numero,
              entrada: x.numero === 0,
              valor: x.valor.toFixed(2),
              vencimento: x.vencimento,
            })),
            total: somaDoCronograma(
              parcelas.map((x) => ({ valor: x.valor.toFixed(2) })),
            ),
          }
        : null,
      destino,
    };

    if (destino === 'TITULAR') return comum;

    return {
      ...comum,
      /* SÓ na folha interna. O deságio é o lucro do escritório: entregá-lo a
         quem negocia contra ele é o pior erro que este documento pode cometer. */
      interno: {
        desagioPercentual: p.desagioPercentual,
        observacao: p.observacao,
        autor: p.autor,
        historico: (
          await this.prisma.propostaNegociacao.findMany({
            where: { processoId, organizationId: autor.organizationId },
            orderBy: { rodada: 'asc' },
            select: { rodada: true, origem: true, status: true, valorProposto: true },
          })
        ).map((h) => ({
          rodada: h.rodada,
          origem: h.origem,
          status: h.status,
          valorProposto: h.valorProposto?.toString() ?? null,
        })),
      },
    };
  }

  // ── PARCELAMENTO ────────────────────────────────────────────

  /**
   * Monta o cronograma de pagamento ao titular.
   *
   * ── NO RASCUNHO, E NÃO DEPOIS DE ACEITA ──
   *
   * Decisão do dono: "recebo em 6 vezes" é parte do que a pessoa está aceitando,
   * então as parcelas saem impressas na folha que ela assina. Como a chave
   * estrangeira é CASCADE, descartar o rascunho leva o cronograma junto — não
   * sobra órfão.
   *
   * Refazer é apagar e gerar de novo, e é por isso que NÃO existe `PATCH` de
   * parcela: é essa ausência que faz a soma fechar por construção, sem `CHECK`
   * no banco e sem gatilho. Depois que algo foi PAGO, o cronograma congela.
   */
  async gerarCronograma(
    processoId: string,
    propostaId: string,
    autor: Autor,
    dados: {
      entrada?: string;
      parcelas: number;
      primeiroVencimento: string;
      intervaloMeses?: number;
    },
  ) {
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    if (proposta.modalidade !== 'CESSAO') {
      throw new BadRequestException(
        'Só a CESSÃO se parcela. Em honorários grava-se o percentual, e a quantia ' +
          'só existe quando o precatório for pago — dividi-la em vezes seria projeção ' +
          'disfarçada de dívida.',
      );
    }
    if (proposta.valorProposto === null) {
      throw new BadRequestException(
        'Informe quanto se paga ao titular antes de dividir em parcelas.',
      );
    }
    if (!VIVAS.includes(proposta.status) && proposta.status !== 'ACEITA') {
      throw new ConflictException(
        'Esta rodada não está mais em negociação: o cronograma pertence à proposta viva ou à aceita.',
      );
    }

    const jaPaga = await this.prisma.parcelaCessao.findFirst({
      where: { propostaId, pagoEm: { not: null } },
      select: { numero: true },
    });
    if (jaPaga) {
      throw new ConflictException(
        `A parcela ${jaPaga.numero} já foi paga: o cronograma não é refeito depois que dinheiro saiu. ` +
          'Se o combinado mudou, registre a renegociação numa rodada nova.',
      );
    }

    let linhas;
    try {
      linhas = montarCronograma({
        total: proposta.valorProposto.toString(),
        entrada: dados.entrada,
        parcelas: dados.parcelas,
        primeiroVencimento: dados.primeiroVencimento,
        intervaloMeses: dados.intervaloMeses,
      });
    } catch (e) {
      /* A divisão recusa por regra de negócio (parcela abaixo de um centavo,
         entrada maior que o total). 400 com a conta na mensagem, nunca 500. */
      throw new BadRequestException((e as Error).message);
    }

    await this.prisma.$transaction([
      /* Apaga e regrava: é o "refazer" inteiro, e o único caminho de edição que
         existe. A trava de unicidade (propostaId, numero) garante que duas
         gerações concorrentes não dobrem o cronograma. */
      /* A org no filtro, além do `propostaId`. Não muda o que se apaga: a proposta
         já foi conferida como da org do autor em `propostaParaEscrita`, e toda
         parcela dela nasce com esse mesmo `organizationId` (o createMany logo
         abaixo). Muda o que se APAGARIA se aquela conferência um dia falhasse —
         só as parcelas da própria org, nunca as de outra. */
      this.prisma.parcelaCessao.deleteMany({
        where: { propostaId, organizationId: autor.organizationId },
      }),
      this.prisma.parcelaCessao.createMany({
        data: linhas.map((l) => ({
          propostaId,
          processoId,
          organizationId: autor.organizationId,
          numero: l.numero,
          valor: l.valor,
          vencimento: new Date(l.vencimento),
        })),
      }),
    ]);

    return this.cronograma(processoId, propostaId, autor);
  }

  /** O cronograma como a tela e a folha o leem. */
  async cronograma(processoId: string, propostaId: string, autor: Autor) {
    await this.propostaParaEscrita(processoId, propostaId, autor);

    const parcelas = await this.prisma.parcelaCessao.findMany({
      where: { propostaId, organizationId: autor.organizationId },
      orderBy: { numero: 'asc' },
      include: { pagoPor: { select: { id: true, nome: true } } },
    });

    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);

    return {
      /* A soma sai junto para a tela poder confrontá-la com o valor acordado.
         Não impede uma divergência (nada impede), mas garante que ela seja VISTA
         na primeira vez que alguém abrir o processo — o mesmo desenho de
         `baseAtual` ao lado da base congelada. */
      total: somaDoCronograma(
        parcelas.map((p) => ({ valor: p.valor.toFixed(2) })),
      ),
      parcelas: parcelas.map((p) => ({
        id: p.id,
        numero: p.numero,
        /* Número 0 é a ENTRADA — a tela dá o nome, o banco guarda o ordinal. */
        entrada: p.numero === 0,
        /* , e não : o Decimal corta o zero à direita e
           devolveria "50000" ao lado de um total "300000.00". Numa folha de
           contrato, valor de dinheiro sem os centavos parece número truncado —
           e quem confere não sabe se é 50 mil ou 50 mil e alguma coisa. */
        valor: p.valor.toFixed(2),
        vencimento: p.vencimento,
        pagoEm: p.pagoEm,
        pagoPor: p.pagoPor,
        /* CALCULADA na leitura, nunca gravada: estado gravado pediria um cron
           para mantê-lo, e vencida aqui não dispara nada — é informação, não
           gatilho. Não bloqueia cliente, não suspende assinatura, não cobra. */
        vencida: p.pagoEm === null && p.vencimento < hoje,
      })),
    };
  }

  /**
   * Registra que a parcela saiu do caixa.
   *
   * ── SÓ GESTOR OU ADMINISTRADOR ──
   *
   * Decisão do dono. E "gestor" neste sistema não é papel: é uma marca no
   * usuário (`User.gestor`) que convive com o papel CLIENTE — um escritório
   * cliente tem gestor e não tem ADMIN. Por isso a checagem é aqui, no serviço,
   * e não num `@Papeis`: o decorator não enxerga a marca.
   *
   * Idempotente: chamar duas vezes não reescreve a data da primeira. Sem isso, o
   * duplo clique moveria a data do pagamento para o instante do segundo clique —
   * e a data do pagamento é o que vale numa conferência.
   */
  async baixar(processoId: string, propostaId: string, numero: number, autor: Autor) {
    await this.exigirGestorOuAdmin(autor);
    const proposta = await this.propostaParaEscrita(processoId, propostaId, autor);

    if (proposta.status !== 'ACEITA') {
      throw new ConflictException(
        'Só se dá baixa em parcela de contrato FECHADO: a proposta ainda não foi aceita.',
      );
    }

    /* `updateMany` com `pagoEm: null` no filtro, e não `update({ where: id })`:
       é a idempotência escrita como consulta. Duas chamadas simultâneas, e só a
       primeira encontra a linha em aberto. */
    const r = await this.prisma.parcelaCessao.updateMany({
      where: { propostaId, numero, organizationId: autor.organizationId, pagoEm: null },
      data: { pagoEm: new Date(), pagoPorId: autor.id },
    });

    if (r.count === 0) {
      const existe = await this.prisma.parcelaCessao.findFirst({
        where: { propostaId, numero, organizationId: autor.organizationId },
      });
      if (!existe) throw new NotFoundException('Parcela não encontrada.');
      /* Já estava paga: não é erro, é o segundo clique. */
      return { ...(await this.cronograma(processoId, propostaId, autor)), alterado: false };
    }

    return { ...(await this.cronograma(processoId, propostaId, autor)), alterado: true };
  }

  /** Desfaz a baixa — quem clicou errado precisa de saída dentro do sistema. */
  async desfazerBaixa(processoId: string, propostaId: string, numero: number, autor: Autor) {
    await this.exigirGestorOuAdmin(autor);
    await this.propostaParaEscrita(processoId, propostaId, autor);

    const r = await this.prisma.parcelaCessao.updateMany({
      where: { propostaId, numero, organizationId: autor.organizationId, pagoEm: { not: null } },
      data: { pagoEm: null, pagoPorId: null },
    });

    return { ...(await this.cronograma(processoId, propostaId, autor)), alterado: r.count > 0 };
  }

  /** Apaga o cronograma inteiro — só enquanto nada foi pago. */
  async removerCronograma(processoId: string, propostaId: string, autor: Autor) {
    await this.propostaParaEscrita(processoId, propostaId, autor);

    const paga = await this.prisma.parcelaCessao.findFirst({
      where: { propostaId, pagoEm: { not: null } },
      select: { numero: true },
    });
    if (paga) {
      throw new ConflictException(
        `A parcela ${paga.numero} já foi paga: o cronograma não é apagado depois que dinheiro saiu.`,
      );
    }

    const r = await this.prisma.parcelaCessao.deleteMany({
      where: { propostaId, organizationId: autor.organizationId },
    });
    return { removidas: r.count };
  }

  /**
   * "Gestor ou administrador" — a única permissão deste módulo que não é o
   * conjunto padrão do controller.
   *
   * ADMIN é papel do time interno; `gestor` é a marca do dono da conta no lado
   * do cliente. Um dos dois basta, e nenhum outro serve: registrar que R$ 300
   * mil saíram do caixa é decisão de quem responde pelo dinheiro.
   */
  private async exigirGestorOuAdmin(autor: Autor) {
    if (autor.papel === 'ADMIN') return;
    const u = await this.prisma.user.findUnique({
      where: { id: autor.id },
      select: { gestor: true },
    });
    if (!u?.gestor) {
      throw new ForbiddenException(
        'Só o gestor da organização ou um administrador registra pagamento de parcela.',
      );
    }
  }

  /** Cessão pede quantia; honorários pedem percentual. Um exclui o outro. */
  private exigirCoerencia(dados: {
    modalidade: ModalidadeNegociacao;
    valorProposto?: string;
    honorarioPercentual?: string;
  }) {
    if (dados.modalidade === 'CESSAO' && dados.honorarioPercentual !== undefined) {
      throw new BadRequestException(
        'Numa cessão o combinado é a quantia paga ao titular, não um percentual.',
      );
    }
    if (dados.modalidade === 'HONORARIOS' && dados.valorProposto !== undefined) {
      throw new BadRequestException(
        'Em honorários o combinado é o percentual: a quantia só existe quando o ' +
          'precatório for pago, e gravá-la agora seria projeção disfarçada de dinheiro.',
      );
    }
  }

  /**
   * Traduz a violação das travas do banco em recado de gente.
   *
   * `ux_proposta_viva` e `ux_proposta_aceita` são a defesa que sobra quando dois
   * usuários do mesmo escritório agem ao mesmo tempo. Sem esta tradução, a
   * corrida vira 500 — e "erro interno" manda o operador tentar de novo, que é
   * exatamente o que não se deve fazer com dinheiro.
   */
  private traduzirCorrida(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const alvo = String((e.meta as { target?: string })?.target ?? '');
      if (alvo.includes('aceita')) {
        return new ConflictException(
          'Este processo já tem uma proposta ACEITA. Recarregue a tela para vê-la.',
        );
      }
      return new ConflictException(
        'Alguém do seu escritório acabou de registrar uma rodada neste processo. ' +
          'Recarregue a tela antes de continuar.',
      );
    }
    return e as Error;
  }
}
