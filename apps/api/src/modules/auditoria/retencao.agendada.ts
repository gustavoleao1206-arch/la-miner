import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service';
import { escopoGlobal } from '../../prisma/sentinela-escopo';
import { cpfEmTexto } from '../cadastro/documento';

/**
 * A POLÍTICA DE RETENÇÃO, executada — e não apenas escrita na política.
 *
 * IP e user agent são dados pessoais quando associados a uma conta (é o caso
 * de todos os lugares onde o sistema os grava). Guardá-los sem prazo era uma
 * afirmação da Política de Privacidade sem código por trás. Este cron é o
 * código.
 *
 * ── OS TRÊS LUGARES, E A REGRA DE CADA UM ──
 *
 * 1. `audit_logs` (login, troca de senha, exclusão de cliente...): são os
 *    REGISTROS DE ACESSO do art. 15 do Marco Civil, que OBRIGA a guardar o IP
 *    por 6 meses para entrega mediante ordem judicial. Por isso a retenção tem
 *    PISO de 180 dias (o zod recusa menos) e o IP fica inteiro até lá. Passado
 *    o prazo, IP e user agent são ANONIMIZADOS EM LUGAR (viram nulo) e a linha
 *    do evento fica: "houve um login em tal dia" continua sendo verdade
 *    auditável sem dizer de onde.
 *
 * 2. `consultas_cliente` (quem consultou qual CPF): a trilha da LGPD. O que
 *    sustenta a prestação de contas é o USUÁRIO e o CPF consultado; o IP já
 *    nasce truncado (common/ip.ts) e some no mesmo prazo. O TEXTO digitado tem
 *    prazo PRÓPRIO e mais curto — ver `descartarTermos`, no fim do arquivo.
 *
 * 3. `refresh_tokens`: carregam IP e user agent para a tela "suas sessões".
 *    Token EXPIRADO há mais de 30 dias não serve nem à sessão nem à detecção de
 *    reuso (que só olha famílias vivas): é apagado. Os revogados-mas-válidos
 *    ficam até expirar — são eles que denunciam roubo de token.
 *
 * Idempotente por construção: roda todo dia, e o que já foi anonimizado não
 * casa mais com o WHERE.
 */
@Injectable()
export class RetencaoAgendada {
  private readonly logger = new Logger(RetencaoAgendada.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get habilitado(): boolean {
    return this.config.get<string>('RETENCAO_AGENDADA_ATIVA', 'true') === 'true';
  }

  /** Dias de vida do IP nos registros de acesso — piso legal de 180. */
  private get diasDeAcesso(): number {
    return Number(this.config.get('RETENCAO_REGISTROS_ACESSO_DIAS', 180));
  }

  /**
   * Dias de vida da LINHA CRUA DA PLANILHA importada.
   *
   * Curto de propósito, e bem mais curto que os 180 dos registros de acesso: a
   * finalidade declarada de `dadosBrutos` é "reprocessar sem o arquivo", e
   * reprocessar uma importação é operação de dias. Passado o prazo, o que
   * sobrava era uma cópia integral da planilha do tribunal — com CPF indexado —
   * guardada para o caso de um dia servir, que é a definição de excesso.
   */
  private get diasDePlanilha(): number {
    return Number(this.config.get('RETENCAO_PLANILHA_DIAS', 90));
  }

  /** Dias de vida do TEXTO digitado na busca. Ver o porquê em `env.validation`. */
  private get diasDeTermo(): number {
    return Number(this.config.get('RETENCAO_TERMO_BUSCA_DIAS', 90));
  }

  /** Todo dia às 03:30, antes dos crons de negócio. */
  @Cron(process.env.RETENCAO_CRON ?? '30 3 * * *', {
    name: 'retencao-diaria',
    timeZone: 'America/Recife',
  })
  async rodar(): Promise<void> {
    if (!this.habilitado) {
      this.logger.debug('Retenção agendada desativada (RETENCAO_AGENDADA_ATIVA != true)');
      return;
    }
    await this.executar(new Date());
  }

  /** Exposto com o relógio injetável: é assim que o teste prova o corte. */
  async executar(agora: Date) {
    const corteAcesso = new Date(agora.getTime() - this.diasDeAcesso * 86_400_000);
    const corteTokens = new Date(agora.getTime() - 30 * 86_400_000);
    const cortePlanilha = new Date(agora.getTime() - this.diasDePlanilha * 86_400_000);

    const [auditoria, consultas, tokens] = await Promise.all([
      this.prisma.auditLog.updateMany(
        /* A retenção anonimiza por PRAZO e vale para a base inteira: não há
           usuário logado no cron, e um recorte por organização deixaria o IP de
           todos os outros clientes vivo além do prazo legal. */
        escopoGlobal('cron de retencao: anonimizacao por PRAZO, sem usuario logado, em toda a base', {
          where: {
            criadoEm: { lt: corteAcesso },
            OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
          },
          data: { ip: null, userAgent: null },
        }),
      ),
      this.prisma.consultaCliente.updateMany(
        /* Mesma razão da trilha acima: prazo, não organização. */
        escopoGlobal('cron de retencao: anonimizacao por PRAZO, sem usuario logado, em toda a base', {
          where: {
            criadoEm: { lt: corteAcesso },
            OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
          },
          data: { ip: null, userAgent: null },
        }),
      ),
      this.prisma.refreshToken.deleteMany({
        where: { expiraEm: { lt: corteTokens } },
      }),
    ]);

    /* ── A PLANILHA CRUA ──
       SQL cru por três razões, e nenhuma é preferência de estilo:

        1. `dadosBrutos` é JSONB NOT NULL. Não há nulo a colocar: o conteúdo vai
           para objeto vazio — "existiu uma linha aqui, o conteúdo não está mais".
        2. O filtro "ainda não foi limpa" precisa comparar JSONB com `<> '{}'`.
           Sem ele, o UPDATE reescreveria todas as linhas antigas toda madrugada
           numa tabela que só cresce — escrita à toa e ruído no autovacuum. É a
           mesma lição do cron do dado bruto do provedor.
        3. `status <> 'PENDENTE'` é a trava de segurança, e a razão é concreta:
           o processamento lê EXATAMENTE as linhas PENDENTE (`importacao.service`
           pagina por elas). Limpar uma linha ainda não processada apagaria o
           conteúdo que o worker precisa para terminar — uma importação
           interrompida jamais se recuperaria. `::text` no lado do enum evita
           depender do nome do tipo no Postgres. */
    const linhasDePlanilha = await this.prisma.$executeRaw`
      UPDATE importacao_linhas
         SET "dadosBrutos" = '{}'::jsonb, cpf = NULL, "mensagemErro" = NULL
       WHERE "criadoEm" < ${cortePlanilha}
         AND status::text <> 'PENDENTE'
         AND ("dadosBrutos" <> '{}'::jsonb OR cpf IS NOT NULL OR "mensagemErro" IS NOT NULL)`;

    const corteTermo = new Date(agora.getTime() - this.diasDeTermo * 86_400_000);
    const termos = await this.descartarTermos(corteTermo);

    const resumo = {
      auditoriaAnonimizada: auditoria.count,
      consultasAnonimizadas: consultas.count,
      tokensApagados: tokens.count,
      linhasDePlanilha,
      termosPromovidos: termos.promovidos,
      termosDescartados: termos.descartados,
      corteAcesso: corteAcesso.toISOString().slice(0, 10),
      cortePlanilha: cortePlanilha.toISOString().slice(0, 10),
      corteTermo: corteTermo.toISOString().slice(0, 10),
    };
    /* Sempre em INFO, mesmo com zeros: a prova de que a política roda é o
       próprio registro de que rodou. */
    this.logger.log(`Retenção executada: ${JSON.stringify(resumo)}`);
    return resumo;
  }

  /**
   * O TEXTO DIGITADO NA BUSCA — o último campo desta trilha sem prazo.
   *
   * ── O QUE ELE É ──
   *
   * `consultas_cliente.termo` guarda a string CRUA. Numa busca por nome ela É um
   * nome completo; numa por endereço, um logradouro. Escapava das DUAS rotinas
   * de descarte: sobrevivia à anonimização do cliente e sobrevivia ao pedido de
   * exclusão do titular, porque nenhuma das duas alcança esta tabela.
   *
   * ── DUAS ETAPAS, E A ORDEM É O PONTO ──
   *
   * A trilha do titular (`trilhaCpf`) casa consultas por
   * `cpfConsultado = <cpf>` OU `termo contains <cpf>`. O segundo critério existe
   * para as linhas em que o CPF ficou só no texto — o gravador preenche
   * `cpfConsultado` apenas quando o digitado tem EXATAMENTE 11 dígitos, então
   * "39053344705 81" (13 dígitos) grava o CPF só no termo.
   *
   * Apagar o termo sem mais nada tiraria essas linhas da resposta ao titular:
   * uma correção de privacidade degradando um DIREITO de privacidade. Por isso o
   * CPF é PROMOVIDO para a coluna estruturada antes de o texto sair. O que se
   * perde é a redação; o fato — este usuário consultou este CPF nesta data —
   * fica, e fica melhor indexado do que estava.
   *
   * ── POR QUE `cpfValido`, E NÃO QUALQUER 11 DÍGITOS ──
   *
   * Celular com DDD tem 11 dígitos. Promover às cegas escreveria um telefone na
   * coluna de CPF e inventaria, na trilha, uma consulta que nunca houve. O
   * dígito verificador é a peneira barata: derruba 99% do que não é CPF.
   *
   * Fica um resíduo honesto: um telefone que por acaso passe no verificador, e o
   * caso de duas pessoas no mesmo termo — a coluna guarda um CPF, então o
   * segundo titular perde essa linha. Ambos são raros e nenhum inventa dado
   * sobre quem não foi consultado.
   *
   * ── DOIS TIPOS FICAM DE FORA, E NÃO É ESQUECIMENTO ──
   *
   * Em `PROCESSO` e `PROPOSTA` o termo NÃO é texto digitado: é o
   * `numeroPrecatorio`, escrito pelo próprio sistema. Não carrega nome nem
   * endereço, e sobretudo é a ÚNICA rastreabilidade quando o processo tem mais
   * de uma parte — nesse caso `cpfConsultado` fica nulo de propósito, porque
   * escolher um dos titulares registraria mentira sobre os outros, e o
   * comentário em `carteira.controller.ts` diz exatamente isso: "a
   * rastreabilidade fica pelo termo".
   *
   * Descartá-los deixaria a linha dizendo "alguém abriu algum processo" — uma
   * correção de privacidade destruindo a prestação de contas que ela existe para
   * sustentar. São também os únicos termos em que promover CPF seria arriscado
   * por outro motivo: número de processo é uma corrida longa de dígitos.
   */
  private async descartarTermos(corte: Date): Promise<{ promovidos: number; descartados: number }> {
    /* Tipos cujo `termo` é escrito pelo SISTEMA (o número do precatório), e não
       digitado por gente. Ver o bloco acima para o porquê de ficarem. */
    const ESCRITOS_PELO_SISTEMA = ['PROCESSO', 'PROPOSTA'];
    const digitados = { tipo: { notIn: ESCRITOS_PELO_SISTEMA } };
    const BLOCO = 1_000;
    let promovidos = 0;
    let cursor: string | undefined;

    /* Paginação por CURSOR, e não por `take` repetido sobre o mesmo filtro: as
       linhas em que nada foi promovido continuam casando com o WHERE, e um
       laço que reconsultasse do início nunca terminaria. */
    for (;;) {
      const lote = await this.prisma.consultaCliente.findMany(
        escopoGlobal('cron de retencao: promocao de CPF por PRAZO, em toda a base', {
          /* `tipo: 'CPF'` é a TERCEIRA trava, junto da corrida exata de 11 e do
             dígito verificador. Só promove onde o gravador já tinha julgado a
             busca como CPF — numa linha `tipo='NOME'` (menos de 6 dígitos por
             construção) não há CPF a achar, e procurar ali só criaria chance de
             errar. Sem o `...digitados` aqui: `tipo: 'CPF'` já é mais estreito
             que o `notIn`, e o espalhamento sobrescreveria esta trava. */
          where: {
            criadoEm: { lt: corte },
            cpfConsultado: null,
            termo: { not: null },
            tipo: 'CPF',
          },
          select: { id: true, termo: true },
          take: BLOCO,
          /* `as const` obrigatório: `escopoGlobal` é genérico, e sem ele o
             literal 'asc' alarga para `string`, que não é `SortOrder`. Mesma
             armadilha já documentada no sentinela para os literais de enum. */
          orderBy: { id: 'asc' as const },
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );
      if (lote.length === 0) break;
      cursor = lote[lote.length - 1].id;

      for (const linha of lote) {
        const cpf = cpfEmTexto(linha.termo ?? '');
        if (!cpf) continue;
        /* Ancorada no `id`: a sentinela de escopo isenta, e com razão — não há
           base inteira a varrer, é uma linha nomeada. */
        await this.prisma.consultaCliente.update({
          where: { id: linha.id },
          data: { cpfConsultado: cpf },
        });
        promovidos++;
      }
    }

    const r = await this.prisma.consultaCliente.updateMany(
      escopoGlobal('cron de retencao: descarte do termo por PRAZO, em toda a base', {
        /* `termo: { not: null }` é o "ainda não foi limpo": sem ele o UPDATE
           reescreveria todas as linhas antigas toda madrugada, numa tabela que
           só cresce. Mesma lição da linha crua da planilha, logo acima. */
        where: { criadoEm: { lt: corte }, termo: { not: null }, ...digitados },
        data: { termo: null },
      }),
    );

    return { promovidos, descartados: r.count };
  }
}
