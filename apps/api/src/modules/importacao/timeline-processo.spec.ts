import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAMPOS_LOGAVEIS,
  calcularDelta,
  descreverDelta,
  mesmoDinheiro,
  type CampoLogavel,
} from './timeline-processo';

/**
 * Imita o Decimal do Prisma: um OBJETO cujo valor só aparece via toString().
 *
 * É o detalhe que torna estes testes necessários. `atual.valor !== 1234.56` é
 * sempre verdadeiro contra um objeto, então uma comparação ingênua marcaria
 * TODO processo como alterado em TODA execução — 4.188 updates e 4.188 eventos
 * por reimportação, para sempre.
 */
const decimal = (v: string) => ({ toString: () => v });

describe('timeline-processo — trava de LGPD', () => {
  /**
   * O módulo já estoura na carga se alguém puser campo pessoal em
   * CAMPOS_LOGAVEIS — se isso acontecer, este arquivo nem chega a rodar, e a
   * suíte inteira falha no import. A asserção explícita existe para que o
   * MOTIVO fique escrito onde alguém vai ler ao tentar adicionar o campo.
   */
  it('nenhum campo logável é dado pessoal', () => {
    const pessoais = [
      'nome', 'nomeNormalizado', 'nomeMae', 'cpf', 'cnpj', 'documento',
      'dataNascimento', 'obito', 'situacaoCadastral', 'telefone', 'telefones',
      'ddd', 'numero', 'whatsapp', 'email', 'emails', 'endereco', 'enderecos',
      'logradouro', 'complemento', 'bairro', 'cidade', 'uf', 'cep',
      'observacoes', 'dadosBrutos',
    ];
    for (const campo of Object.keys(CAMPOS_LOGAVEIS)) {
      expect(pessoais).not.toContain(campo);
    }
  });

  it('recusa campo fora da lista, mesmo montado dinamicamente', () => {
    /* O compilador barra chave desconhecida em literal, mas o seed monta o
       candidato em runtime. Este é o segundo portão. */
    expect(() =>
      calcularDelta({}, { nome: 'FULANO' } as Partial<Record<CampoLogavel, unknown>>),
    ).toThrow(/LGPD/);
  });

  it('a identidade e a tenancy do registro não são diffáveis', () => {
    /* Mudar numeroPrecatorio/tribunalId não é corrigir dado: é outro processo. */
    for (const campo of ['numeroPrecatorio', 'tribunalId', 'organizationId', 'fonte']) {
      expect(Object.keys(CAMPOS_LOGAVEIS)).not.toContain(campo);
    }
  });
});

describe('timeline-processo — o que NÃO conta como mudança', () => {
  it('Decimal do Prisma com o mesmo valor não é mudança', () => {
    const delta = calcularDelta({ valor: decimal('919542.51') }, { valor: 919542.51 });
    expect(delta).toBeNull();
  });

  it('Date e string do mesmo instante não são mudança', () => {
    const delta = calcularDelta(
      { dataAutuacao: new Date('2015-11-03T00:00:00.000Z') },
      { dataAutuacao: '2015-11-03T00:00:00.000Z' },
    );
    expect(delta).toBeNull();
  });

  it('espaço em volta do texto não é mudança', () => {
    expect(calcularDelta({ entidadeDevedora: 'INSS' }, { entidadeDevedora: '  INSS ' })).toBeNull();
  });

  it('inteiro como texto não é mudança', () => {
    expect(calcularDelta({ exercicio: 2027 }, { exercicio: '2027' })).toBeNull();
  });

  /**
   * A planilha do TRF5 vem com colunas faltando em parte das linhas. Deixar o
   * null passar transformaria uma reimportação parcial em exclusão em massa —
   * perda silenciosa, sem erro e sem como reverter pelo próprio arquivo.
   */
  it('vazio NÃO apaga o que já existe', () => {
    const delta = calcularDelta(
      { situacao: 'Pago', entidadeDevedora: 'INSS' },
      { situacao: null, entidadeDevedora: '   ' },
    );
    expect(delta).toBeNull();
  });
});

describe('timeline-processo — arredondamento decimal', () => {
  /**
   * O bug que este teste tranca: `normalizar` compara em centavos inteiros
   * (Math.round(n*100)) e o Postgres guarda em @db.Decimal(15,2). Se o valor
   * gravado não passasse pelo MESMO arredondamento, 1.005 seria comparado como
   * 100 centavos e gravado como 1.01 — e na releitura o diff veria 101, acharia
   * que mudou e emitiria update + evento em toda execução, para sempre.
   */
  it('grava com o mesmo arredondamento com que compara', () => {
    /* 1.005 NÃO serve de exemplo: `1.005 * 100` dá 100.4999… em ponto
       flutuante, então cai no mesmo centavo que 1.00 e não é mudança. É preciso
       um valor que de fato mude de centavo. */
    const delta = calcularDelta({ valor: decimal('1.00') }, { valor: 1.006 });
    expect(delta).not.toBeNull();
    const gravado = delta!.dados.valor as number;
    expect(gravado).toBe(1.01); // arredondado para as 2 casas do @db.Decimal(15,2)

    // E o que foi gravado é ESTÁVEL: relê e não pode acusar mudança de novo.
    const segundaPassada = calcularDelta({ valor: decimal(String(gravado)) }, { valor: 1.006 });
    expect(segundaPassada).toBeNull();
  });

  it('mesmoDinheiro compara Decimal com number sem falso positivo', () => {
    expect(mesmoDinheiro(decimal('919542.51'), 919542.51)).toBe(true);
    expect(mesmoDinheiro(decimal('919542.51'), 919542.52)).toBe(false);
    expect(mesmoDinheiro(null, null)).toBe(true);
  });
});

describe('timeline-processo — campo sigiloso', () => {
  /**
   * `processo.valor` PARECE total do precatório, mas é alimentado pela mesma
   * célula de ProcessoPessoa.valorIndividual. Com uma parte por precatório,
   * gravar "de R$ X para R$ Y" num log append-only preso a um processo que leva
   * a UM titular nomeado registraria quanto uma pessoa identificável tem a
   * receber — e um pedido de EXCLUSÃO não conseguiria apagar isso.
   */
  it('valor entra em campos e em dados, mas NUNCA em detalhe', () => {
    const delta = calcularDelta({ valor: decimal('100.00') }, { valor: 987654.32 });

    expect(delta!.campos).toContain('valor');
    expect(delta!.dados.valor).toBe(987654.32);
    expect(delta!.detalhe).not.toHaveProperty('valor');
    // E a quantia não pode vazar por nenhum outro caminho do payload.
    expect(JSON.stringify(delta!.detalhe)).not.toContain('987654');
    expect(JSON.stringify(delta!.detalhe)).not.toContain('100');
  });

  it('campo não sigiloso registra o de/para normalmente', () => {
    /* `entidadeDevedora` é o exemplo certo de campo que PODE ser registrado: é
       o ente público que deve, não diz nada sobre a pessoa. Este teste já usou
       `situacao` — que virou sigilosa, pelo motivo do caso abaixo. */
    const delta = calcularDelta({ entidadeDevedora: 'INSS' }, { entidadeDevedora: 'União' });
    expect(delta!.detalhe.entidadeDevedora).toEqual({ de: 'INSS', para: 'União' });
  });

  it('numa mudança mista, só o sigiloso fica de fora do detalhe', () => {
    const delta = calcularDelta(
      { entidadeDevedora: 'INSS', valor: decimal('1.00'), exercicio: 2026 },
      { entidadeDevedora: 'União', valor: 987654.32, exercicio: 2027 },
    );
    expect(delta!.campos.sort()).toEqual(['entidadeDevedora', 'exercicio', 'valor']);
    expect(Object.keys(delta!.detalhe).sort()).toEqual(['entidadeDevedora', 'exercicio']);
  });

  /**
   * ── R-01 DA AUDITORIA LGPD ──
   *
   * `natureza`, `vara` e `situacao` vêm da planilha do tribunal, sem enum e sem
   * validação. É por eles que "auxílio-doença", "aposentadoria por invalidez" e
   * "Vara Previdenciária" entram — dado de SAÚDE (art. 5º, II) de uma pessoa
   * nomeada, num log append-only que o pedido de exclusão não alcança. E
   * legítimo interesse, que é a base de toda a coleta sobre titulares, não
   * sustenta dado sensível (art. 11).
   *
   * O contrato que estes casos fixam: a correção CONTINUA sendo aplicada ao
   * processo (o `dados` leva o valor novo) e a timeline continua dizendo QUE
   * mudou (o campo entra em `campos`) — só o histórico do teor some.
   */
  it.each([
    ['natureza', 'alimentar', 'RPV — auxílio-doença'],
    ['vara', '1ª Vara Federal', 'Vara Previdenciária'],
    ['situacao', 'Aguardando', 'Óbito do beneficiário'],
  ])('%s: aplica a correção, registra que mudou, e NUNCA o teor', (campo, antes, depois) => {
    const delta = calcularDelta({ [campo]: antes }, { [campo]: depois })!;

    expect(delta.campos).toContain(campo);
    expect(delta.dados[campo]).toBe(depois);
    expect(delta.detalhe).not.toHaveProperty(campo);
    /* E não pode vazar por nenhum outro caminho do payload que vai para a
       coluna Json — é o log que ninguém consegue apagar depois. */
    expect(JSON.stringify(delta.detalhe)).not.toContain(depois);
    expect(JSON.stringify(delta.detalhe)).not.toContain(antes);
  });
});

describe('timeline-processo — descrição do evento', () => {
  it('usa os rótulos legíveis, não os nomes de campo', () => {
    const delta = calcularDelta({ situacao: 'A' }, { situacao: 'B' })!;
    expect(descreverDelta(delta, 'reimportação')).toBe(
      'Campo atualizado por reimportação: situação',
    );
  });

  it('concorda em número e liga o último com "e"', () => {
    const delta = calcularDelta(
      { situacao: 'A', valor: decimal('1.00'), exercicio: 2026 },
      { situacao: 'B', valor: 2, exercicio: 2027 },
    )!;
    expect(descreverDelta(delta, 'recarga')).toBe(
      'Campos atualizados por recarga: situação, valor e exercício',
    );
  });
});

/**
 * O arquivo é duplicado entre o pacote do banco (seed) e a API, porque
 * `@miner/database` publica só o client gerado e o tsconfig da API compila só
 * `src/**`. A duplicação é tolerável porque o módulo é puro — mas só enquanto
 * as duas cópias forem idênticas, e nada além deste teste garante isso.
 */
describe('timeline-processo — espelho', () => {
  it('as duas cópias são byte a byte idênticas', () => {
    const daApi = readFileSync(join(__dirname, 'timeline-processo.ts'), 'utf8');
    const doSeed = readFileSync(
      join(__dirname, '../../../../../packages/database/prisma/timeline-processo.ts'),
      'utf8',
    );
    expect(doSeed).toBe(daApi);
  });
});
