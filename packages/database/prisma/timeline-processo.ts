/**
 * Motor de diff dos campos NÃO pessoais do Processo — base do EventoProcesso.
 *
 * ⚠ ARQUIVO ESPELHADO. Existem duas cópias que devem ser byte a byte idênticas:
 *     packages/database/prisma/timeline-processo.ts         (seed)
 *     apps/api/src/modules/importacao/timeline-processo.ts  (API)
 *
 * Por que duplicado em vez de importado de um lugar só: `@miner/database` publica
 * apenas o client gerado (`main: ./generated/client`) e o tsconfig da API compila
 * só `src/**`. Um import relativo atravessando os dois pacotes quebraria o
 * `nest build`. A duplicação é tolerável porque o arquivo é puro — zero imports,
 * zero dependência de Prisma — e a divergência é detectável com um `diff`.
 *
 * A garantia de LGPD NÃO depende das duas cópias estarem sincronizadas: ela é
 * imposta em runtime pela lista CAMPOS_PESSOAIS_PROIBIDOS, que existe nas duas e
 * estoura na carga do módulo se alguém acrescentar campo pessoal aos logáveis.
 *
 * ⚠ LGPD — só entra aqui campo NÃO pessoal do Processo. O log é append-only e uma
 * SolicitacaoTitular de EXCLUSÃO não conseguiria apagá-lo: um nome ou CPF gravado
 * em `camposAlterados`/`detalhe` viraria dado pessoal impossível de remover.
 */

type TipoCampo = 'texto' | 'decimal' | 'inteiro' | 'data';

interface Metadado {
  tipo: TipoCampo;
  rotulo: string;
  /**
   * `true` = o campo é comparado e corrigido, e a timeline registra QUE ele
   * mudou, mas o par de/para NÃO vai para `detalhe`. Ver `valor` abaixo.
   */
  sigiloso?: true;
}

/**
 * Campos do Processo que podem ser comparados, atualizados e logados.
 *
 * Ausentes de propósito:
 *  - `numeroPrecatorio`, `tribunalId`, `organizationId`: são a identidade e a
 *    tenancy do registro. Mudá-los não é correção de dado, é outro processo.
 *  - `fonte`: carrega o id da importação (`importacao:<uuid>`), então mudaria a
 *    cada execução e faria TODA reimportação disparar evento em TODO processo —
 *    exatamente o ruído que este desenho existe para evitar. É create-only.
 */
export const CAMPOS_LOGAVEIS = {
  numeroOriginario: { tipo: 'texto', rotulo: 'número do processo originário' },
  numeroRequisitorio: { tipo: 'texto', rotulo: 'número do requisitório' },
  /**
   * ⚠ SIGILOSOS — `vara`, `natureza` e `situacao`. O de/para nunca é gravado.
   *
   * Estes três campos vêm da CÉLULA DA PLANILHA DO TRIBUNAL. Não há enum, não há
   * validação, e o vocabulário é do TRF, não nosso. Na prática eles chegam com
   * coisas como "previdenciário", "auxílio-doença", "aposentadoria por
   * invalidez", "Vara Previdenciária", "óbito do beneficiário" — e isso é dado
   * referente à SAÚDE de uma pessoa nomeada, art. 5º, II.
   *
   * Duas consequências, e a segunda é a que fecha a questão:
   *
   *  1. `EventoProcesso` é append-only. O que entra aqui não sai — nem por
   *     pedido de exclusão do titular. Era o mesmo raciocínio que já tinha
   *     tirado o `valor` daqui embaixo.
   *  2. Toda a base de titulares roda sob LEGÍTIMO INTERESSE (art. 7º, IX), e
   *     legítimo interesse NÃO sustenta dado sensível: o art. 11 exige hipótese
   *     própria. Gravar a natureza no log não é só guardar demais — é guardar
   *     sob uma base legal que não cobre aquele dado.
   *
   * O que se perde: a timeline deixa de dizer "de alimentar para comum". O que
   * se mantém: ela continua dizendo QUE a natureza foi corrigida, com data e
   * autor, que é o que a conferência de importação precisa. A tela já desenha
   * esse caso com cadeado — é o mesmo caminho do `valor`, e não precisou de
   * uma linha de front.
   *
   * A CORREÇÃO CONTINUA SENDO APLICADA no processo: o `update` grava o valor
   * novo normalmente. O que não se registra é o histórico do que era antes.
   */
  vara: { tipo: 'texto', rotulo: 'vara', sigiloso: true },
  entidadeDevedora: { tipo: 'texto', rotulo: 'entidade devedora' },
  natureza: { tipo: 'texto', rotulo: 'natureza', sigiloso: true },
  situacao: { tipo: 'texto', rotulo: 'situação', sigiloso: true },
  /**
   * ⚠ SIGILOSO — o de/para nunca é gravado.
   *
   * `processo.valor` PARECE o total do precatório, mas é alimentado pela mesma
   * célula que alimenta `ProcessoPessoa.valorIndividual` — literalmente a mesma
   * variável, tanto no seed quanto na API. Na carteira atual há uma parte por
   * precatório, então gravar "de R$ X para R$ Y" num log append-only, preso a um
   * processo que leva a UM titular nomeado, registraria quanto uma pessoa
   * identificável tem a receber — e uma SolicitacaoTitular de EXCLUSÃO não
   * conseguiria apagar isso.
   *
   * A correção continua sendo aplicada (o ranking por entidade devedora soma
   * este campo e precisa acompanhar a planilha) e a timeline continua dizendo
   * que o valor mudou. O que não se registra é QUANTO. O nome do campo é
   * metadado do processo; a quantia é dado financeiro do titular.
   */
  valor: { tipo: 'decimal', rotulo: 'valor', sigiloso: true },
  /**
   * ⚠ SIGILOSO pela MESMA razão do `valor`, e com um agravante.
   *
   * É o valor extraído do TEXTO da publicação — palpite, nas palavras da própria
   * fonte: "pode ser honorário, custas ou valor da causa". Gravar o de/para num
   * log append-only registraria quanto uma pessoa identificável teria a receber,
   * e um pedido de exclusão não alcançaria isso. O agravante é que o número pode
   * estar errado: eternizar um palpite sobre o dinheiro de alguém é pior que
   * eternizar um valor apurado.
   *
   * A timeline continua dizendo que mudou. Não diz QUANTO.
   */
  valorIndicativo: { tipo: 'decimal', rotulo: 'valor indicativo', sigiloso: true },
  exercicio: { tipo: 'inteiro', rotulo: 'exercício' },
  dataAutuacao: { tipo: 'data', rotulo: 'data de autuação' },
} as const satisfies Record<string, Metadado>;

export type CampoLogavel = keyof typeof CAMPOS_LOGAVEIS;

/**
 * Trava de LGPD. Nomes de campos pessoais (de Pessoa, Telefone, Email, Endereco
 * e os textos livres que podem conter dado de titular). Se algum deles aparecer
 * em CAMPOS_LOGAVEIS, o módulo se recusa a carregar.
 */
const CAMPOS_PESSOAIS_PROIBIDOS: ReadonlySet<string> = new Set([
  'nome',
  'nomeNormalizado',
  'nomeMae',
  'cpf',
  'cnpj',
  'documento',
  'dataNascimento',
  'obito',
  'situacaoCadastral',
  'telefone',
  'telefones',
  'ddd',
  'numero',
  'whatsapp',
  'email',
  'emails',
  'endereco',
  'enderecos',
  'logradouro',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'cep',
  'observacoes',
  'dadosBrutos',
]);

/* Roda uma vez, na carga do módulo. Falhar aqui é o objetivo: é melhor a API não
   subir do que subir gravando dado pessoal num log que ninguém consegue apagar. */
for (const campo of Object.keys(CAMPOS_LOGAVEIS)) {
  if (CAMPOS_PESSOAIS_PROIBIDOS.has(campo)) {
    throw new Error(
      `LGPD: "${campo}" é campo pessoal e não pode entrar na timeline do processo. ` +
        'EventoProcesso é append-only — um pedido de exclusão do titular não conseguiria apagá-lo.',
    );
  }
}

/* `type` e não `interface`: este objeto vai para uma coluna Json do Prisma, e
   InputJsonValue só aceita tipos com assinatura de índice implícita — interface
   não tem, alias de objeto tem. Trocar isto por interface quebra o build. */
export type AlteracaoCampo = {
  de: string | number | null;
  para: string | number | null;
};

export interface DeltaProcesso {
  /** Nomes dos campos que mudaram — vai direto para EventoProcesso.camposAlterados. */
  campos: CampoLogavel[];
  /** Payload do `update` do Prisma: SÓ os campos que mudaram. */
  dados: Record<string, unknown>;
  /** { campo: { de, para } } — JSON-safe, vai para EventoProcesso.detalhe. */
  detalhe: Record<string, AlteracaoCampo>;
}

function ehCampoLogavel(campo: string): campo is CampoLogavel {
  return Object.prototype.hasOwnProperty.call(CAMPOS_LOGAVEIS, campo);
}

/**
 * Reduz o valor a algo comparável com `===`.
 *
 * Existe porque comparação ingênua mente em três casos que apareceriam já na
 * primeira reimportação:
 *  - Decimal do Prisma é OBJETO: `atual.valor !== 1234.56` é sempre verdadeiro,
 *    e todo processo da carteira dispararia evento em toda execução.
 *  - Date é objeto: `d1 !== d2` é verdadeiro mesmo para o mesmo instante.
 *  - "  INSS " e "INSS" são o mesmo dado vindo de planilha.
 */
function normalizar(tipo: TipoCampo, valor: unknown): string | number | null {
  if (valor === null || valor === undefined) return null;

  switch (tipo) {
    case 'texto': {
      const texto = String(valor).trim();
      return texto === '' ? null : texto;
    }
    case 'decimal': {
      /* Em CENTAVOS inteiros: @db.Decimal(15,2) só tem 2 casas, e comparar em
         inteiro elimina o ruído de ponto flutuante (0.1+0.2). String(Decimal)
         é exato — Number(Decimal) direto passaria por valueOf sem garantia. */
      const numero = Number(String(valor).trim());
      return Number.isFinite(numero) ? Math.round(numero * 100) : null;
    }
    case 'inteiro': {
      const numero = Number(String(valor).trim());
      return Number.isFinite(numero) ? Math.trunc(numero) : null;
    }
    case 'data': {
      const instante = valor instanceof Date ? valor.getTime() : new Date(String(valor)).getTime();
      return Number.isNaN(instante) ? null : instante;
    }
  }
}

/** Valor no tipo que o Prisma espera no `update`. */
function paraGravar(tipo: TipoCampo, valor: unknown): unknown {
  switch (tipo) {
    case 'texto':
      return String(valor).trim();
    case 'decimal':
      /* Arredonda para as MESMAS 2 casas em que `normalizar` compara. Sem isto,
         JS compararia 1.005 como 100 centavos e o Postgres guardaria 1.01 em
         @db.Decimal(15,2) — na releitura o diff veria 101, acharia que mudou e
         emitiria update + evento em toda execução, para sempre. */
      return Math.round(Number(String(valor).trim()) * 100) / 100;
    case 'inteiro':
      return Math.trunc(Number(String(valor).trim()));
    case 'data':
      return valor instanceof Date ? valor : new Date(String(valor));
  }
}

/** Valor normalizado de volta para algo serializável em JSONB. */
function paraJson(tipo: TipoCampo, normalizado: string | number | null): string | number | null {
  if (normalizado === null) return null;
  if (tipo === 'decimal') return (normalizado as number) / 100; // desfaz os centavos
  if (tipo === 'data') return new Date(normalizado as number).toISOString();
  return normalizado;
}

/**
 * Compara o estado atual do processo com os valores vindos da planilha e devolve
 * SÓ o que mudou. `null` quando nada mudou — e nada mudado significa nenhum
 * update e nenhum evento, que é o que faz reimportar planilha idêntica ser no-op.
 *
 * `candidatos` deve conter apenas campos que a planilha realmente trouxe.
 *
 * @throws se algum campo não estiver em CAMPOS_LOGAVEIS (trava de LGPD).
 */
export function calcularDelta(
  atual: Record<string, unknown>,
  candidatos: Partial<Record<CampoLogavel, unknown>>,
): DeltaProcesso | null {
  const campos: CampoLogavel[] = [];
  const dados: Record<string, unknown> = {};
  const detalhe: Record<string, AlteracaoCampo> = {};

  for (const campo of Object.keys(candidatos)) {
    /* Segunda trava: o compilador barra chave desconhecida em literal de objeto,
       mas o seed monta o candidato dinamicamente. Aqui não passa. */
    if (!ehCampoLogavel(campo)) {
      throw new Error(
        `LGPD: "${campo}" não está entre os campos logáveis do processo. ` +
          'Só campo NÃO pessoal pode ser diffado e escrito na timeline.',
      );
    }

    const { tipo } = CAMPOS_LOGAVEIS[campo];
    const novo = normalizar(tipo, candidatos[campo]);

    /* Vazio NÃO apaga o que já existe. A planilha do TRF5 vem com colunas
       faltando em parte das linhas; deixar o null passar transformaria uma
       reimportação parcial em exclusão em massa de entidade devedora e situação
       — perda silenciosa, sem erro e sem como reverter pelo próprio arquivo.
       O custo é não conseguir esvaziar um campo pela planilha; é o lado certo
       para errar. */
    if (novo === null) continue;

    const antigo = normalizar(tipo, atual[campo]);
    if (antigo === novo) continue;

    campos.push(campo);
    dados[campo] = paraGravar(tipo, candidatos[campo]);

    /* Campo sigiloso entra em `camposAlterados` (metadado: algo mudou) mas nunca
       em `detalhe` (a quantia em si). Ver o comentário de `valor`. */
    if (!('sigiloso' in CAMPOS_LOGAVEIS[campo])) {
      detalhe[campo] = { de: paraJson(tipo, antigo), para: paraJson(tipo, novo) };
    }
  }

  return campos.length === 0 ? null : { campos, dados, detalhe };
}

/**
 * Compara dois valores monetários em centavos inteiros.
 *
 * Vive fora de `calcularDelta` porque ProcessoPessoa.valorIndividual NÃO é campo
 * logável: é o valor devido a UMA parte, e registrar "o valor da parte mudou" num
 * log append-only apontaria para um titular. Mas a comparação tem exatamente a
 * mesma armadilha — Decimal do Prisma é objeto, e `!==` contra number é sempre
 * verdadeiro, o que reescreveria todo vínculo em toda reimportação.
 */
export function mesmoDinheiro(a: unknown, b: unknown): boolean {
  return normalizar('decimal', a) === normalizar('decimal', b);
}

/** Frase curta do evento, em pt-BR, com os rótulos legíveis dos campos. */
export function descreverDelta(delta: DeltaProcesso, origem: string): string {
  const rotulos = delta.campos.map((campo) => CAMPOS_LOGAVEIS[campo].rotulo);
  const lista =
    rotulos.length === 1
      ? rotulos[0]
      : `${rotulos.slice(0, -1).join(', ')} e ${rotulos[rotulos.length - 1]}`;
  return `${rotulos.length === 1 ? 'Campo atualizado' : 'Campos atualizados'} por ${origem}: ${lista}`;
}
