import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@miner/database';
import type {
  CanalContato,
  EstagioCrm,
  Papel,
  PrioridadeProcesso,
  ResultadoContato,
  TipoOrganizacao,
  TipoTarefa,
} from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { condicoesDaFila, type FiltrosDaFila } from '../carteira/condicoes-da-fila';
import { ehEscopoCliente, escopoProcessos } from '../../common/escopo-processos';

/** Quem está pedindo a escrita. Vem sempre do JWT, nunca do corpo. */
export interface Autor {
  id: string;
  papel: Papel;
  organizationId: string;
  /** Tipo da org: decide se o processo é visível por PROPRIEDADE ou por LIBERAÇÃO. */
  tipo: TipoOrganizacao;
}

const PRIORIDADE_ROTULO: Record<PrioridadeProcesso, string> = {
  BAIXA: 'baixa',
  NORMAL: 'normal',
  ALTA: 'alta',
  URGENTE: 'urgente',
};

/** Rótulos do funil, para a frase que vai para a timeline. */
const ESTAGIO_ROTULO: Record<EstagioCrm, string> = {
  NOVO: 'novo',
  EM_CONTATO: 'em contato',
  PROPOSTA: 'proposta enviada',
  FECHADO: 'fechado',
  PERDIDO: 'perdido',
};

@Injectable()
export class CrmService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Porta de entrada de TODA escrita: confirma que o processo existe e que quem
   * pede PODE VÊ-LO.
   *
   * "Poder ver" deixou de ser "ser dono". O cliente escreve no CRM de um processo
   * que é PROPRIEDADE da org interna e foi LIBERADO a ele — filtrar por
   * `organizationId` aqui recusaria toda escrita de cliente com um 404. Por isso
   * o critério é o MESMO `escopoProcessos` da leitura: uma regra só, nos dois
   * lados. Se a escrita tivesse critério próprio, os dois divergiriam no primeiro
   * ajuste — e divergir na escrita é o lado perigoso.
   *
   * Centralizado porque o erro perigoso aqui é de omissão — uma rota nova que
   * esqueça a checagem não quebra teste nenhum, só passa a aceitar o UUID de
   * outro tenant. Com um único caminho, esquecer é não compilar.
   */
  private async processoVisivel(processoId: string, autor: Autor) {
    const processo = await this.prisma.processo.findFirst({
      where: { id: processoId, ...escopoProcessos(autor) },
      select: { id: true, prioridade: true, responsavelId: true },
    });
    if (!processo) throw new NotFoundException('Processo não encontrado');
    return processo;
  }

  // ── Anotações ──

  async criarAnotacao(processoId: string, autor: Autor, dados: { texto: string; fixada?: boolean }) {
    await this.processoVisivel(processoId, autor);

    /* Sem evento na timeline de propósito. O conteúdo é dado pessoal em
       potencial e EventoProcesso é append-only; a anotação já aparece na linha
       do tempo porque a tela junta as duas fontes na leitura. Registrar "criou
       anotação" ali só acrescentaria uma linha imutável apontando para outra
       que pode ser apagada — a timeline mostraria o fantasma de uma anotação
       excluída a pedido do titular. */
    return this.prisma.anotacaoProcesso.create({
      data: {
        processoId,
        /* A org de quem escreve — o que isola a anotação deste tenant das dos
           demais sobre o mesmo processo. Vem sempre do JWT (autor), nunca do corpo. */
        organizationId: autor.organizationId,
        autorId: autor.id,
        texto: dados.texto.trim(),
        fixada: dados.fixada ?? false,
      },
      select: this.selectAnotacao,
    });
  }

  async editarAnotacao(
    processoId: string,
    anotacaoId: string,
    autor: Autor,
    dados: { texto?: string; fixada?: boolean },
  ) {
    const anotacao = await this.anotacaoParaEscrita(processoId, anotacaoId, autor, 'editar');

    /* Só o autor edita, ADMIN incluído. Editar texto alheio reescreveria o que
       outra pessoa afirmou, mantendo o nome dela embaixo — apagar é diferente
       (ver abaixo), porque remove sem falsificar. */
    if (anotacao.autorId !== autor.id) {
      throw new ForbiddenException('Só o autor pode editar a própria anotação.');
    }

    return this.prisma.anotacaoProcesso.update({
      where: { id: anotacaoId },
      data: {
        ...(dados.texto !== undefined ? { texto: dados.texto.trim() } : {}),
        ...(dados.fixada !== undefined ? { fixada: dados.fixada } : {}),
      },
      select: this.selectAnotacao,
    });
  }

  async removerAnotacao(processoId: string, anotacaoId: string, autor: Autor) {
    const anotacao = await this.anotacaoParaEscrita(processoId, anotacaoId, autor, 'remover');

    /* ADMIN apaga a de qualquer um. Não é privilégio de hierarquia: é o que
       torna executável um pedido de EXCLUSÃO do titular (art. 18 da LGPD). Se
       um advogado escreveu o telefone do filho do requerente numa anotação e
       saiu do escritório, alguém precisa conseguir apagar aquilo. */
    if (anotacao.autorId !== autor.id && autor.papel !== 'ADMIN') {
      throw new ForbiddenException('Só o autor ou um administrador pode remover a anotação.');
    }

    /* DELETE de verdade, não soft delete. Marcar `removidoEm` deixaria o texto
       no banco, e é justamente o texto que o pedido de exclusão manda apagar. */
    await this.prisma.anotacaoProcesso.delete({ where: { id: anotacaoId } });
    return { removida: true };
  }

  private async anotacaoParaEscrita(
    processoId: string,
    anotacaoId: string,
    autor: Autor,
    acao: string,
  ) {
    await this.processoVisivel(processoId, autor);

    /* Filtra por processoId junto: sem isso, o id de uma anotação de OUTRO
       processo (possivelmente de outro tenant) passaria pela checagem acima,
       que só olhou o processo da URL.

       ── E POR organizationId, QUE FALTAVA ──
       `processoVisivel` responde "posso ver ESTE PROCESSO", e a resposta é sim
       para TODOS os escritórios a quem ele foi liberado — não existe
       exclusividade, o mesmo precatório vai para vários clientes de propósito.
       Sem o tenant aqui, quem soubesse o UUID de uma anotação do escritório A
       a apagaria pela rota do escritório B: a checagem de autoria não segura
       (ADMIN apaga a de qualquer um) e a de processo dá "sim" para os dois. O
       que impedia o estrago era o UUID não ser adivinhável — sorte, não trava.

       Escrito nos DOIS lugares (aqui e na tarefa) porque a única alternativa
       seria confiar em quem escrever a próxima rota. */
    const anotacao = await this.prisma.anotacaoProcesso.findFirst({
      where: { id: anotacaoId, processoId, organizationId: autor.organizationId },
      select: { id: true, autorId: true },
    });
    if (!anotacao) throw new NotFoundException(`Anotação não encontrada para ${acao}.`);
    return anotacao;
  }

  private readonly selectAnotacao = {
    id: true,
    texto: true,
    fixada: true,
    criadoEm: true,
    editadoEm: true,
    autor: { select: { id: true, nome: true } },
  } as const;

  // ── Tarefas e follow-ups ──

  /**
   * Converte "AAAA-MM-DD" no Date que o Prisma grava numa coluna DATE.
   *
   * `new Date('2026-07-25')` é interpretado como MEIA-NOITE UTC — e é
   * exatamente o que se quer aqui. A alternativa (`new Date(2026, 6, 25)`)
   * criaria meia-noite LOCAL, que no Brasil é 03:00 UTC: a mesma data, mas
   * dependente do relógio do servidor. Num SaaS com servidor em outra região,
   * isso deslocaria prazos de todos os clientes de uma vez.
   */
  private paraData(iso: string | null | undefined): Date | null | undefined {
    if (iso === undefined) return undefined; // campo não enviado: não mexe
    if (iso === null) return null; // enviado como null: tira o prazo
    return new Date(`${iso}T00:00:00.000Z`);
  }

  /** O usuário existe, está ativo e é da mesma organização? */
  private async exigirUsuarioDaOrganizacao(userId: string, organizationId: string) {
    const alvo = await this.prisma.user.findFirst({
      where: { id: userId, organizationId, ativo: true },
      select: { id: true },
    });
    if (!alvo) throw new NotFoundException('Usuário não encontrado nesta organização.');
  }

  async criarTarefa(
    processoId: string,
    autor: Autor,
    dados: { titulo: string; tipo?: TipoTarefa; prazo?: string | null; responsavelId?: string | null },
  ) {
    await this.processoVisivel(processoId, autor);
    if (dados.responsavelId) {
      await this.exigirUsuarioDaOrganizacao(dados.responsavelId, autor.organizationId);
    }

    /* Sem evento na timeline, mesma razão da anotação: `titulo` é texto livre e
       o log é append-only. O que a timeline ganharia ("tarefa criada") não paga
       o risco de gravar "ligar para a filha da requerente" onde não se apaga. */
    return this.prisma.tarefaProcesso.create({
      data: {
        processoId,
        /* A org de quem cria — isola o "meu dia" deste tenant. Do JWT, nunca do corpo. */
        organizationId: autor.organizationId,
        titulo: dados.titulo.trim(),
        tipo: dados.tipo ?? 'TAREFA',
        prazo: this.paraData(dados.prazo) ?? null,
        responsavelId: dados.responsavelId ?? null,
        criadoPorId: autor.id,
      },
      select: this.selectTarefa,
    });
  }

  async editarTarefa(
    processoId: string,
    tarefaId: string,
    autor: Autor,
    dados: {
      titulo?: string;
      tipo?: TipoTarefa;
      prazo?: string | null;
      responsavelId?: string | null;
      concluida?: boolean;
    },
  ) {
    const tarefa = await this.tarefaParaEscrita(processoId, tarefaId, autor);
    if (dados.responsavelId) {
      await this.exigirUsuarioDaOrganizacao(dados.responsavelId, autor.organizationId);
    }

    /* Qualquer um com acesso ao processo edita e conclui — diferente da
       anotação, que só o autor edita. Anotação é uma AFIRMAÇÃO assinada por
       alguém; tarefa é trabalho combinado do time, e o caso normal é justamente
       outra pessoa concluir o que foi atribuído a ela. */
    const prazo = this.paraData(dados.prazo);

    return this.prisma.tarefaProcesso.update({
      where: { id: tarefaId },
      data: {
        ...(dados.titulo !== undefined ? { titulo: dados.titulo.trim() } : {}),
        ...(dados.tipo !== undefined ? { tipo: dados.tipo } : {}),
        ...(prazo !== undefined ? { prazo } : {}),
        ...(dados.responsavelId !== undefined ? { responsavelId: dados.responsavelId } : {}),
        /* Guarda QUANDO concluiu. Reabrir volta a null — e perde a data antiga
           de propósito: a tarefa passa a estar pendente de novo, e uma data de
           conclusão pendurada numa tarefa aberta mentiria na listagem. */
        ...(dados.concluida !== undefined
          ? { concluidaEm: dados.concluida ? (tarefa.concluidaEm ?? new Date()) : null }
          : {}),
      },
      select: this.selectTarefa,
    });
  }

  async removerTarefa(processoId: string, tarefaId: string, autor: Autor) {
    const tarefa = await this.tarefaParaEscrita(processoId, tarefaId, autor);

    /* Apagar é mais restrito que editar: quem criou, ou ADMIN. Concluir já
       resolve o caso comum ("isto não é mais necessário") sem destruir o
       registro de que a tarefa existiu. */
    if (tarefa.criadoPorId !== autor.id && autor.papel !== 'ADMIN') {
      throw new ForbiddenException('Só quem criou a tarefa, ou um administrador, pode removê-la.');
    }

    await this.prisma.tarefaProcesso.delete({ where: { id: tarefaId } });
    return { removida: true };
  }

  private async tarefaParaEscrita(processoId: string, tarefaId: string, autor: Autor) {
    await this.processoVisivel(processoId, autor);

    /* Filtra por processoId E por organizationId, como na anotação — e aqui o
       buraco era MAIOR: `editarTarefa` não checa autoria nenhuma, de propósito
       ("tarefa é trabalho combinado do time"). Sem o tenant, esse "time" incluía
       todo escritório a quem o mesmo processo foi liberado: qualquer usuário
       deles editaria, atribuiria ou concluiria a tarefa alheia. Com o filtro, o
       "qualquer um" volta a significar "qualquer um DA MINHA organização", que é
       o que o comentário de lá sempre quis dizer. */
    const tarefa = await this.prisma.tarefaProcesso.findFirst({
      where: { id: tarefaId, processoId, organizationId: autor.organizationId },
      select: { id: true, criadoPorId: true, concluidaEm: true },
    });
    if (!tarefa) throw new NotFoundException('Tarefa não encontrada neste processo.');
    return tarefa;
  }

  private readonly selectTarefa = {
    id: true,
    tipo: true,
    titulo: true,
    prazo: true,
    concluidaEm: true,
    criadoEm: true,
    responsavel: { select: { id: true, nome: true } },
    criadoPor: { select: { id: true, nome: true } },
  } as const;

  /**
   * A fila de trabalho do operador: tudo que está aberto e é dele.
   *
   * Inclui as tarefas SEM RESPONSÁVEL da organização, e não só as atribuídas.
   * Sem isso, uma tarefa que ninguém assumiu não aparece para ninguém — fica
   * invisível até alguém abrir por acaso o processo certo. É o pior tipo de
   * pendência: existe, tem prazo, e não está no radar de nenhuma pessoa.
   *
   * Os dois casos saem do MESMO índice `(responsavelId, concluidaEm, prazo)`:
   * NULL é indexado em btree, então `= eu OR IS NULL` são duas faixas do índice,
   * não uma varredura.
   *
   * O filtro por organização é redundante hoje — `criarTarefa` só aceita
   * responsável do mesmo tenant do processo, logo `responsavelId` já implica a
   * organização. Fica assim mesmo: é a rota que lista trabalho de VÁRIOS
   * processos de uma vez, e num produto multi-tenant o custo de um bug de
   * atribuição cruzada aqui seria vazamento entre clientes.
   *
   * Custo dele, MEDIDO com 41.880 tarefas na tabela (EXPLAIN ANALYZE):
   *  - 90 abertas para a pessoa (uso real): nested loop pela PK de processos,
   *    1,5 ms.
   *  - 12.564 abertas para UMA pessoa: o planejador troca para hash join e
   *    varre processos inteiro, 11,6 ms.
   * Ou seja, degrada com pendência acumulada, não com tamanho da base — e uma
   * pessoa com 12 mil tarefas abertas é problema de processo de trabalho antes
   * de ser de banco. Se um dia for necessário, a saída é desnormalizar
   * organizationId para cá e cobrir o filtro pelo mesmo índice.
   *
   * NÃO agrupa por "hoje/atrasada": esse recorte depende do fuso de quem lê, e
   * o servidor não sabe qual é. A tela classifica; aqui só sai ordenado.
   */
  async minhasTarefas(autor: Autor, limite = 200) {
    const where = {
      concluidaEm: null,
      OR: [{ responsavelId: autor.id }, { responsavelId: null }],
      /* Pelo organizationId da TAREFA, não do processo. O cliente cria tarefa num
         processo que pertence à org interna: filtrar pelo dono do processo
         devolveria a ele as tarefas do TIME e esconderia as dele próprias. É
         exatamente a desnormalização que a Fase A adicionou para esta consulta —
         e que o comentário do índice, lá no schema, já previa. */
      organizationId: autor.organizationId,
    };

    const [tarefas, total] = await Promise.all([
      this.prisma.tarefaProcesso.findMany({
        where,
        /* `nulls: 'last'` explícito: tarefa sem prazo não pode disputar o topo
           com a que vence amanhã. */
        orderBy: [{ prazo: { sort: 'asc', nulls: 'last' } }, { criadoEm: 'asc' }],
        take: limite,
        select: {
          ...this.selectTarefa,
          processo: {
            select: {
              id: true,
              numeroPrecatorio: true,
              entidadeDevedora: true,
              prioridade: true,
            },
          },
        },
      }),
      this.prisma.tarefaProcesso.count({ where }),
    ]);

    return { tarefas, total, truncado: total > tarefas.length };
  }

  // ── Funil comercial ──

  /**
   * Move o processo no funil.
   *
   * ── POR QUE UM CAMPO, E NÃO MAIS UMA ETIQUETA ──
   *
   * Etiqueta é vocabulário livre da organização: cada uma inventa a sua, duas
   * podem coexistir no mesmo processo, e nenhuma soma. "Quantos dos 250 deste
   * mês viraram proposta?" não tinha resposta possível — a informação existia,
   * espalhada em anotação de texto livre e em etiquetas que ninguém garantia
   * serem exclusivas.
   *
   * Estágio é UM valor de uma lista fechada. É o que permite contar.
   *
   * ── SEMPRE NO OVERLAY, MESMO PARA A OPERAÇÃO INTERNA ──
   *
   * Diferente de prioridade e responsável, aqui não há coluna equivalente no
   * `Processo` — e não deve haver. O funil é o processo COMERCIAL de quem
   * recebeu: o mesmo precatório pode estar em PROPOSTA para um escritório e
   * NOVO para outro, porque não há exclusividade. Uma coluna no processo faria
   * o avanço de um cliente aparecer na tela do outro.
   */
  async definirEstagio(
    processoId: string,
    autor: Autor,
    dados: { estagio: EstagioCrm; motivoPerda?: string | null },
  ) {
    await this.processoVisivel(processoId, autor);
    const chave = {
      organizationId_processoId: { organizationId: autor.organizationId, processoId },
    };

    const atual = await this.prisma.carteiraProcesso.findUnique({
      where: chave,
      select: { estagio: true },
    });
    const anterior = atual?.estagio ?? 'NOVO';
    const { estagio } = dados;

    /* O motivo só existe para a perda. Sair de PERDIDO limpa o campo em vez de
       deixar para trás uma justificativa de um estado que não vale mais — é o
       tipo de resíduo que depois aparece num relatório como se fosse atual. */
    const motivoPerda = estagio === 'PERDIDO' ? (dados.motivoPerda?.trim() || null) : null;

    if (anterior === estagio && atual) {
      /* Mesmo estágio, motivo novo: atualiza o motivo e pronto. Registrar
         "mudou de PERDIDO para PERDIDO" na timeline seria ruído. */
      if (estagio === 'PERDIDO') {
        await this.prisma.carteiraProcesso.update({ where: chave, data: { motivoPerda } });
      }
      return { estagio, alterado: false };
    }

    const agora = new Date();
    await this.prisma.$transaction([
      this.prisma.carteiraProcesso.upsert({
        where: chave,
        create: {
          organizationId: autor.organizationId,
          processoId,
          estagio,
          estagioEm: agora,
          motivoPerda,
        },
        update: { estagio, estagioEm: agora, motivoPerda },
      }),
      /* Evento SIM, pelo mesmo critério da prioridade: enum fechado, sem uma
         letra de dado pessoal, e "quem moveu para proposta e quando" é
         exatamente o histórico que um CRM precisa guardar de forma imutável.
         O MOTIVO da perda fica de fora — é texto livre, e a timeline é
         append-only. */
      this.prisma.eventoProcesso.create({
        data: {
          processoId,
          /* PRIVADO da org que escreveu: o funil de um cliente não aparece na
             timeline do outro nem na do time interno. */
          organizationId: autor.organizationId,
          tipo: 'STATUS_ALTERADO',
          descricao: `Funil: ${ESTAGIO_ROTULO[anterior]} → ${ESTAGIO_ROTULO[estagio]}`,
          camposAlterados: ['estagio'],
          detalhe: { estagio: { de: anterior, para: estagio } },
          userId: autor.id,
        },
      }),
    ]);

    return { estagio, alterado: true };
  }

  /**
   * Registra uma TENTATIVA de contato com o titular.
   *
   * ── POR QUE ESTRUTURADO, E NÃO MAIS UMA ANOTAÇÃO ──
   *
   * A pergunta que isto existe para responder é de contagem: quantas ligações
   * até uma proposta, quantos números errados (o que denuncia base de contato
   * velha), quem ainda não foi tocado. Anotação em texto livre guarda tudo isso
   * e não soma nada.
   *
   * ── REGISTRAR CONTATO TIRA O PROCESSO DE "NOVO" ──
   *
   * Automático, e só nessa transição. "Novo" significa "ninguém tocou": manter
   * ali um processo que acabou de receber uma ligação faria o funil mentir no
   * primeiro dia de uso. As transições seguintes são decisão de quem trabalha —
   * uma ligação não vira proposta sozinha.
   */
  async registrarContato(
    processoId: string,
    autor: Autor,
    dados: { canal?: CanalContato; resultado: ResultadoContato; observacao?: string | null },
  ) {
    await this.processoVisivel(processoId, autor);
    const chave = {
      organizationId_processoId: { organizationId: autor.organizationId, processoId },
    };

    const overlay = await this.prisma.carteiraProcesso.findUnique({
      where: chave,
      select: { estagio: true },
    });
    const saiDeNovo = (overlay?.estagio ?? 'NOVO') === 'NOVO';
    const agora = new Date();

    const [contato] = await this.prisma.$transaction([
      this.prisma.contatoProcesso.create({
        data: {
          processoId,
          organizationId: autor.organizationId,
          autorId: autor.id,
          canal: dados.canal ?? 'TELEFONE',
          resultado: dados.resultado,
          observacao: dados.observacao?.trim() || null,
        },
        select: {
          id: true,
          canal: true,
          resultado: true,
          observacao: true,
          criadoEm: true,
          autor: { select: { id: true, nome: true } },
        },
      }),
      /* `ultimoContatoEm` na MESMA transação: é ele que a fila usa para "quem
         está há mais tempo sem ser tocado", e um valor gravado fora daqui
         poderia divergir do que a tabela de contatos diz. */
      this.prisma.carteiraProcesso.upsert({
        where: chave,
        create: {
          organizationId: autor.organizationId,
          processoId,
          ultimoContatoEm: agora,
          estagio: 'EM_CONTATO',
          estagioEm: agora,
        },
        update: {
          ultimoContatoEm: agora,
          ...(saiDeNovo ? { estagio: 'EM_CONTATO' as const, estagioEm: agora } : {}),
        },
      }),
    ]);

    return { contato, estagio: saiDeNovo ? ('EM_CONTATO' as const) : (overlay?.estagio ?? 'NOVO') };
  }

  /** As tentativas de contato de um processo, da mais recente para a mais antiga. */
  async contatos(processoId: string, autor: Autor, limite = 50) {
    await this.processoVisivel(processoId, autor);
    return this.prisma.contatoProcesso.findMany({
      /* Escopado à ORGANIZAÇÃO: o contato que um escritório fez com o titular é
         trabalho comercial dele, e o escritório vizinho que recebeu o mesmo
         precatório não pode vê-lo. */
      where: { processoId, organizationId: autor.organizationId },
      orderBy: { criadoEm: 'desc' },
      take: Math.min(200, limite),
      select: {
        id: true,
        canal: true,
        resultado: true,
        observacao: true,
        criadoEm: true,
        autor: { select: { id: true, nome: true } },
      },
    });
  }

  /**
   * O funil em números: quantos processos da carteira em cada estágio.
   *
   * Processo LIBERADO que nunca ganhou linha no overlay não aparece no
   * `groupBy` — e ele é justamente o caso mais comum no começo do mês, o
   * processo que ninguém tocou. Por isso NOVO é calculado por diferença, e não
   * lido do agrupamento: sem isso, a tela mostraria um funil que soma menos que
   * a carteira e ninguém saberia onde foi parar o resto.
   */
  async funil(
    autor: Autor,
    params: {
      lote?: { tribunal: string; exercicio: number };
      /** Os MESMOS filtros da fila: o chip conta o que a lista mostraria. */
      filtros?: FiltrosDaFila;
      /** Janela do movimento, em dias. */
      dias?: number;
    } = {},
  ) {
    const { lote, filtros = {}, dias = 30 } = params;

    /* ── O MESMO RECORTE, E O MESMO CÓDIGO, QUE A FILA ──
       Sem o lote, o funil contaria a carteira INTEIRA enquanto a fila mostra um
       tribunal/exercício — e os dois números nunca fechariam. Foi assim que se
       descobriu: o funil dizia 500 e a fila, 183, para o mesmo cliente.
       Os FILTROS entram pela mesma razão, um degrau adiante: com "responsável =
       Ana" ligado, um chip que conta a carteira toda diria "Proposta 7" sobre
       uma lista de 3. Por isso as condições vêm de `condicoesDaFila` — o mesmo
       código, não uma cópia que envelhece. */
    /* O ESTOQUE ignora o filtro de estágio: clicar em "Proposta" não pode zerar
       os outros quatro chips, senão o operador perde a referência de onde está.
       O recorte de estágio é da LISTA; a contagem é da carteira filtrada pelo
       resto — e é este mesmo `where` que alimenta as QUATRO consultas abaixo. */
    const semEstagio: Prisma.ProcessoWhereInput = {
      AND: condicoesDaFila({ ...filtros, estagio: undefined }, { usuario: autor, lote }),
    };

    const desde = new Date(Date.now() - dias * 86_400_000);

    const [totalCarteira, porEstagio, semContato, movimento] = await Promise.all([
      this.prisma.processo.count({ where: semEstagio }),
      this.prisma.carteiraProcesso.groupBy({
        by: ['estagio'],
        where: { organizationId: autor.organizationId, processo: semEstagio },
        _count: { _all: true },
      }),
      this.prisma.processo.count({
        where: {
          ...semEstagio,
          OR: [
            { carteira: { none: { organizationId: autor.organizationId } } },
            { carteira: { some: { organizationId: autor.organizationId, ultimoContatoEm: null } } },
          ],
        },
      }),
      /* ── O MOVIMENTO SAI DE AGRUPAMENTO PURO, NUNCA POR DEDUÇÃO ──
         O estoque de NOVO é calculado por diferença (linha ausente = ninguém
         tocou). Copiar essa ideia aqui faria TODO processo jamais tocado contar
         como "movimentou" — o oposto exato do que a palavra diz. Movimento é o
         que TEM carimbo `estagioEm` dentro da janela, e ponto.

         Ele conta UMA VEZ por processo, no estágio em que ele está HOJE: quem
         virou proposta no dia 5 e fechou no dia 20 aparece em FECHADO. O banco
         guarda o último carimbo, não a trajetória — é por isso que a tela diz
         "movimentaram" e não "viraram proposta". */
      this.prisma.carteiraProcesso.groupBy({
        by: ['estagio'],
        where: {
          organizationId: autor.organizationId,
          processo: semEstagio,
          estagioEm: { gte: desde },
        },
        _count: { _all: true },
      }),
    ]);

    const conta = (e: EstagioCrm) => porEstagio.find((g) => g.estagio === e)?._count._all ?? 0;
    const moveu = (e: EstagioCrm) => movimento.find((g) => g.estagio === e)?._count._all ?? 0;
    const comOverlay = porEstagio.reduce((s, g) => s + g._count._all, 0);

    return {
      total: totalCarteira,
      /* Os sem overlay são NOVO por definição: ninguém os tocou. */
      NOVO: conta('NOVO') + (totalCarteira - comOverlay),
      EM_CONTATO: conta('EM_CONTATO'),
      PROPOSTA: conta('PROPOSTA'),
      FECHADO: conta('FECHADO'),
      PERDIDO: conta('PERDIDO'),
      /* O número que diz se a carteira está sendo TRABALHADA, e não só triada. */
      semContato,
      movimento: {
        dias,
        /* A data de corte vai JUNTO porque o carimbo `estagioEm` nasceu com a
           migration do funil: antes dela não há registro nenhum, e um zero solto
           afirmaria "nada se moveu" onde a verdade é "não sabemos". A tela
           imprime esta data em vez de deixar o número sozinho. */
        desde,
        NOVO: moveu('NOVO'),
        EM_CONTATO: moveu('EM_CONTATO'),
        PROPOSTA: moveu('PROPOSTA'),
        FECHADO: moveu('FECHADO'),
        PERDIDO: moveu('PERDIDO'),
      },
    };
  }

  /**
   * A CONVERSÃO POR SAFRA — a única forma honesta de dizer quanto se converte.
   *
   * ── POR QUE NÃO EXISTE "TAXA DE CONVERSÃO DA CARTEIRA" ──
   *
   * Entram 250 processos novos por mês e os fechados se acumulam para sempre.
   * Uma taxa calculada sobre esse estoque CAI todo mês por construção, sem
   * ninguém ter trabalhado pior — seria o melhor argumento de cancelamento que
   * se poderia entregar de bandeja a um cliente. Por safra o denominador é fixo:
   * "dos 250 que entraram em março, 18 fecharam" é uma frase que não se degrada.
   *
   * ── A CHAVE É `competencia`, NUNCA `liberadoEm` ──
   *
   * `gerarLote` aceita a competência de quem chama e permite regerar um mês
   * passado (ver distribuicao.service.ts). Nesse caso `liberadoEm` é HOJE e
   * `competencia` é junho: agrupar pela data de liberação jogaria um ciclo de
   * junho dentro da safra de agosto, e o dono veria um mês inflado e outro
   * mutilado sem pista nenhuma do motivo.
   *
   * ── SQL À MÃO, E NÃO groupBy ──
   *
   * São três junções (lote → liberação → processo) com um LEFT JOIN no overlay,
   * e o `groupBy` do Prisma não atravessa relação. Em duas consultas separadas
   * seria preciso trazer todos os ids para a memória — 3.000 por cliente hoje,
   * e o teto é o tamanho da base.
   *
   * A org INTERNA não tem linha em `processos_liberados`: é ela quem libera.
   * Para ela isto devolve lista vazia, e a tela mostra o funil sem as safras.
   */
  async safras(
    autor: Autor,
    params: { meses?: number; lote?: { tribunal: string; exercicio: number } } = {},
  ) {
    const meses = Math.min(36, Math.max(1, params.meses ?? 12));
    const sigla = params.lote?.tribunal ?? null;
    const exercicio = params.lote?.exercicio ?? null;

    const linhas = await this.prisma.$queryRaw<
      {
        competencia: Date;
        alvo: number;
        liberados: number;
        no_recorte: number;
        novo: number;
        em_contato: number;
        proposta: number;
        fechado: number;
        perdido: number;
      }[]
    >`
      SELECT
        l."competencia"                         AS competencia,
        l."quantidadeAlvo"                      AS alvo,
        COUNT(*)::int                           AS liberados,
        /* Quantos desta safra caem no lote que a tela está mostrando. Os dois
           números convivem porque o sorteio do ciclo NÃO filtra por tribunal:
           sem este, o dono compararia "250 liberados" com uma fila de 168 e
           concluiria que sumiram 82. */
        COUNT(*) FILTER (
          WHERE ${sigla}::text IS NULL
             OR (t."sigla" = ${sigla}::text AND p."exercicio" = ${exercicio}::int)
        )::int                                  AS no_recorte,
        COUNT(*) FILTER (WHERE COALESCE(cp."estagio"::text, 'NOVO') = 'NOVO')::int       AS novo,
        COUNT(*) FILTER (WHERE cp."estagio"::text = 'EM_CONTATO')::int                   AS em_contato,
        COUNT(*) FILTER (WHERE cp."estagio"::text = 'PROPOSTA')::int                     AS proposta,
        COUNT(*) FILTER (WHERE cp."estagio"::text = 'FECHADO')::int                      AS fechado,
        COUNT(*) FILTER (WHERE cp."estagio"::text = 'PERDIDO')::int                      AS perdido
      FROM lotes_assinatura l
      JOIN assinaturas a           ON a."id" = l."assinaturaId"
      JOIN processos_liberados pl  ON pl."loteId" = l."id"
      JOIN processos p             ON p."id" = pl."processoId"
      JOIN tribunais t             ON t."id" = p."tribunalId"
      /* LEFT: processo sem overlay é NOVO por AUSÊNCIA, e é o caso mais comum
         no começo do mês. Um JOIN comum sumiria com a maior parte da safra. */
      LEFT JOIN carteira_processo cp
             ON cp."processoId" = p."id" AND cp."organizationId" = ${autor.organizationId}::uuid
      WHERE a."organizationId" = ${autor.organizationId}::uuid
      GROUP BY l."id", l."competencia", l."quantidadeAlvo"
      ORDER BY l."competencia" DESC
      LIMIT ${meses}
    `;

    const inicioDoMes = new Date();
    inicioDoMes.setUTCDate(1);
    inicioDoMes.setUTCHours(0, 0, 0, 0);

    return linhas.map((l) => ({
      competencia: l.competencia,
      /* O mês corrente é PARCIAL por definição: ainda está acontecendo. Sem esta
         marca, o último ponto da série sempre pareceria uma queda. */
      parcial: l.competencia >= inicioDoMes,
      alvo: l.alvo,
      liberados: l.liberados,
      noRecorte: l.no_recorte,
      NOVO: l.novo,
      EM_CONTATO: l.em_contato,
      PROPOSTA: l.proposta,
      FECHADO: l.fechado,
      PERDIDO: l.perdido,
    }));
  }

  /**
   * Os motivos de perda escritos — o dado mais acionável do funil.
   *
   * Texto livre, e não categoria: com "perdido" ainda perto de zero em toda a
   * base, inventar sete categorias produziria um gráfico em que "Outro" domina.
   * Quando houver leitura suficiente, as categorias saem DAQUI — do que as
   * pessoas escreveram —, e não de uma reunião.
   */
  async perdas(
    autor: Autor,
    params: { limite?: number; lote?: { tribunal: string; exercicio: number } } = {},
  ) {
    const limite = Math.min(200, Math.max(1, params.limite ?? 50));
    const escopo: Prisma.ProcessoWhereInput = {
      AND: condicoesDaFila({ estagio: 'PERDIDO' }, { usuario: autor, lote: params.lote }),
    };

    const linhas = await this.prisma.carteiraProcesso.findMany({
      where: {
        organizationId: autor.organizationId,
        motivoPerda: { not: null },
        processo: escopo,
      },
      orderBy: { estagioEm: { sort: 'desc', nulls: 'last' } },
      take: limite,
      select: {
        motivoPerda: true,
        estagioEm: true,
        processo: { select: { id: true, numeroPrecatorio: true } },
      },
    });

    return linhas.map((l) => ({
      processoId: l.processo.id,
      numeroPrecatorio: l.processo.numeroPrecatorio,
      motivo: l.motivoPerda as string,
      quando: l.estagioEm,
    }));
  }

  /**
   * Teto de processos por ação em massa.
   *
   * Não é limitação de recurso: é o tamanho do ERRO possível. Marcar 500
   * processos como PERDIDO por engano já é um estrago sério de desfazer um a um;
   * cinco mil seria a carteira inteira de um cliente num clique. O teto obriga
   * quem quer mais a fazer em rodadas — e uma pausa entre elas é exatamente o
   * que dá chance de perceber o engano.
   */
  private static readonly TETO_LOTE = 500;

  /**
   * Aplica a MESMA mudança a vários processos de uma vez.
   *
   * ── POR QUE ISTO EXISTE ──
   *
   * O cliente recebe 250 processos por mês. Atribuir, priorizar ou mover no
   * funil um a um é o que transforma a carteira numa pilha: são 250 aberturas de
   * página para uma decisão que já foi tomada ("estes 40 são da Ana").
   *
   * ── IDS INVÁLIDOS NÃO DERRUBAM O LOTE ──
   *
   * A lista vem de uma tela que pode estar desatualizada — outro usuário mudou
   * o filtro, um processo saiu do recorte. Recusar tudo por causa de um id
   * obsoleto faria o operador refazer a seleção inteira sem entender por quê.
   * Aqui os invisíveis são IGNORADOS e CONTADOS: a resposta diz quantos foram e
   * quantos ficaram de fora, que é a informação que ele precisa para confiar no
   * que aconteceu.
   */
  async acaoEmLote(
    autor: Autor,
    dados: {
      processoIds: string[];
      estagio?: EstagioCrm;
      /** Só é gravado quando o destino é PERDIDO — como na rota individual. */
      motivoPerda?: string;
      prioridade?: PrioridadeProcesso;
      /** `null` remove o responsável. `undefined` não mexe. */
      responsavelId?: string | null;
      etiquetaIds?: string[];
    },
  ) {
    const pedidos = [...new Set(dados.processoIds)];
    if (pedidos.length === 0) throw new BadRequestException('Nenhum processo selecionado.');
    if (pedidos.length > CrmService.TETO_LOTE) {
      throw new BadRequestException(
        `A ação em massa aceita até ${CrmService.TETO_LOTE} processos por vez ` +
          `(foram ${pedidos.length}). Refine o filtro ou faça em rodadas.`,
      );
    }

    const mexeEmAlgo =
      dados.estagio !== undefined ||
      dados.prioridade !== undefined ||
      dados.responsavelId !== undefined ||
      (dados.etiquetaIds?.length ?? 0) > 0;
    if (!mexeEmAlgo) throw new BadRequestException('Nenhuma alteração pedida.');

    if (dados.responsavelId) {
      await this.exigirUsuarioDaOrganizacao(dados.responsavelId, autor.organizationId);
    }

    /* O MESMO `escopoProcessos` da escrita individual: o lote não pode ser a
       porta que aceita o UUID de outro tenant. */
    const visiveis = await this.prisma.processo.findMany({
      where: { id: { in: pedidos }, ...escopoProcessos(autor) },
      select: { id: true },
    });
    const ids = visiveis.map((p) => p.id);
    if (ids.length === 0) throw new NotFoundException('Nenhum dos processos foi encontrado.');

    if (dados.etiquetaIds?.length) {
      const daOrg = await this.prisma.etiqueta.findMany({
        where: { id: { in: dados.etiquetaIds }, organizationId: autor.organizationId },
        select: { id: true },
      });
      if (daOrg.length !== new Set(dados.etiquetaIds).size) {
        throw new BadRequestException('Etiqueta inexistente ou de outra organização.');
      }
    }

    /* ── ONDE PRIORIDADE E RESPONSÁVEL MORAM DEPENDE DE QUEM ESCREVE ──
       A mesma dualidade das escritas individuais: o time interno usa as colunas
       do próprio Processo; o cliente, o overlay dele. Duas fontes de verdade, de
       propósito — a triagem de um não pode virar a do outro sobre o mesmo
       processo liberado. O ESTÁGIO não tem essa dualidade: só existe no overlay.

       Escrever tudo no overlay aqui seria mais simples e faria a ação em massa
       do time interno divergir da individual — o mesmo botão gravando em
       lugares diferentes conforme o operador clicasse num processo ou em vinte. */
    const ehCliente = ehEscopoCliente(autor);

    const [overlays, processos] = await Promise.all([
      this.prisma.carteiraProcesso.findMany({
        where: { organizationId: autor.organizationId, processoId: { in: ids } },
        select: { processoId: true, estagio: true, prioridade: true, responsavelId: true },
      }),
      ehCliente
        ? Promise.resolve([])
        : this.prisma.processo.findMany({
            where: { id: { in: ids } },
            select: { id: true, prioridade: true, responsavelId: true },
          }),
    ]);
    const overlayDe = new Map(overlays.map((o) => [o.processoId, o]));
    const processoDe = new Map(processos.map((p) => [p.id, p]));
    const agora = new Date();

    const escritas: Prisma.PrismaPromise<unknown>[] = [];
    let alterados = 0;

    for (const processoId of ids) {
      const atual = overlayDe.get(processoId);
      const doProcesso = processoDe.get(processoId);
      const estagioAtual = atual?.estagio ?? 'NOVO';
      const prioridadeAtual = ehCliente
        ? (atual?.prioridade ?? 'NORMAL')
        : (doProcesso?.prioridade ?? 'NORMAL');
      const responsavelAtual = ehCliente
        ? (atual?.responsavelId ?? null)
        : (doProcesso?.responsavelId ?? null);

      const mudaEstagio = dados.estagio !== undefined && dados.estagio !== estagioAtual;
      const mudaPrioridade = dados.prioridade !== undefined && dados.prioridade !== prioridadeAtual;
      const mudaResponsavel =
        dados.responsavelId !== undefined && dados.responsavelId !== responsavelAtual;

      /* Só o que MUDA vai para o banco e para a timeline. Sem isso, aplicar
         "ALTA" a 200 processos dos quais 180 já eram ALTA escreveria 200 linhas
         de histórico dizendo que nada aconteceu. */
      if (mudaEstagio || mudaPrioridade || mudaResponsavel) {
        alterados++;

        /* O estágio vai SEMPRE para o overlay. Prioridade e responsável, só
           quando quem escreve é o cliente. */
        const dadosOverlay = {
          /* ── O MOTIVO DA PERDA, QUE ESTA LINHA APAGAVA ──
             Era `motivoPerda: null` incondicional. Duas consequências, as duas
             ruins: marcar 200 processos como perdidos de uma vez não deixava
             registrar POR QUÊ — e a resposta a "por que perdemos?" é o dado
             mais acionável do funil —, e quem já tinha motivo escrito o perdia.
             Agora vale a MESMA regra da rota individual (ver `definirEstagio`):
             o motivo só existe em PERDIDO, e sair de PERDIDO o limpa.
             Quem JÁ estava no estágio pedido não entra aqui (`mudaEstagio` é
             falso), então uma varrida repetida não apaga o que foi escrito. */
          ...(mudaEstagio
            ? {
                estagio: dados.estagio,
                estagioEm: agora,
                motivoPerda:
                  dados.estagio === 'PERDIDO' ? (dados.motivoPerda?.trim() || null) : null,
              }
            : {}),
          ...(ehCliente && mudaPrioridade ? { prioridade: dados.prioridade } : {}),
          ...(ehCliente && mudaResponsavel ? { responsavelId: dados.responsavelId } : {}),
        };
        if (Object.keys(dadosOverlay).length > 0) {
          escritas.push(
            this.prisma.carteiraProcesso.upsert({
              where: {
                organizationId_processoId: { organizationId: autor.organizationId, processoId },
              },
              create: { organizationId: autor.organizationId, processoId, ...dadosOverlay },
              update: dadosOverlay,
            }),
          );
        }

        if (!ehCliente && (mudaPrioridade || mudaResponsavel)) {
          escritas.push(
            this.prisma.processo.update({
              where: { id: processoId },
              data: {
                ...(mudaPrioridade ? { prioridade: dados.prioridade } : {}),
                ...(mudaResponsavel ? { responsavelId: dados.responsavelId } : {}),
              },
            }),
          );
        }

        const partes: string[] = [];
        if (mudaEstagio) partes.push(`funil ${ESTAGIO_ROTULO[estagioAtual]} → ${ESTAGIO_ROTULO[dados.estagio!]}`);
        if (mudaPrioridade)
          partes.push(`prioridade ${PRIORIDADE_ROTULO[prioridadeAtual]} → ${PRIORIDADE_ROTULO[dados.prioridade!]}`);
        if (mudaResponsavel) partes.push(dados.responsavelId ? 'responsável definido' : 'responsável removido');

        escritas.push(
          this.prisma.eventoProcesso.create({
            data: {
              processoId,
              organizationId: autor.organizationId,
              tipo: 'STATUS_ALTERADO',
              /* Diz que veio de uma ação em MASSA: quem lê a timeline meses
                 depois precisa distinguir uma decisão sobre este processo de
                 uma varrida sobre duzentos. */
              descricao: `Em lote: ${partes.join(', ')}`,
              camposAlterados: [
                ...(mudaEstagio ? ['estagio'] : []),
                ...(mudaPrioridade ? ['prioridade'] : []),
                ...(mudaResponsavel ? ['responsavel'] : []),
              ],
              /* O DE/PARA em campo, como a rota individual já faz — e não só na
                 frase da descrição.

                 Sem isto, a única operação que a timeline registrava de forma
                 ilegível por máquina era justamente a que move 250 processos de
                 uma vez. Qualquer pergunta futura do tipo "quanto tempo um
                 processo fica em PROPOSTA" teria de ignorar as varridas, que são
                 a maioria dos movimentos. O passado não volta; daqui para a
                 frente, fica gravado.

                 Só enum e id — nenhuma letra de dado pessoal entra aqui, porque
                 EventoProcesso é append-only e não se apaga a pedido do titular
                 (é a mesma razão de o motivo da perda ficar de fora). */
              detalhe: {
                emLote: true,
                ...(mudaEstagio ? { estagio: { de: estagioAtual, para: dados.estagio } } : {}),
                ...(mudaPrioridade
                  ? { prioridade: { de: prioridadeAtual, para: dados.prioridade } }
                  : {}),
                ...(mudaResponsavel
                  ? { responsavel: { de: responsavelAtual, para: dados.responsavelId } }
                  : {}),
              },
              userId: autor.id,
            },
          }),
        );
      }

      if (dados.etiquetaIds?.length) {
        /* ACRESCENTA, não substitui: o `PUT` de etiquetas do processo individual
           troca o conjunto inteiro, e fazer isso em massa apagaria a triagem que
           alguém já tinha feito em cada um deles. */
        escritas.push(
          this.prisma.processoEtiqueta.createMany({
            data: dados.etiquetaIds.map((etiquetaId) => ({ processoId, etiquetaId })),
            skipDuplicates: true,
          }),
        );
      }
    }

    if (escritas.length > 0) await this.prisma.$transaction(escritas);

    return {
      pedidos: pedidos.length,
      aplicados: ids.length,
      /* Quantos de fato mudaram de valor — o resto já estava como se pediu. */
      alterados,
      /* Ids que a seleção trazia e que não são (mais) visíveis. */
      ignorados: pedidos.length - ids.length,
    };
  }

  // ── Prioridade e responsável ──

  async definirPrioridade(processoId: string, autor: Autor, prioridade: PrioridadeProcesso) {
    const atual = await this.processoVisivel(processoId, autor);
    const ehCliente = ehEscopoCliente(autor);
    const chave = {
      organizationId_processoId: { organizationId: autor.organizationId, processoId },
    };

    /* ONDE a prioridade mora depende de quem escreve: o time interno usa a coluna
       do próprio Processo; o cliente, o overlay dele. Duas fontes de verdade, de
       propósito (ver CarteiraProcesso no schema) — a triagem de um não pode virar
       a do outro sobre o mesmo processo liberado. */
    const anterior = ehCliente
      ? ((
          await this.prisma.carteiraProcesso.findUnique({
            where: chave,
            select: { prioridade: true },
          })
        )?.prioridade ?? 'NORMAL')
      : atual.prioridade;

    if (anterior === prioridade) return { prioridade, alterado: false };

    const gravar = ehCliente
      ? this.prisma.carteiraProcesso.upsert({
          where: chave,
          create: { organizationId: autor.organizationId, processoId, prioridade },
          update: { prioridade },
        })
      : this.prisma.processo.update({ where: { id: processoId }, data: { prioridade } });

    await this.prisma.$transaction([
      gravar,
      /* Aqui SIM vai evento: prioridade é enum fechado, sem uma letra de dado
         pessoal, e "quem marcou como urgente e quando" é exatamente o histórico
         que um CRM precisa guardar de forma imutável. */
      this.prisma.eventoProcesso.create({
        data: {
          processoId,
          /* PRIVADO da org que escreveu: a triagem interna não aparece na
             timeline do cliente, nem a dele na do time. Só os FATOS do processo
             (importado, atualizado) ficam com organizationId NULL. */
          organizationId: autor.organizationId,
          tipo: 'STATUS_ALTERADO',
          descricao: `Prioridade alterada de ${PRIORIDADE_ROTULO[anterior]} para ${PRIORIDADE_ROTULO[prioridade]}`,
          camposAlterados: ['prioridade'],
          detalhe: { prioridade: { de: anterior, para: prioridade } },
          userId: autor.id,
        },
      }),
    ]);

    return { prioridade, alterado: true };
  }

  async definirResponsavel(processoId: string, autor: Autor, responsavelId: string | null) {
    const atual = await this.processoVisivel(processoId, autor);

    /* O responsável tem de ser da MESMA organização. Sem esta checagem, um id de
       usuário de outro tenant entraria como responsável e o nome dele apareceria
       na tela de quem não deveria sequer saber que ele existe. */
    if (responsavelId) await this.exigirUsuarioDaOrganizacao(responsavelId, autor.organizationId);

    const ehCliente = ehEscopoCliente(autor);
    const chave = {
      organizationId_processoId: { organizationId: autor.organizationId, processoId },
    };

    /* Mesma divisão da prioridade: coluna do Processo para o time interno, overlay
       para o cliente. */
    const anterior = ehCliente
      ? ((
          await this.prisma.carteiraProcesso.findUnique({
            where: chave,
            select: { responsavelId: true },
          })
        )?.responsavelId ?? null)
      : atual.responsavelId;

    if (anterior === responsavelId) return { responsavelId, alterado: false };

    const gravar = ehCliente
      ? this.prisma.carteiraProcesso.upsert({
          where: chave,
          create: { organizationId: autor.organizationId, processoId, responsavelId },
          update: { responsavelId },
        })
      : this.prisma.processo.update({ where: { id: processoId }, data: { responsavelId } });

    await this.prisma.$transaction([
      gravar,
      this.prisma.eventoProcesso.create({
        data: {
          processoId,
          /* Privado da org que escreveu — ver a nota em definirPrioridade. */
          organizationId: autor.organizationId,
          tipo: 'STATUS_ALTERADO',
          /* Sem NOME na descrição, e só UUID no detalhe. A tabela é append-only:
             o nome de um funcionário gravado aqui sobreviveria à saída dele da
             empresa e a um pedido de exclusão dele. O id é pseudônimo — apagado
             o usuário, aponta para ninguém. A tela resolve o nome na leitura,
             enquanto ele existir. */
          descricao: responsavelId ? 'Responsável atribuído' : 'Responsável removido',
          camposAlterados: ['responsavelId'],
          detalhe: { responsavelId: { de: anterior, para: responsavelId } },
          userId: autor.id,
        },
      }),
    ]);

    return { responsavelId, alterado: true };
  }

  // ── Etiquetas ──

  async listarEtiquetas(organizationId: string) {
    return this.prisma.etiqueta.findMany({
      where: { organizationId },
      orderBy: { nome: 'asc' },
      select: { id: true, nome: true, cor: true, _count: { select: { processos: true } } },
    });
  }

  async criarEtiqueta(organizationId: string, dados: { nome: string; cor?: string }) {
    const nome = dados.nome.trim().replace(/\s+/g, ' ');

    /* Upsert e não create: o @@unique já impede a duplicata, mas devolver 500 de
       violação de constraint para "essa etiqueta já existe" é péssima resposta.
       Aqui criar uma etiqueta existente devolve a existente — idempotente, que é
       o que a tela quer ao digitar um nome no seletor. */
    return this.prisma.etiqueta.upsert({
      where: { organizationId_nome: { organizationId, nome } },
      create: { organizationId, nome, cor: dados.cor ?? 'marca-ciano' },
      update: {},
      select: { id: true, nome: true, cor: true },
    });
  }

  async definirEtiquetas(processoId: string, autor: Autor, etiquetaIds: string[]) {
    await this.processoVisivel(processoId, autor);

    const unicos = [...new Set(etiquetaIds)];

    /* Confere que TODAS pertencem à organização antes de gravar qualquer uma.
       Validar dentro do laço deixaria o processo com metade das etiquetas
       aplicadas quando uma delas fosse inválida. */
    if (unicos.length > 0) {
      const validas = await this.prisma.etiqueta.count({
        where: { id: { in: unicos }, organizationId: autor.organizationId },
      });
      if (validas !== unicos.length) {
        throw new NotFoundException('Alguma etiqueta não existe nesta organização.');
      }
    }

    /* ⚠ O `deleteMany` PRECISA do filtro de organização.
       `ProcessoEtiqueta` só tem (processoId, etiquetaId); o tenant mora em
       `Etiqueta.organizationId`. Sem esta cláusula, salvar as etiquetas de um
       processo LIBERADO apagava também as do time interno e as dos demais
       clientes — destruição de dado entre tenants, no uso normal do produto,
       sem ataque nenhum. E como a leitura sempre foi escopada, nenhum dos lados
       conseguia sequer diagnosticar: as etiquetas do outro simplesmente sumiam.

       O caso mais perverso era `etiquetaIds: []`, que pula a validação acima
       inteira: um cliente sem etiqueta alguma zerava a triagem interna.

       Transação: apagar e recriar precisa ser atômico, senão uma falha no meio
       deixaria o processo SEM etiqueta nenhuma — pior que não ter mudado. */
    const doTenant = { processoId, etiqueta: { organizationId: autor.organizationId } };
    await this.prisma.$transaction([
      this.prisma.processoEtiqueta.deleteMany({ where: doTenant }),
      this.prisma.processoEtiqueta.createMany({
        data: unicos.map((etiquetaId) => ({ processoId, etiquetaId })),
      }),
    ]);

    /* Mesma ordenação da leitura do processo. Sem orderBy o Postgres devolve na
       ordem que quiser, e as etiquetas dançariam na tela a cada clique — parecendo
       que salvou outra coisa. O escopo aqui também é do tenant: devolver a
       etiqueta de outra organização vazaria o vocabulário interno dela. */
    return this.prisma.processoEtiqueta.findMany({
      where: doTenant,
      orderBy: { etiqueta: { nome: 'asc' } },
      select: { etiqueta: { select: { id: true, nome: true, cor: true } } },
    });
  }

  // ── Equipe (para o seletor de responsável) ──

  /**
   * Usuários que podem receber um processo.
   *
   * Só id, nome e papel — o seletor não precisa de e-mail, e devolver a lista de
   * e-mails corporativos numa rota de leitura ampla é superfície que não paga o
   * que custa. CLIENTE fica de fora: não trabalha processo.
   */
  async equipe(organizationId: string) {
    return this.prisma.user.findMany({
      /* SEM filtro de papel. Numa org CLIENTE todo usuário tem papel CLIENTE, e o
         filtro antigo (`ADMIN`/`OPERADOR`) devolveria lista VAZIA — o seletor de
         responsável do cliente nasceria quebrado, sem erro nenhum para denunciar.
         O recorte que importa é a ORGANIZAÇÃO: ninguém recebe processo de outro
         tenant, e é isso que esta cláusula garante. */
      where: { organizationId, ativo: true },
      orderBy: { nome: 'asc' },
      select: { id: true, nome: true, papel: true },
    });
  }
}
