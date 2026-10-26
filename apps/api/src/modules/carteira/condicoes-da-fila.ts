import {
  Prisma,
  type ConferenciaNome,
  type EsferaTribunal,
  type EstagioCrm,
  type FaseProcesso,
  type PrioridadeProcesso,
} from '@miner/database';
import {
  ehEscopoCliente,
  escopoProcessos,
  type EscopoUsuario,
} from '../../common/escopo-processos';

/**
 * A MONTAGEM DO `where` DA FILA — um código só, duas rotas.
 *
 * ── POR QUE ISTO SAIU DO SERVICE ──
 *
 * A fila lista e o funil conta. Se cada um montasse o seu filtro, bastaria um
 * ajuste num deles para o chip dizer "Proposta 7" sobre uma lista de 3 — e o
 * cliente que vê isso não reporta um bug, conclui que o sistema mente. Já
 * aconteceu uma vez neste projeto por outro caminho (o funil dizia 500 e a fila,
 * 183), e a correção de lá foi a mesma ideia: um recorte só.
 *
 * Aqui os dois números nascem da MESMA função. Não há como divergirem sem que
 * alguém mude esta linha, e mudá-la muda os dois juntos.
 */

/** Os filtros que a fila e o funil aceitam — a mesma lista, de propósito. */
export interface FiltrosDaFila {
  termo?: string;
  estagio?: EstagioCrm;
  prioridade?: PrioridadeProcesso;
  /** UUID, ou `nenhum` para os que não têm responsável. */
  responsavelId?: string;
  etiquetaId?: string;
  /** Nunca recebeu UMA tentativa de contato. */
  semContato?: boolean;
  /** Esfriou: o último contato foi há mais de N dias. Diferente de `semContato`. */
  frioDias?: number;
  tarefaAtrasada?: boolean;
  /**
   * Recorte por ESTÁGIO do crédito.
   *
   * É o que sustenta o módulo de pré-precatórios: a mesma fila, a mesma
   * montagem de condições, o mesmo CRM — só que olhando as fases anteriores ao
   * precatório expedido. Uma tela separada com consulta própria divergiria da
   * fila na primeira mudança de filtro, que é a lição que este arquivo carrega
   * ("chip e lista que nascem de códigos diferentes divergem no primeiro
   * ajuste").
   */
  fases?: FaseProcesso[];
  /**
   * ── OS TRÊS CHIPS DO MÓDULO DE PRÉ-PRECATÓRIOS ──
   *
   * `fase` é UMA fase, clicada; `fases` (acima) é o recorte do módulo, fixado
   * pela rota. Entram os dois no mesmo AND: clicar numa fase fora do módulo
   * devolve vazio, e não a carteira inteira — que é o comportamento honesto.
   *
   * `conferencia` olha QUALQUER parte do processo (`some`), e o resumo conta do
   * mesmo jeito. Num processo com dois titulares em vereditos diferentes, ele
   * entra nos dois chips; a linha mostra o primeiro. É raro e é o preço de não
   * ter de escolher "o pior veredito" aqui.
   */
  fase?: FaseProcesso;
  esfera?: EsferaTribunal;
  conferencia?: ConferenciaNome;
  /**
   * ── O MÓDULO DE PRÉ-PRECATÓRIOS ESCONDE O QUE SAIU DO SORTEIO ──
   *
   * Decisão do dono em 03/10/2026: os 1.050 processos cujo devedor não é a
   * Fazenda (`foraDaDistribuicao`) saem também da lista e do resumo do módulo —
   * eram eles que inflavam o cartão "Valor estimado" (um só tinha R$ 4,4 bi de
   * palpite sobre um crédito de R$ 10 mil). Ficam na base e continuam achados
   * pela busca e pela página do processo.
   *
   * Vale só para a operação INTERNA: o cliente que já recebeu um deles continua
   * vendo — a trava não é retroativa, e sumir com o que foi entregue seria tirar
   * do assinante algo que ele já tem. Fixado pela ROTA, nunca pela query string.
   */
  semForaDaDistribuicao?: boolean;
}

/**
 * Filtro sobre o OVERLAY, tratando a linha AUSENTE como o padrão.
 *
 * ── A ARMADILHA QUE ISTO EXISTE PARA FECHAR ──
 *
 * Processo liberado que ninguém tocou NÃO TEM linha em `CarteiraProcesso`. Ele
 * é NOVO, de prioridade NORMAL, sem responsável e sem contato — mas por
 * AUSÊNCIA, não por valor gravado. Um `some: { estagio: 'NOVO' }` ingênuo o
 * deixaria de fora, e o filtro "novos" da fila mostraria exatamente zero
 * resultados no começo do mês, que é quando ele importa mais.
 */
export function filtroDeOverlay(
  organizationId: string,
  predicado: Prisma.CarteiraProcessoWhereInput,
  /** O processo SEM overlay satisfaz este filtro? */
  valeParaAusente: boolean,
): Prisma.ProcessoWhereInput {
  const comLinha = { carteira: { some: { organizationId, ...predicado } } };
  return valeParaAusente
    ? { OR: [comLinha, { carteira: { none: { organizationId } } }] }
    : comLinha;
}

/** Acento fora, caixa alta: é assim que `nomeNormalizado` é gravado. */
export function normalizarNome(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * As condições da fila, prontas para entrar num `AND`.
 *
 * O LOTE entra aqui junto com o escopo do usuário: sem ele, a contagem falaria
 * da carteira inteira enquanto a lista mostra um tribunal e um exercício.
 */
export function condicoesDaFila(
  filtros: FiltrosDaFila,
  contexto: {
    usuario: EscopoUsuario;
    /** Ausente = a carteira INTEIRA. A fila sempre manda; o funil, nem sempre. */
    lote?: { tribunal: string; exercicio: number };
  },
): Prisma.ProcessoWhereInput[] {
  const { usuario, lote } = contexto;
  const org = usuario.organizationId;
  const digitos = (filtros.termo ?? '').replace(/\D/g, '');

  const condicoes: Prisma.ProcessoWhereInput[] = [
    {
      ...(lote ? { tribunal: { sigla: lote.tribunal }, exercicio: lote.exercicio } : {}),
      ...escopoProcessos(usuario),
    },
  ];

  /* Vazio NÃO significa "todas": significa que quem chamou não pediu recorte.
     Um array vazio virando `in: []` devolveria zero linhas — a tela apareceria
     vazia e ninguém saberia se é filtro ou base. */
  if (filtros.fases && filtros.fases.length > 0) {
    condicoes.push({ fase: { in: filtros.fases } });
  }
  if (filtros.fase) {
    condicoes.push({ fase: filtros.fase });
  }
  if (filtros.esfera) {
    condicoes.push({ tribunal: { esfera: filtros.esfera } });
  }
  if (filtros.conferencia) {
    condicoes.push({ partes: { some: { pessoa: { conferenciaNome: filtros.conferencia } } } });
  }
  if (filtros.semForaDaDistribuicao && !ehEscopoCliente(usuario)) {
    condicoes.push({ foraDaDistribuicao: null });
  }

  if (filtros.termo) {
    condicoes.push({
      OR: [
        { numeroPrecatorio: { contains: filtros.termo } },
        { partes: { some: { pessoa: { nomeNormalizado: { contains: normalizarNome(filtros.termo) } } } } },
        /* CPF só entra com dígitos suficientes: com dois ou três, o `contains`
           casaria com meia carteira e o resultado não ajudaria ninguém. */
        ...(digitos.length >= 6
          ? [{ partes: { some: { pessoa: { cpf: { contains: digitos } } } } }]
          : []),
      ],
    });
  }

  /* ── DE ONDE VÊM PRIORIDADE E RESPONSÁVEL ──
     Depende de quem olha, e não é detalhe: o time interno mantém os seus nas
     colunas do próprio Processo; o cliente, no overlay dele. São duas fontes
     de verdade, de propósito (ver CarteiraProcesso no schema), e ler só o
     overlay tornaria a triagem do time INVISÍVEL na fila dele.
     O ESTÁGIO e o ÚLTIMO CONTATO não têm essa dualidade — só existem no
     overlay, para os dois. */
  const ehCliente = ehEscopoCliente(usuario);

  if (filtros.estagio) {
    condicoes.push(filtroDeOverlay(org, { estagio: filtros.estagio }, filtros.estagio === 'NOVO'));
  }
  if (filtros.prioridade) {
    condicoes.push(
      ehCliente
        ? filtroDeOverlay(org, { prioridade: filtros.prioridade }, filtros.prioridade === 'NORMAL')
        : { prioridade: filtros.prioridade },
    );
  }
  if (filtros.responsavelId) {
    const semDono = filtros.responsavelId === 'nenhum';
    const alvo = semDono ? null : filtros.responsavelId;
    condicoes.push(
      ehCliente ? filtroDeOverlay(org, { responsavelId: alvo }, semDono) : { responsavelId: alvo },
    );
  }
  if (filtros.semContato) {
    condicoes.push(filtroDeOverlay(org, { ultimoContatoEm: null }, true));
  }

  /* ── "ESFRIOU" NÃO É "NUNCA FOI TOCADO" ──
     `semContato` responde quem ninguém procurou; este responde quem foi
     procurado e parou de andar — a pergunta que decide a manhã de quem liga.
     Quem NUNCA teve contato entra também: ele está frio há mais tempo ainda, e
     deixá-lo de fora esconderia o caso pior atrás do caso menos grave. */
  if (filtros.frioDias) {
    const corte = new Date(Date.now() - filtros.frioDias * 86_400_000);
    condicoes.push(
      filtroDeOverlay(
        org,
        { OR: [{ ultimoContatoEm: null }, { ultimoContatoEm: { lt: corte } }] },
        true,
      ),
    );
    /* Fechado e perdido saem: um negócio fechado há 60 dias não está frio, está
       RESOLVIDO, e enchê-lo na lista de quem ligar faria o filtro perder a
       utilidade justamente nas carteiras mais trabalhadas. */
    condicoes.push(
      filtroDeOverlay(org, { estagio: { notIn: ['FECHADO', 'PERDIDO'] } }, true),
    );
  }

  if (filtros.etiquetaId) {
    condicoes.push({ etiquetas: { some: { etiquetaId: filtros.etiquetaId } } });
  }
  if (filtros.tarefaAtrasada) {
    const hoje = new Date();
    hoje.setUTCHours(0, 0, 0, 0);
    condicoes.push({
      /* Tarefa da PRÓPRIA organização: no multi-tenant, um processo liberado a
         dois clientes tem tarefas dos dois, e a fila de um não pode acender
         por causa do atraso do outro. */
      tarefas: { some: { organizationId: org, concluidaEm: null, prazo: { lt: hoje } } },
    });
  }

  return condicoes;
}
