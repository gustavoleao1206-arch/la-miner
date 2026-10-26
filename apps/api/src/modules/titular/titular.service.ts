import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { escopoGlobal } from '../../prisma/sentinela-escopo';

/**
 * O motivo, escrito UMA vez porque é o mesmo nas oito chamadas abaixo.
 *
 * Todas atravessam organizações de propósito, e a razão é sempre esta: o pedido
 * é da PESSOA, não de um contrato. Ela não escolheu para quais escritórios o
 * processo dela foi liberado, então não faria sentido a exclusão alcançar
 * apenas o escritório de quem por acaso operou o botão.
 *
 * ⚠ Acrescentar `organizationId` a estas consultas não seria "mais seguro" —
 * seria ERRADO: recortaria a exclusão a um escritório e deixaria o dado da
 * pessoa em todos os outros. O `escopoGlobal` existe para que o sentinela de
 * escopo saiba que a ausência foi DECIDIDA, e não esquecida.
 */
const PEDIDO_E_DA_PESSOA =
  'exclusao do titular (LGPD art. 18): o pedido e da pessoa e nao de um contrato, ' +
  'entao alcanca todos os escritorios que receberam o processo dela';

/**
 * Direitos do titular dos dados (LGPD).
 *
 * ── O QUE É APAGADO, E O QUE NÃO É ──
 *
 * APAGADO — tudo que veio do provedor de enriquecimento, porque é dado que NÓS
 * fomos buscar:
 *   • telefones, e-mails e endereços;
 *   • data de nascimento, nome da mãe, situação cadastral e óbito;
 *   • `dadosBrutos` de TODAS as consultas — e este é o que mais importa. Apagar
 *     só as tabelas de contato deixaria a resposta crua do provedor intacta no
 *     histórico, com tudo dentro. Seria uma exclusão de fachada.
 *
 * APAGADO TAMBÉM — o TEXTO LIVRE que a equipe escreveu nos processos desta
 * pessoa. Não veio de provedor: veio do teclado de um advogado, e é onde cabe
 * qualquer coisa ("a filha ligou do 81 9xxxx"). Nenhuma tabela de contato o
 * alcançava, então a exclusão se declarava cumprida com o dado no banco:
 *   • `ProcessoPessoa.observacoes` — some, e é a única cirúrgica: a linha é
 *     (processo, pessoa), então não encosta nos outros titulares;
 *   • `ContatoProcesso.observacao` e `CarteiraProcesso.motivoPerda` — vão a NULO,
 *     preservando o FATO (canal, resultado, data, estágio), que é métrica do
 *     escritório e não diz nada sobre a pessoa;
 *   • `AnotacaoProcesso` — a LINHA é apagada, porque aqui a linha é o conteúdo;
 *   • `TarefaProcesso.titulo` — vira marcador, porque a coluna é NOT NULL e a
 *     tarefa pode estar em aberto no trabalho de alguém.
 * Vale para TODOS os escritórios com o processo liberado — o pedido é da pessoa,
 * não de um contrato. Em processo com mais de um titular, alcança texto que fala
 * dos demais: é o lado seguro do erro, e está dito aqui de propósito.
 *
 * APAGADO TAMBÉM — a LINHA CRUA DA PLANILHA (`ImportacaoLinha.dadosBrutos`),
 * que guardava nome, CPF e todas as colunas do tribunal indefinidamente, com o
 * CPF indexado. Era a maior cópia integral que a exclusão não alcançava: o
 * pedido era declarado cumprido com o dado inteiro no banco.
 *
 * RETIRADO DE CIRCULAÇÃO — as LIBERAÇÕES do processo são apagadas, em todas as
 * organizações — EXCETO onde há proposta ACEITA, porque ali existe um contrato
 * que a própria pessoa assinou com aquele escritório —, e o serviço de
 * distribuição passa a recusar processo com parte excluída. Sem isso a exclusão
 * era só "perder o telefone": o sorteio da madrugada seguinte continuava
 * entregando o precatório da mesma pessoa a escritórios NOVOS, com nome, CPF,
 * requisitório e valor — cada entrega um controlador a mais recebendo o dado de
 * quem já tinha pedido para sair.
 * Eliminar de vez não cabe (CPF e nome vêm do ato público do tribunal, ver
 * abaixo); o que resta devido, então, é BLOQUEAR: parar de tratar.
 *
 * PRESERVADO, e cada um por um motivo distinto:
 *   • CPF e NOME — vêm do precatório, que é ato PÚBLICO publicado pelo tribunal.
 *     Não é dado que obtivemos do titular, e apagá-lo desligaria a pessoa do
 *     processo, quebrando a própria carteira. Quem quiser sair do diário
 *     oficial fala com o tribunal, não conosco.
 *   • A LINHA de `Enriquecimento` (sem o conteúdo) — é a prova de QUANDO
 *     consultamos, quanto custou e com que resultado. É o que responde "vocês
 *     trataram meus dados?" com "sim, nestas datas, e apagamos aqui".
 *   • A trilha de `ConsultaCliente` — accountability. Apagá-la a pedido
 *     destruiria justamente o registro que demonstra conformidade, e a própria
 *     LGPD (art. 16) admite guardar para cumprimento de obrigação legal.
 *
 * Essa fronteira é uma leitura de engenharia, não um parecer jurídico. Está
 * documentada aqui para que o dono possa contestá-la com o advogado dele.
 *
 * ── POR QUE É IRREVERSÍVEL, E POR QUE PRECISA SER ──
 *
 * `statusEnriquecimento` vai para EXCLUIDO, que não entra em nenhuma lista de
 * seleção da fila. Sem isso, o cron pegaria a pessoa no ciclo seguinte e o
 * provedor reporia tudo — a exclusão duraria até o próximo domingo.
 */
@Injectable()
export class TitularService {
  private readonly logger = new Logger(TitularService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** O que existe hoje sobre um CPF. Leitura, para instruir a decisão. */
  async situacao(cpf: string) {
    const pessoa = await this.prisma.pessoa.findUnique({
      where: { cpf },
      select: {
        id: true,
        nome: true,
        statusEnriquecimento: true,
        exclusaoEm: true,
        exclusaoMotivo: true,
        _count: {
          select: { telefones: true, emails: true, enderecos: true, enriquecimento: true, processos: true },
        },
      },
    });
    if (!pessoa) throw new NotFoundException('Nenhum titular com este CPF na base.');

    const comDadosBrutos = await this.prisma.enriquecimento.count({
      where: { pessoaId: pessoa.id, dadosBrutos: { not: Prisma.DbNull } },
    });

    return {
      nome: pessoa.nome,
      statusEnriquecimento: pessoa.statusEnriquecimento,
      excluido: pessoa.exclusaoEm !== null,
      exclusaoEm: pessoa.exclusaoEm,
      exclusaoMotivo: pessoa.exclusaoMotivo,
      contatos: {
        telefones: pessoa._count.telefones,
        emails: pessoa._count.emails,
        enderecos: pessoa._count.enderecos,
      },
      consultas: pessoa._count.enriquecimento,
      /* O número que revela exclusão de fachada: se houver payload guardado, o
         dado ainda está aqui, por mais vazias que estejam as tabelas acima. */
      consultasComRespostaGuardada: comDadosBrutos,
      processosVinculados: pessoa._count.processos,
    };
  }

  /**
   * ACESSO E PORTABILIDADE (LGPD art. 18, II e V).
   *
   * `situacao` responde "existe tratamento?" com CONTAGENS — serve para instruir
   * a decisão de quem atende. Isto aqui é outra coisa: é o dado em si, em
   * formato legível por máquina, que é o que o titular tem direito de receber.
   *
   * ── A FRONTEIRA: DE QUEM É A CANETA ──
   *
   * Sai tudo que NÓS fomos buscar ou derivamos: identificação, contatos,
   * histórico de consultas ao provedor, os processos em que a pessoa é parte, e
   * — art. 18, VII — QUAIS ESCRITÓRIOS receberam o processo dela e quando.
   *
   * NÃO sai o texto livre do CRM (anotação, observação de contato, título de
   * tarefa, motivo de perda). Parece incoerente à primeira vista, porque a
   * EXCLUSÃO apaga tudo isso — e não é: quem escreveu aquele texto foi o
   * escritório assinante, que ali é controlador do próprio tratamento. Na
   * exclusão nós alcançamos o texto porque ele fala DELA; no acesso, entregá-lo
   * seria devolver o trabalho de um terceiro em nome dele. Quem quiser esse
   * conteúdo pede ao escritório, e a Política já diz que ele vira controlador
   * quando passa a prospectar.
   *
   * NÃO sai `dadosBrutos` do provedor, por três motivos somados: traz gente que
   * não é ela (a Contactra devolve relacionados), é cópia do que já foi extraído
   * para as tabelas de contato, e é justamente o que a retenção apaga aos 180
   * dias. Sai a EXISTÊNCIA da consulta, que é o que presta contas.
   *
   * NÃO sai dado de co-titular: em processo com mais de um requerente, vem o
   * `valorIndividual` DELA, nunca o dos outros.
   */
  async dados(cpf: string, ator: { id: string; organizationId: string }) {
    const pessoa = await this.prisma.pessoa.findUnique({
      where: { cpf },
      /* Projeção por REMONTAGEM, campo a campo. Nunca `...pessoa`: um campo novo
         no modelo entraria na exportação sem ninguém decidir que ele deve sair
         daqui — e a decisão de o que um titular recebe não pode ser efeito
         colateral de uma migration. */
      select: {
        id: true,
        cpf: true,
        nome: true,
        dataNascimento: true,
        nomeMae: true,
        situacaoCadastral: true,
        obito: true,
        exclusaoEm: true,
        telefones: { select: { ddd: true, numero: true, tipo: true, whatsapp: true, ativo: true } },
        emails: { select: { endereco: true, ativo: true } },
        enderecos: {
          select: {
            logradouro: true,
            numero: true,
            complemento: true,
            bairro: true,
            cidade: true,
            uf: true,
            cep: true,
            ativo: true,
          },
        },
        enriquecimento: {
          select: { provider: true, status: true, criadoEm: true },
          orderBy: { criadoEm: 'desc' },
        },
        processos: {
          select: {
            valorIndividual: true,
            papel: true,
            processo: {
              select: {
                numeroPrecatorio: true,
                numeroOriginario: true,
                exercicio: true,
                tribunal: { select: { sigla: true, nome: true } },
                liberacoes: {
                  select: { liberadoEm: true, organization: { select: { nome: true } } },
                  orderBy: { liberadoEm: 'asc' },
                },
              },
            },
          },
        },
      },
    });
    if (!pessoa) throw new NotFoundException('Nenhum titular com este CPF na base.');

    const processos = pessoa.processos.map((p) => ({
      numeroPrecatorio: p.processo.numeroPrecatorio,
      numeroOriginario: p.processo.numeroOriginario,
      exercicio: p.processo.exercicio,
      tribunal: p.processo.tribunal.sigla,
      tribunalNome: p.processo.tribunal.nome,
      papelNoProcesso: p.papel,
      /* Decimal do Prisma é objeto; `Number` aqui e não no `select` porque a
         conversão é da APRESENTAÇÃO, e deixá-la no banco esconderia que houve
         conversão. Valor NULO continua nulo — não vira zero, que mentiria. */
      valorIndividual: p.valorIndividual === null ? null : Number(p.valorIndividual),
      /* Art. 18, VII: com quem compartilhamos. É a pergunta que mais surpreende
         quem pede acesso, e a que o sistema tem condição de responder com data. */
      escritoriosQueReceberam: p.processo.liberacoes.map((l) => ({
        escritorio: l.organization.nome,
        recebidoEm: l.liberadoEm,
      })),
    }));

    /* A trilha do atendimento vai para `AuditLog`, e SÓ COM CONTAGENS.
       Gravar o conteúdo exportado aqui seria a rota de acesso derrubando a rota
       de exclusão: `excluir` não toca em `audit_logs`, então um telefone escrito
       neste registro sobreviveria ao pedido de apagar.
       E não vai para `ConsultaCliente` de propósito: `auditoria.trilhaCpf` casa
       por CPF, então o atendimento de hoje apareceria dentro do relatório do
       próximo pedido da mesma pessoa, inflando o número que ela pediu para
       conferir. */
    await this.prisma.auditLog
      .create({
        data: {
          organizationId: ator.organizationId,
          userId: ator.id,
          acao: 'ACESSO_TITULAR',
          entidade: 'Pessoa',
          entidadeId: pessoa.id,
          dadosAntes: {
            telefones: pessoa.telefones.length,
            emails: pessoa.emails.length,
            enderecos: pessoa.enderecos.length,
            processos: processos.length,
            consultas: pessoa.enriquecimento.length,
          },
        },
      })
      .catch(() => undefined);

    return {
      geradoEm: new Date(),
      identificacao: {
        cpf: pessoa.cpf,
        nome: pessoa.nome,
        dataNascimento: pessoa.dataNascimento,
        nomeMae: pessoa.nomeMae,
        situacaoCadastral: pessoa.situacaoCadastral,
        obito: pessoa.obito,
      },
      excluidoEm: pessoa.exclusaoEm,
      contatos: {
        telefones: pessoa.telefones,
        emails: pessoa.emails,
        enderecos: pessoa.enderecos,
      },
      origemDosDados: {
        /* O que responde "de onde vocês tiraram isto?" sem entregar o payload. */
        creditosJudiciais: 'publicações e sistemas de tribunais federais, estaduais e trabalhistas',
        contatos: 'provedor de enriquecimento cadastral contratado',
        consultasAoProvedor: pessoa.enriquecimento.map((e) => ({
          provedor: e.provider,
          resultado: e.status,
          consultadoEm: e.criadoEm,
        })),
      },
      processos,
    };
  }

  /**
   * Atende ao pedido de exclusão.
   *
   * Idempotente: repetir num titular já excluído não é erro — quem pede duas
   * vezes tem direito à mesma resposta, e um 409 aqui só geraria dúvida sobre
   * se o primeiro pedido foi atendido.
   */
  async excluir(cpf: string, motivo: string, autorId: string) {
    const pessoa = await this.prisma.pessoa.findUnique({
      where: { cpf },
      select: { id: true, nome: true, exclusaoEm: true },
    });
    if (!pessoa) throw new NotFoundException('Nenhum titular com este CPF na base.');

    if (pessoa.exclusaoEm) {
      return {
        cpfMascarado: this.mascarar(cpf),
        jaEstavaExcluido: true,
        exclusaoEm: pessoa.exclusaoEm,
        apagados: {
          telefones: 0,
          emails: 0,
          enderecos: 0,
          respostasDoProvedor: 0,
          observacoesDaParte: 0,
          observacoesDeContato: 0,
          anotacoes: 0,
          tarefasAnonimizadas: 0,
          motivosDePerda: 0,
          liberacoesRevogadas: 0,
          linhasDePlanilha: 0,
          propostasApagadas: 0,
          propostasComValoresLimpos: 0,
          observacoesDeProposta: 0,
          parcelasApagadas: 0,
        },
      };
    }

    /* UM instante, usado na gravação E na resposta. Chamar `new Date()` de novo
       lá embaixo devolveria ao solicitante uma data que não é a que ficou no
       banco — diferença de milissegundos, mas é justamente esta data que vira
       prova de atendimento. Prova precisa bater com o registro. */
    const agora = new Date();

    /* Transação: uma exclusão pela metade é pior que nenhuma — deixaria o
       titular marcado como atendido com o dado ainda no banco. */
    const r = await this.prisma.$transaction(async (tx) => {
      const [tel, mail, end, brutos] = await Promise.all([
        tx.telefone.deleteMany({ where: { pessoaId: pessoa.id } }),
        tx.email.deleteMany({ where: { pessoaId: pessoa.id } }),
        tx.endereco.deleteMany({ where: { pessoaId: pessoa.id } }),
        /* A LINHA fica (é a prova de que consultamos); o CONTEÚDO vai embora. */
        tx.enriquecimento.updateMany({
          where: { pessoaId: pessoa.id },
          data: { dadosBrutos: Prisma.DbNull },
        }),
      ]);

      /* ── O TEXTO LIVRE DO CRM ──
         Até aqui a exclusão apagava só o que o PROVEDOR trouxe. Mas o dado
         pessoal mais indefensável do sistema não vem de provedor nenhum: é o que
         um advogado digita. "Filha ligou do 81 9xxxx, ele está internado" mora
         numa observação de contato, e nenhuma das tabelas acima a alcançava — a
         exclusão declarava-se cumprida com o dado no banco.

         O alcance são os processos em que ESTA pessoa é parte, e é aqui que
         aparece a consequência da decisão do dono de a negociação ser por
         PROCESSO e não por titular: nos processos com mais de um titular (230 na
         base de hoje), apagar por um alcança o texto que fala dos outros. É o
         lado seguro do erro — a alternativa seria deixar dado de quem pediu
         exclusão no banco —, mas está escrito aqui para não surpreender ninguém.

         Vale para TODOS os escritórios que têm o processo liberado, não só um: o
         pedido é da pessoa, não de um contrato. */
      const partes = await tx.processoPessoa.findMany({
        where: { pessoaId: pessoa.id },
        select: { processoId: true },
      });
      const processoIds = partes.map((p) => p.processoId);

      const [observacoesDaParte, contatos, anotacoes, tarefas, motivos] = await Promise.all([
        /* A ÚNICA que é cirúrgica: `observacoes` está na linha (processo, pessoa),
           então some só o que fala desta pessoa, sem tocar nos outros titulares. */
        tx.processoPessoa.updateMany({
          where: { pessoaId: pessoa.id, observacoes: { not: null } },
          data: { observacoes: null },
        }),
        /* O FATO fica (canal, resultado, data): é a métrica do escritório e não
           diz nada sobre a pessoa além de que se tentou falar com ela. O texto,
           que é onde cabe qualquer coisa, vai embora. */
        tx.contatoProcesso.updateMany(
          escopoGlobal(PEDIDO_E_DA_PESSOA, {
            where: { processoId: { in: processoIds }, observacao: { not: null } },
            data: { observacao: null },
          }),
        ),
        /* Aqui a linha É o conteúdo — não há fato a preservar. O próprio
           `removerAnotacao` já diz que ADMIN apaga a de qualquer um justamente
           para tornar o art. 18 executável; isto só deixa de depender de alguém
           lembrar de fazer à mão. */
        tx.anotacaoProcesso.deleteMany(
          escopoGlobal(PEDIDO_E_DA_PESSOA, { where: { processoId: { in: processoIds } } }),
        ),
        /* `titulo` é NOT NULL e a tarefa pode estar em aberto no trabalho de
           alguém: apagar a linha faria sumir compromisso combinado. Fica a
           tarefa, sai o texto. */
        tx.tarefaProcesso.updateMany(
          escopoGlobal(PEDIDO_E_DA_PESSOA, {
            where: { processoId: { in: processoIds } },
            data: { titulo: '[conteúdo removido a pedido do titular]' },
          }),
        ),
        tx.carteiraProcesso.updateMany(
          escopoGlobal(PEDIDO_E_DA_PESSOA, {
            where: { processoId: { in: processoIds }, motivoPerda: { not: null } },
            data: { motivoPerda: null },
          }),
        ),
      ]);

      /* ── TIRAR DE CIRCULAÇÃO, E NÃO SÓ APAGAR O CONTATO ──
         Até aqui a exclusão limpava tudo que se podia limpar e deixava o
         processo LIBERADO nas carteiras que já o tinham — e o sorteio da
         madrugada seguinte continuava entregando a mesma pessoa a escritórios
         novos. O pedido é da PESSOA, não de um contrato: sai de todas as
         organizações, não da que reclamou.

         A LINHA de `carteiraProcesso` fica (estágio e datas são métrica do
         escritório, e o texto livre dela já foi limpo acima): sem liberação ela
         é inalcançável, e apagá-la destruiria o funil histórico de quem
         trabalhou o caso de boa-fé. O que morre é o ACESSO, que é o que a lei
         pede. E o processo não volta: `PROCESSO_DISTRIBUIVEL`, no serviço de
         distribuição, passou a recusar quem tem parte com `exclusaoEm`. */
      /* ── O RECORTE DO CONTRATO ASSINADO ──
         Revogar TODAS as liberações seria coerente com "sai de circulação", e
         mesmo assim está errado num caso: o escritório que tem proposta ACEITA
         para este processo assinou um contrato COM ESTA PESSOA. Ela não é
         estranha a ele — escolheu-o. Tirar o processo da carteira dele
         esconderia um acordo em execução, com parcelas a pagar, e este mesmo
         serviço preserva a proposta ACEITA e as parcelas dela logo abaixo,
         justamente por serem fato jurídico. Revogar o acesso e guardar o
         contrato seria guardar prova de algo que ninguém mais consegue ver.

         O pedido de exclusão é contra o tratamento que a pessoa NÃO escolheu —
         a distribuição a escritórios novos —, não contra o contrato que ela
         assinou. Rescindir é assunto dela com o escritório, não nosso.

         SQL cru porque a condição é por PAR (organização, processo), e
         `deleteMany` não expressa "exceto estes pares" sem montar um OR
         gigante. `status::text` evita depender do nome do tipo enum. */
      const liberacoesRevogadas = await tx.$executeRaw`
        DELETE FROM processos_liberados l
         WHERE l."processoId" = ANY(${processoIds}::uuid[])
           AND NOT EXISTS (
                 SELECT 1 FROM propostas_negociacao pn
                  WHERE pn."processoId" = l."processoId"
                    AND pn."organizationId" = l."organizationId"
                    AND pn.status::text = 'ACEITA'
               )`;

      /* ── A PLANILHA CRUA, QUE A EXCLUSÃO NÃO ALCANÇAVA ──
         `ImportacaoLinha.dadosBrutos` guarda a LINHA INTEIRA como veio do
         tribunal: nome, CPF, valor, natureza e toda coluna que a planilha
         trouxer. É a mesma "exclusão de fachada" que este serviço combate ao
         anular o payload do provedor — só que ninguém tinha olhado para cá. Sem
         isto, respondíamos ao titular com a contagem do que saiu enquanto uma
         cópia íntegra continuava no banco, com o CPF dele indexado.

         SQL cru por dois motivos: `dadosBrutos` é JSONB NOT NULL (não aceita
         nulo, então vai para objeto vazio — "existiu uma linha aqui, o conteúdo
         não está mais"), e o alcance precisa do OR com o `cpf` da coluna. Linha
         que falhou na conciliação tem `pessoaId` nulo e o CPF lá dentro: filtrar
         só por `pessoaId` deixaria justamente as linhas com defeito de fora.

         `mensagemErro` vai junto porque erro de parsing ecoa o conteúdo da
         célula — é por onde o nome volta depois de tudo. */
      const linhasDePlanilha = await tx.$executeRaw`
        UPDATE importacao_linhas
           SET "dadosBrutos" = '{}'::jsonb, cpf = NULL, "mensagemErro" = NULL
         WHERE ("pessoaId" = ${pessoa.id}::uuid OR cpf = ${cpf})`;

      /* ── AS PROPOSTAS ──
         Aqui o tratamento é diferente por ESTADO, e a diferença é jurídica:

         ACEITA é contrato executado — registro contábil e prova do que o próprio
         titular assinou. Fica inteira; apagá-la destruiria a evidência de um
         acordo que ele fez.

         RECUSADA é oferta que ninguém assinou. A LINHA fica (para a contagem de
         "quantas propostas até um sim" continuar existindo), mas os VALORES vão
         embora: preservá-los deixaria para sempre "quanto oferecemos a esta
         pessoa e quanto o precatório dela valia" — exatamente o dado que o
         projeto criou uma trava de carga de módulo para impedir na timeline.

         Rascunho, substituída e cancelada são apagadas: nenhuma delas é fato
         jurídico, e o que resta ali é só número sobre uma pessoa.

         (A decisão do dono de a proposta ser por PROCESSO, e não por titular,
         aparece aqui: num processo com mais de um titular, o pedido de um
         alcança a negociação inteira.) */
      const [propostasApagadas, propostasLimpas] = await Promise.all([
        tx.propostaNegociacao.deleteMany(
          /* Genérico explícito: sem ele o TypeScript alarga
             `['RASCUNHO', ...]` para `string[]` e o enum do Prisma recusa. O
             tipo do argumento é o contexto que a chamada direta dava de graça. */
          escopoGlobal<Prisma.PropostaNegociacaoDeleteManyArgs>(PEDIDO_E_DA_PESSOA, {
            where: {
              processoId: { in: processoIds },
              status: { in: ['RASCUNHO', 'SUBSTITUIDA', 'CANCELADA'] },
            },
          }),
        ),
        tx.propostaNegociacao.updateMany(
          escopoGlobal(PEDIDO_E_DA_PESSOA, {
            where: { processoId: { in: processoIds }, status: 'RECUSADA' },
            data: {
              valorProposto: null,
              honorarioPercentual: null,
              baseValor: null,
              custasEstimadas: null,
              observacao: null,
            },
          }),
        ),
      ]);

      /* ── AS PARCELAS DAS PROPOSTAS QUE NÃO VIRARAM CONTRATO ──
         As de rascunho, substituída e cancelada já somem por CASCADE, junto com
         a proposta. Mas a RECUSADA fica — a linha é preservada para a contagem
         de "quantas propostas até um sim" continuar existindo — e as parcelas
         dela sobreviveriam COM OS VALORES, contradizendo a regra que acabou de
         zerar os valores da própria proposta. Um cronograma de pagamento a uma
         pessoa que recusou a oferta é exatamente o dado que ela pediu para
         apagar.
         Só as da ACEITA ficam: contrato executado, com pagamentos que
         aconteceram de verdade. */
      const parcelasApagadas = await tx.parcelaCessao.deleteMany(
        /* Genérico explícito, mesmo motivo do bloco acima: `status: { not: ... }`
           alargaria para `string` sem o tipo do argumento por contexto. */
        escopoGlobal<Prisma.ParcelaCessaoDeleteManyArgs>(PEDIDO_E_DA_PESSOA, {
          where: {
            processoId: { in: processoIds },
            proposta: { status: { not: 'ACEITA' } },
          },
        }),
      );

      /* A observação das que SOBRARAM (aceitas e enviadas) some do mesmo jeito:
         é texto livre, e texto livre é onde cabe qualquer coisa. */
      const observacoesDeProposta = await tx.propostaNegociacao.updateMany(
        escopoGlobal(PEDIDO_E_DA_PESSOA, {
          where: { processoId: { in: processoIds }, observacao: { not: null } },
          data: { observacao: null },
        }),
      );

      await tx.pessoa.update({
        where: { id: pessoa.id },
        data: {
          statusEnriquecimento: 'EXCLUIDO',
          exclusaoEm: agora,
          exclusaoMotivo: motivo,
          /* Derivados do enriquecimento: saem junto. Nome e CPF ficam — vêm do
             precatório, que é público. */
          dataNascimento: null,
          nomeMae: null,
          situacaoCadastral: null,
          obito: false,
          ultimaSincronizacao: null,
        },
      });

      return {
        telefones: tel.count,
        emails: mail.count,
        enderecos: end.count,
        respostasDoProvedor: brutos.count,
        /* Contados separadamente porque respondem a perguntas diferentes: os de
           cima provam que o dado do PROVEDOR saiu; estes, que o texto que a
           EQUIPE escreveu saiu junto. */
        observacoesDaParte: observacoesDaParte.count,
        observacoesDeContato: contatos.count,
        anotacoes: anotacoes.count,
        tarefasAnonimizadas: tarefas.count,
        motivosDePerda: motivos.count,
        /* Quantas carteiras deixaram de ver o processo. É o número que responde
           "vocês pararam de me distribuir?" — a pergunta que o titular faz. */
        liberacoesRevogadas,
        /* Linhas de planilha cujo conteúdo cru foi descartado. É a contagem que
           prova que a exclusão alcançou a cópia integral da importação. */
        linhasDePlanilha,
        propostasApagadas: propostasApagadas.count,
        propostasComValoresLimpos: propostasLimpas.count,
        observacoesDeProposta: observacoesDeProposta.count,
        parcelasApagadas: parcelasApagadas.count,
      };
    });

    /* Pelo ID da pessoa, nunca pelo CPF — o log é o lugar de onde o dado não
       sai mais (ver `mascarar-documento.ts`, no B2). Quem precisar ligar este
       id ao titular consulta o banco, que é apagável. */
    this.logger.log(
      `Exclusão LGPD atendida (pessoa ${pessoa.id}) por ${autorId}: ` +
        `${r.telefones} telefones, ${r.emails} e-mails, ${r.enderecos} endereços, ` +
        `${r.respostasDoProvedor} respostas do provedor apagadas; ` +
        `no CRM, ${r.anotacoes} anotações removidas e ` +
        `${r.observacoesDaParte + r.observacoesDeContato + r.tarefasAnonimizadas + r.motivosDePerda} ` +
        `campos de texto livre limpos.`,
    );

    return {
      cpfMascarado: this.mascarar(cpf),
      jaEstavaExcluido: false,
      exclusaoEm: agora,
      apagados: r,
    };
  }

  /** `390.***.***-05` — confirma o titular certo sem repetir o CPF inteiro. */
  private mascarar(cpf: string): string {
    return `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}`;
  }
}
