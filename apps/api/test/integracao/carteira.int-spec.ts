import { BadRequestException } from '@nestjs/common';
import { CarteiraService } from '../../src/modules/carteira/carteira.service';
import { CrmService } from '../../src/modules/crm/crm.service';
import { ImportacaoService } from '../../src/modules/importacao/importacao.service';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearProcesso,
  semearCliente,
  liberarProcesso,
  encerrar,
} from './ambiente';

const carteira = new CarteiraService(prisma as never);

/**
 * Escopo de leitura de quem é DONO da base (o time interno).
 *
 * Os serviços de leitura passaram a pedir "quem está olhando" em vez de um
 * organizationId solto: é o que deixa a MESMA função servir o dono e o assinante
 * sem que nenhuma chamada consiga esquecer o recorte.
 */
const interno = (organizationId: string) => ({
  tipo: 'INTERNA' as const,
  organizationId,
  papel: 'ADMIN' as const,
});

/**
 * Duplo do FilaService — evita Redis e REGISTRA o que recebeu.
 *
 * Devolve a mesma forma que o real (`{ enfileirados }`), porque a importação
 * agora reporta o número que a fila devolve, não uma contagem própria. O duplo
 * anterior devolvia `undefined` sob o comentário "a fila nunca é acionada
 * nestes testes" — ela era, e ele engolia a chamada calado.
 *
 * De propósito NÃO deduplica, ao contrário do `enfileirarLote` real: assim uma
 * regressão na importação aparece aqui, em vez de ficar escondida atrás da
 * deduplicação da fila.
 */
const lotesEnfileirados: { pessoaId: string }[][] = [];
/** Importações que a requisição mandou para o worker. */
const importacoesEnfileiradas: string[] = [];
const filaFalsa = {
  enfileirarLote: async (itens: { pessoaId: string }[]) => {
    lotesEnfileirados.push(itens);
    return { enfileirados: itens.length };
  },
  /* Registra e NÃO executa: quem dispara o processamento nestes testes é o
     helper abaixo, chamando o mesmo método que o processor chamaria. Executar
     aqui esconderia a divisão em duas metades justamente onde ela precisa
     aparecer. */
  enfileirarImportacao: async (importacaoId: string) => {
    importacoesEnfileiradas.push(importacaoId);
    return { id: `job:${importacaoId}` };
  },
};
const importacao = new ImportacaoService(prisma as never, filaFalsa as never);

/**
 * Importa E processa — o que antes era uma chamada só.
 *
 * Desde o B5 a rota apenas ENFILEIRA: valida, grava as linhas cruas em PENDENTE
 * e devolve um id; o trabalho acontece no worker. Este helper chama as duas
 * metades em sequência, e de propósito não usa um duplo do worker — é o MESMO
 * `processarImportacao` que o processor executa em produção. Assim a divisão
 * fica coberta em vez de contornada.
 *
 * Devolve a mesma FORMA que a resposta síncrona antiga tinha, agora lida do
 * banco. É o que permitiu manter intactas as asserções dos testes que já
 * existiam: o que mudou foi onde o trabalho roda, não o que ele produz.
 */
/**
 * O id do recibo.
 *
 * A rota devolve uma união — simulação OU recibo —, e o `in` não estreita essa
 * união aqui (as duas formas viram um objeto só, de propriedades opcionais).
 * Extrair num lugar só evita repetir o contorno em cada teste.
 */
function idDoRecibo(r: Awaited<ReturnType<ImportacaoService['importar']>>): string {
  const id = 'importacaoId' in r ? r.importacaoId : undefined;
  if (!id) throw new Error('esperava o recibo da importação, não a simulação');
  return id;
}

async function importarEProcessar(params: Parameters<ImportacaoService['importar']>[0]) {
  const recebida = await importacao.importar({ ...params, dryRun: false });
  const importacaoId = idDoRecibo(recebida);

  expect(importacoesEnfileiradas).toContain(importacaoId);
  await importacao.processarImportacao(importacaoId);

  const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: importacaoId } });
  return {
    importacaoId: imp.id,
    status: imp.status,
    totalLinhas: imp.totalLinhas,
    processadas: imp.processadas,
    sucesso: imp.sucesso,
    falhas: imp.falhas,
    ignoradas: imp.ignoradas,
    enfileirados: imp.enfileirados,
    processos: {
      criados: imp.processosCriados,
      atualizados: imp.processosAtualizados,
      inalterados: imp.processosInalterados,
    },
  };
}

/** CPF sintético com dígito verificador válido — o serviço valida e descarta o resto. */
function cpfValido(seq: number): string {
  const b = String(seq).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (n: number[], peso: number) =>
    ((n.reduce((s, x, i) => s + x * (peso - i), 0) * 10) % 11) % 10;
  const d1 = dv(b, 10);
  return b.join('') + d1 + dv([...b, d1], 11);
}

/**
 * CSV mínimo com números CNJ do tribunal pedido (`trDigito` = "01".."06").
 *
 * `sufixo` muda os BYTES do arquivo sem mudar o que o parser lê — linhas em
 * branco caem no `skipEmptyLines: 'greedy'`. É como se simula a planilha
 * corrigida que o operador reenvia: hash diferente, conteúdo igual. Sem isso, o
 * reenvio bate na proteção de arquivo duplicado e nunca chega ao diff.
 */
function planilha(trDigito: string, linhas = 12, sufixo = '') {
  let csv = 'CPF,Nome,Processo\n';
  for (let i = 1; i <= linhas; i++) {
    csv += `${cpfValido(900000000 + i)},FULANO ${i},010000${i}-11.2026.4.${trDigito}.0000\n`;
  }
  csv += sufixo;
  return {
    buffer: Buffer.from(csv, 'utf8'),
    originalname: `teste-trf${Number(trDigito)}.csv`,
  } as Express.Multer.File;
}

/**
 * Planilha com UM titular em três precatórios e outro em um só.
 *
 * 4 linhas, 4 processos, 2 pessoas — a forma exata da carteira real, onde 149
 * titulares aparecem em mais de um precatório. É o que separa "contar linhas"
 * de "contar pessoas" no enfileiramento.
 */
function planilhaTitularRepetido(sufixo = '') {
  const repetido = cpfValido(900000001);
  let csv = 'CPF,Nome,Processo\n';
  for (let i = 1; i <= 3; i++) {
    csv += `${repetido},FULANO REPETIDO,010000${i}-11.2026.4.05.0000\n`;
  }
  csv += `${cpfValido(900000002)},BELTRANO UNICO,0100009-11.2026.4.05.0000\n`;
  /* Mesmo papel do `sufixo` acima: muda os bytes sem mudar o conteúdo, para o
     reenvio passar pelo hash e chegar ao que o teste quer medir. */
  csv += sufixo;
  return {
    buffer: Buffer.from(csv, 'utf8'),
    originalname: 'titular-repetido.csv',
  } as Express.Multer.File;
}

describe('Carteira — o lote é o recorte de tudo', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * O conceito de lote nasceu de um estrago real: um `teste-import.csv` somou
   * R$ 25.000,49 fictícios ao número que ia para o cliente, porque os agregados
   * varriam a tabela inteira. Estes testes trancam o recorte.
   */
  it('resumo conta só o lote pedido', async () => {
    const { org } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2028 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF1', exercicio: 2027 });

    const eu = interno(org.id);
    expect((await carteira.resumo({ usuario: eu, lote: { tribunal: 'TRF5', exercicio: 2027 } })).processos).toBe(1);
    expect((await carteira.resumo({ usuario: eu, lote: { tribunal: 'TRF5', exercicio: 2028 } })).processos).toBe(1);
    expect((await carteira.resumo({ usuario: eu, lote: { tribunal: 'TRF1', exercicio: 2027 } })).processos).toBe(1);
    expect((await carteira.resumo({ usuario: eu, lote: { tribunal: 'TRF3', exercicio: 2027 } })).processos).toBe(0);
  });

  it('o resumo ecoa o lote que recebeu — o rótulo da tela não pode mentir', async () => {
    const { org } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, sigla: 'TRF1', exercicio: 2028 });

    const r = await carteira.resumo({
      usuario: interno(org.id),
      lote: { tribunal: 'TRF1', exercicio: 2028 },
    });
    expect(r.lote).toEqual({ tribunal: 'TRF1', exercicio: 2028 });
  });

  it('o painel de BI respeita o mesmo recorte', async () => {
    const { org } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });

    const noLote = await carteira.painel({
      usuario: interno(org.id),
      lote: { tribunal: 'TRF5', exercicio: 2027 },
    });
    const foraDoLote = await carteira.painel({
      usuario: interno(org.id),
      lote: { tribunal: 'TRF2', exercicio: 2027 },
    });

    expect(noLote.operacao.porPrioridade.reduce((s, p) => s + p.quantidade, 0)).toBe(1);
    expect(foraDoLote.operacao.porPrioridade.reduce((s, p) => s + p.quantidade, 0)).toBe(0);
  });

  it('o detalhe de processo não vaza entre organizações', async () => {
    const a = await semearOrganizacao('A');
    const b = await semearOrganizacao('B');
    const doA = await semearProcesso({ organizationId: a.org.id });

    expect(await carteira.processo(doA.id, interno(a.org.id))).not.toBeNull();
    /* Mesmo retorno de "não existe": o 404 não pode confirmar a existência do
       id alheio para quem estiver sondando. */
    expect(await carteira.processo(doA.id, interno(b.org.id))).toBeNull();
  });
});

/**
 * O pivô do SaaS: PROPRIEDADE (a org interna é dona da base) deixou de ser a
 * mesma coisa que VISIBILIDADE (o cliente vê só o que lhe foi liberado). Estes
 * testes trancam essa separação — um bug aqui vaza dado pessoal entre clientes.
 */
describe('Carteira — o cliente vê só o que foi liberado', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

  /** Pessoa vinculada a um processo — a busca procura PESSOAS, não processos. */
  async function vincular(processoId: string, seq: number, nome: string) {
    const pessoa = await prisma.pessoa.create({
      data: { cpf: cpfValido(seq), nome, nomeNormalizado: nome },
      select: { id: true, cpf: true },
    });
    await prisma.processoPessoa.create({ data: { processoId, pessoaId: pessoa.id } });
    return pessoa;
  }

  /**
   * O coração da Fase B: saber o UUID não basta. Antes da liberação o processo
   * não existe para o cliente — e some com o MESMO `null` de "não existe", para
   * o 404 não confirmar a existência do id a quem estiver sondando.
   */
  it('processo não liberado não existe para o cliente; liberado, abre', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const p = await semearProcesso({ organizationId: org.id });

    expect(await carteira.processo(p.id, c.escopo)).toBeNull();

    await liberarProcesso(c.org.id, p.id);
    expect(await carteira.processo(p.id, c.escopo)).not.toBeNull();
  });

  it('o painel do cliente conta a carteira DELE, não a do dono', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const p1 = await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });
    await liberarProcesso(c.org.id, p1.id);

    const total = (r: { operacao: { porPrioridade: { quantidade: number }[] } }) =>
      r.operacao.porPrioridade.reduce((s, x) => s + x.quantidade, 0);

    const doDono = await carteira.painel({ usuario: interno(org.id), lote: LOTE });
    const doCliente = await carteira.painel({ usuario: c.escopo, lote: LOTE });

    expect(total(doDono)).toBe(3);
    expect(total(doCliente)).toBe(1);

    /* O painel do cliente tem DOIS caminhos de escopo, e é preciso cobrir os
       dois: `porPrioridade` vem do raw, que carrega o próprio JOIN em
       processos_liberados; já `processosSemResponsavel` conta pelo `doLote`, ou
       seja, PELO escopoProcessos. Sem esta segunda asserção, quebrar o
       escopoProcessos não faria este teste piscar — foi o que a mutação mostrou. */
    expect(doCliente.operacao.processosSemResponsavel).toBe(1);
    expect(doDono.operacao.processosSemResponsavel).toBe(3);
  });

  it('a busca do cliente não alcança quem não foi liberado', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const liberado = await semearProcesso({ organizationId: org.id });
    const escondido = await semearProcesso({ organizationId: org.id });
    await vincular(liberado.id, 900000101, 'ANA LIBERADA');
    await vincular(escondido.id, 900000102, 'BRUNO ESCONDIDO');
    await liberarProcesso(c.org.id, liberado.id);

    const doDono = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: interno(org.id),
    });
    const doCliente = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: c.escopo,
    });

    expect(doDono.total).toBe(2);
    expect(doCliente.total).toBe(1);
    expect(doCliente.itens.map((i) => i.nome)).toEqual(['ANA LIBERADA']);
  });

  /**
   * "Para ele, o sistema parecerá possuir uma base própria de inteligência."
   * Isso não é só esconder menu: o vocabulário do enriquecimento não pode sair
   * na API, ou o cliente descobre a engrenagem pelo JSON.
   */
  it('a projeção do cliente não expõe o vocabulário do enriquecimento', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const p = await semearProcesso({ organizationId: org.id });
    await vincular(p.id, 900000103, 'CARLA TESTE');
    await liberarProcesso(c.org.id, p.id);

    const doCliente = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: c.escopo,
    });
    const doDono = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: interno(org.id),
    });

    expect(doCliente.itens[0]).not.toHaveProperty('statusEnriquecimento');
    expect(doCliente.itens[0]).not.toHaveProperty('ultimaSincronizacao');
    /* O dono continua vendo — para ele é métrica de operação. */
    expect(doDono.itens[0]).toHaveProperty('statusEnriquecimento');
  });

  /**
   * A CONSULTA ERA A ÚNICA PROJEÇÃO SEM A FASE — e a mais perigosa das três.
   *
   * A fila e o funil já levavam `fase` e `valorIndicativo`; a busca por CPF não.
   * E ela é a porta de entrada: o caminho mais curto entre o advogado e um nome.
   * Sem a fase no JSON, o `SeloFase` não tem o que renderizar e um
   * pré-precatório sai idêntico a um precatório na fila orçamentária — mesma
   * linha, mesmo formato, nenhum sinal.
   *
   * A landing vende "250 precatórios por mês". Entregar crédito ainda não
   * exigível sem dizer qual é qual é o terreno do art. 37, §1º do CDC, e o
   * comprador é advogado — ele percebe.
   *
   * Vale para os DOIS lados: o cliente é justamente quem decide a abordagem por
   * esta tela.
   */
  it('⚠ a busca devolve a FASE de cada processo — ao dono e ao cliente', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const pre = await semearProcesso({ organizationId: org.id, fase: 'CALCULOS_HOMOLOGADOS' });
    await vincular(pre.id, 900000121, 'DORA PRE-PRECATORIO');
    await liberarProcesso(c.org.id, pre.id);

    const doDono = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: interno(org.id),
    });
    const doCliente = await carteira.buscar({
      pagina: 1, porPagina: 20, lote: LOTE, usuario: c.escopo,
    });

    expect(doDono.itens[0].processos[0].processo.fase).toBe('CALCULOS_HOMOLOGADOS');
    expect(doCliente.itens[0].processos[0].processo.fase).toBe('CALCULOS_HOMOLOGADOS');

    /* `valorIndicativo` viaja junto e como STRING: é Decimal no banco, e um
       Decimal serializado como número perde precisão sem avisar. */
    expect(doCliente.itens[0].processos[0].processo).toHaveProperty('valorIndicativo');
  });

  /**
   * O RESUMO DIZ DE QUE ESTÁGIO SÃO OS PROCESSOS QUE CONTA.
   *
   * ── O QUE ESTES CASOS TRANCAM ──
   *
   * Nenhuma contagem deste serviço olhava `fase`. Enquanto a base era 100%
   * `PRECATORIO_EXPEDIDO` isso não custava nada: "N processos" e "N precatórios"
   * diziam a mesma coisa, e o dashboard usava a segunda palavra.
   *
   * Com 1.169 pré-precatórios entrando — e entrando também no sorteio dos 250 —
   * o KPI passou a somar crédito SEM exigibilidade formada sob um rótulo que a
   * afirma. O tratamento por ITEM já estava certo (o `SeloFase` na linha); era o
   * AGREGADO que continuava cego.
   *
   * ── E O NÚMERO NÃO ENCOLHE ──
   *
   * A correção não tira o pré-precatório da conta: o cliente o recebeu e pagou
   * por ele, e escondê-lo subestimaria a carteira dele. O que muda é que a
   * composição passa a viajar junto, para a tela poder dizer a diferença.
   */
  it('⚠ o resumo do CLIENTE devolve a carteira quebrada por estágio', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const exigivel = await semearProcesso({ organizationId: org.id });
    /* O que faz dele um pré-precatório: fase anterior, sem valor apurado e SEM
       exercício — é o exercício nulo que o mantém fora de qualquer lote. */
    const pre = await semearProcesso({
      organizationId: org.id,
      fase: 'CALCULOS_HOMOLOGADOS',
      exercicio: null,
      valor: null,
    });
    await vincular(exigivel.id, 900000131, 'ANA EXIGIVEL');
    await vincular(pre.id, 900000132, 'BRUNO ANTERIOR');
    await liberarProcesso(c.org.id, exigivel.id);
    await liberarProcesso(c.org.id, pre.id);

    const r = await carteira.resumo({ usuario: c.escopo });

    expect(r.processos).toBe(2);
    expect(r.porFase).toEqual(
      expect.arrayContaining([
        { fase: 'PRECATORIO_EXPEDIDO', quantidade: 1 },
        { fase: 'CALCULOS_HOMOLOGADOS', quantidade: 1 },
      ]),
    );
  });

  it('a soma em dinheiro continua ignorando o pré-precatório — e isso está certo', async () => {
    /**
     * O par que explica por que o rótulo precisava mudar: a CONTAGEM sobe com o
     * pré-precatório e a SOMA não, porque `valorIndividual` é nulo nele. Os dois
     * números descrevem conjuntos diferentes, e chamá-los de "N precatórios
     * totalizando R$ X" sugeria que um cobre o outro.
     *
     * `valorTotal` está correto e não deve ser mexido: somar `valorIndicativo` —
     * que a própria fonte chama de palpite extraído de texto — poria número
     * inventado no dinheiro do cliente.
     */
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const exigivel = await semearProcesso({ organizationId: org.id });
    const pre = await semearProcesso({
      organizationId: org.id,
      fase: 'TRANSITO_EM_JULGADO',
      exercicio: null,
      valor: null,
    });
    const carla = await vincular(exigivel.id, 900000133, 'CARLA EXIGIVEL');
    /* `vincular` cria o vínculo sem valor; aqui o valor importa, porque é ele
       que mostra a soma ignorando o pré-precatório. */
    await prisma.processoPessoa.updateMany({
      where: { processoId: exigivel.id, pessoaId: carla.id },
      data: { valorIndividual: 5000 },
    });
    await vincular(pre.id, 900000134, 'DENIS ANTERIOR');
    await liberarProcesso(c.org.id, exigivel.id);
    await liberarProcesso(c.org.id, pre.id);

    const r = await carteira.resumo({ usuario: c.escopo });

    expect(r.processos).toBe(2);
    expect(Number(r.valorTotal)).toBe(5000);
  });

  it('⚠ o recorte de lote da operação INTERNA já excluía o pré-precatório', async () => {
    /**
     * A metade que explica por que o defeito só atingia o cliente — e o caso que
     * impede alguém de "consertar" o interno mexendo onde não precisa.
     *
     * Lote é (tribunal + exercício). Pré-precatório tem exercício NULO, então não
     * casa com lote nenhum e some da visão interna sozinho. O cliente não tem
     * recorte de lote: para ele, `loteEfetivo` devolve `null` e o filtro fica
     * vazio.
     */
    const { org } = await semearOrganizacao();
    const exigivel = await semearProcesso({ organizationId: org.id });
    const pre = await semearProcesso({
      organizationId: org.id,
      fase: 'PRECATORIO_AUTUADO',
      exercicio: null,
      valor: null,
    });
    await vincular(exigivel.id, 900000135, 'ELISA EXIGIVEL');
    await vincular(pre.id, 900000136, 'FABIO ANTERIOR');

    const r = await carteira.resumo({ lote: LOTE, usuario: interno(org.id) });

    expect(r.processos).toBe(1);
    expect(r.porFase).toEqual([{ fase: 'PRECATORIO_EXPEDIDO', quantidade: 1 }]);
  });

  /**
   * O RANKING POR ENTIDADE DIZ QUANTOS DAQUELES TÊM VALOR APURADO.
   *
   * A barra soma `valor` e a contagem usa `_count._all`. Como o pré-precatório
   * tem `valor` NULO, ele entrava na contagem somando R$ 0 — e o tooltip
   * anunciava "N processos" ao lado de um dinheiro que não cobria N.
   *
   * `_count: { valor: true }` conta os NÃO-NULOS. A diferença para `quantidade`
   * é exatamente o que a soma não alcança.
   */
  it('⚠ porEntidade separa quantos processos têm valor apurado', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const comValor = await semearProcesso({ organizationId: org.id, valor: 7000 });
    const semValor = await semearProcesso({
      organizationId: org.id,
      fase: 'CALCULOS_HOMOLOGADOS',
      exercicio: null,
      valor: null,
    });
    await vincular(comValor.id, 900000141, 'ANA COM VALOR');
    await vincular(semValor.id, 900000142, 'BRUNO SEM VALOR');
    await liberarProcesso(c.org.id, comValor.id);
    await liberarProcesso(c.org.id, semValor.id);

    const r = await carteira.resumo({ usuario: c.escopo });

    /* O fixture põe os dois na mesma entidade devedora ('INSS'). */
    const inss = r.porEntidade.find((e) => e.entidade === 'INSS');
    expect(inss).toBeDefined();
    expect(inss!.quantidade).toBe(2);
    expect(inss!.comValor).toBe(1);
    expect(Number(inss!.valor)).toBe(7000);
  });

  /**
   * A ORDEM DA FILA DEIXA DE AFUNDAR OS PRÉ-PRECATÓRIOS EM BLOCO.
   *
   * A régua é `valor DESC NULLS LAST`, e o dinheiro do pré-precatório está em
   * OUTRA coluna. Todos com `valor` nulo, todos empatados, todos no fim — e
   * dentro do módulo de pré-precatórios, onde NENHUM tem `valor`, a ordem virava
   * o `id`, ou seja, nenhuma.
   *
   * ⚠ `valorIndicativo` entra como chave SECUNDÁRIA, e não intercalado. Uma
   * régua só exigiria `COALESCE` em SQL cru e poria palpite extraído de texto na
   * mesma escala que dinheiro apurado. Como secundária, não muda nada para quem
   * tem `valor` — e este caso fixa as duas metades.
   */
  it('⚠ entre pré-precatórios, a ordem passa a ser o valor indicativo', async () => {
    const { org } = await semearOrganizacao();
    const apurado = await semearProcesso({ organizationId: org.id, valor: 1000 });
    const pequeno = await semearProcesso({
      organizationId: org.id,
      fase: 'CALCULOS_HOMOLOGADOS',
      exercicio: null,
      valor: null,
    });
    const grande = await semearProcesso({
      organizationId: org.id,
      fase: 'CALCULOS_HOMOLOGADOS',
      exercicio: null,
      valor: null,
    });
    await prisma.processo.update({ where: { id: pequeno.id }, data: { valorIndicativo: 50 } });
    await prisma.processo.update({ where: { id: grande.id }, data: { valorIndicativo: 900_000 } });

    const r = await carteira.fila({
      pagina: 1,
      porPagina: 10,
      semLote: true,
      usuario: interno(org.id),
    });

    const ordem = r.itens.map((i) => i.id);
    /* O apurado continua no topo: a chave primária não mudou. */
    expect(ordem[0]).toBe(apurado.id);
    /* E entre os dois sem valor apurado, o maior indicativo vem antes. */
    expect(ordem.indexOf(grande.id)).toBeLessThan(ordem.indexOf(pequeno.id));
  });

  it('evento de ENRIQUECIDO chega ao cliente como atualização genérica', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const p = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(c.org.id, p.id);
    await prisma.eventoProcesso.create({
      data: {
        processoId: p.id,
        tipo: 'ENRIQUECIDO',
        descricao: 'Enriquecido via CONTACTRA (3 telefones)',
      },
    });

    const doCliente = await carteira.processo(p.id, c.escopo);
    const evento = doCliente!.eventos[0];
    expect(evento.tipo).toBe('DADO_ATUALIZADO');
    expect(evento.descricao).toBe('Dados atualizados');
    /* Nem por acaso: a descrição original citava o provedor pelo nome. */
    expect(JSON.stringify(doCliente)).not.toMatch(/CONTACTRA/i);
  });

  it('o time INTERNO também recebe o funil do processo', async () => {
    /**
     * Estava dentro da projeção do cliente, e por isso a org interna recebia o
     * processo sem estágio, sem motivo de perda e sem último contato: o bloco de
     * funil da página não acendia botão nenhum para o time que mantém a base.
     *
     * Não é a dualidade — estágio e contato só existem no overlay, para os dois.
     * Dualidade é prioridade/responsável, e essa continua.
     */
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });
    const crm = new CrmService(prisma as never);

    await crm.definirEstagio(p.id, autor, {
      estagio: 'PERDIDO',
      motivoPerda: 'titular já cedeu a outro escritório',
    });
    await crm.registrarContato(p.id, autor, { resultado: 'NAO_ATENDEU' });

    const doInterno = await carteira.processo(p.id, interno(org.id));

    expect(doInterno!.estagio).toBe('PERDIDO');
    expect(doInterno!.motivoPerda).toBe('titular já cedeu a outro escritório');
    expect(doInterno!.ultimoContatoEm).not.toBeNull();
  });

  /**
   * O overlay: dois tenants trabalham o MESMO processo sem enxergar o CRM um do
   * outro. Aqui a anotação do time interno — texto livre, com dado pessoal —
   * some para o cliente que recebeu aquele processo liberado.
   */
  it('anotação do time interno não aparece para o cliente', async () => {
    const { org, user } = await semearOrganizacao();
    const c = await semearCliente();
    const p = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(c.org.id, p.id);
    await prisma.anotacaoProcesso.create({
      data: {
        processoId: p.id,
        organizationId: org.id,
        autorId: user.id,
        texto: 'Ligar para a filha da requerente',
      },
    });

    const doDono = await carteira.processo(p.id, interno(org.id));
    const doCliente = await carteira.processo(p.id, c.escopo);

    expect(doDono!.anotacoes).toHaveLength(1);
    expect(doCliente!.anotacoes).toHaveLength(0);
  });
});

describe('Carteira — catálogo nacional', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('os 6 TRFs continuam cobrindo as 27 UFs sem sobreposição', async () => {
    const { org } = await semearOrganizacao();
    const catalogo = await carteira.tribunais(interno(org.id));

    /* ── A INVARIANTE É DA ESFERA FEDERAL, E SÓ DELA ──
       Este caso já afirmou que o catálogo INTEIRO eram os seis TRFs. Deixou de
       ser verdade em 04/09/2026, quando entraram 24 tribunais estaduais e 13
       trabalhistas para admitir os pré-precatórios — e menos ainda em
       17/09/2026, quando mais 11 entraram para os arquivos do radar, e em
       30/09/2026, com o TRT5 e o TRT24. O que ele protegia continua
       valendo e continua importando: as jurisdições federais PARTICIONAM o país,
       e MG já esteve em TRF1 e TRF6 ao mesmo tempo — foi esta checagem que pegou. */
    const federais = catalogo.filter((t) => t.esfera === 'FEDERAL');
    expect(federais.map((t) => t.sigla)).toEqual(['TRF1', 'TRF2', 'TRF3', 'TRF4', 'TRF5', 'TRF6']);

    const ufs = federais.flatMap((t) => t.ufsJurisdicao);
    expect(ufs).toHaveLength(27);
    expect(new Set(ufs).size).toBe(27);
  });

  it('o catálogo passou a ter as três esferas, e SP se repete entre elas de propósito', async () => {
    const { org } = await semearOrganizacao();
    const catalogo = await carteira.tribunais(interno(org.id));

    const porEsfera = catalogo.reduce<Record<string, number>>((acc, t) => {
      acc[t.esfera] = (acc[t.esfera] ?? 0) + 1;
      return acc;
    }, {});
    expect(porEsfera).toEqual({ FEDERAL: 6, ESTADUAL: 26, TRABALHISTA: 24 });

    /* Sobreposição ENTRE esferas é o esperado, não defeito: São Paulo é julgado
       pelo TRF3, pelo TJSP, e por DOIS tribunais do trabalho — o TRT2 na capital
       e o TRT15 no interior. Um `Set` sobre o catálogo inteiro esconderia isso e
       faria a próxima pessoa "consertar" o que está certo. */
    const emSP = catalogo.filter((t) => t.ufsJurisdicao.includes('SP')).map((t) => t.sigla);
    expect(emSP.sort()).toEqual(['TJSP', 'TRF3', 'TRT15', 'TRT2']);
  });

  it('lista só os exercícios que a organização realmente tem', async () => {
    const { org } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2028 });

    const catalogo = await carteira.tribunais(interno(org.id));
    const trf5 = catalogo.find((t) => t.sigla === 'TRF5')!;
    const trf1 = catalogo.find((t) => t.sigla === 'TRF1')!;

    // Mais recente primeiro — é o exercício em que se trabalha.
    expect(trf5.exercicios).toEqual([
      { exercicio: 2028, processos: 1 },
      { exercicio: 2027, processos: 2 },
    ]);
    expect(trf5.processos).toBe(3);
    // Tribunal sem carteira aparece no catálogo, mas sem lote nenhum.
    expect(trf1.exercicios).toEqual([]);
  });

  it('os seis TRFs têm perfil próprio — o modo de escolher tribunal na tela funciona neles', async () => {
    /* Sem isto, escolher qualquer tribunal que não o TRF5 estouraria no primeiro
       upload — a abrangência nacional existiria no catálogo e morreria na prática.
       O caso já afirmou que o catálogo INTEIRO eram esses seis perfis; deixou de
       ser verdade em 04/09/2026, quando entrou o perfil multi-tribunal. */
    const perTribunal = await prisma.perfilImportacao.findMany({
      where: { ativo: true, tribunalId: { not: null } },
      select: { mapaColunas: true, tribunal: { select: { sigla: true } } },
    });

    expect(perTribunal.map((p) => p.tribunal!.sigla).sort()).toEqual([
      'TRF1',
      'TRF2',
      'TRF3',
      'TRF4',
      'TRF5',
      'TRF6',
    ]);
    for (const p of perTribunal) {
      expect(Object.keys(p.mapaColunas as object)).toEqual(
        expect.arrayContaining(['cpf', 'processo', 'situacao']),
      );
    }
  });

  it('os 50 tribunais estaduais e trabalhistas NÃO têm perfil próprio — e só o modo multi-tribunal os alcança', async () => {
    /**
     * ⚠ ISTO NÃO É UMA LACUNA ESQUECIDA; É O DESENHO, E O CASO EXISTE PARA QUE
     * ELE FIQUE ESCRITO.
     *
     * Trinta e sete entraram no catálogo em 04/09/2026 para receber os
     * pré-precatórios, mais 11 em 17/09/2026 e 2 em 30/09/2026 (TRT5, TRT24)
     * para os arquivos do radar. Todos chegam num arquivo só, com o tribunal
     * numa coluna. Dar a cada um deles um perfil de "dívida consolidada" seria
     * inventar 50 formatos de planilha que ninguém publica.
     *
     * ⚠ O NÚMERO AQUI É FIXADO DE PROPÓSITO, e vai quebrar de novo na próxima
     * leva — que é o comportamento desejado. Derivar a contagem do próprio
     * catálogo faria o caso concordar com qualquer coisa, inclusive com um
     * tribunal que entrou por engano.
     *
     * A consequência prática, e é ela que o caso fixa: escolher TJSP na tela
     * responde 400. O caminho para eles é o perfil multi-tribunal, escolhido
     * explicitamente. No dia em que um TJ publicar a própria planilha, o perfil
     * dele entra aqui e este caso muda junto — de propósito.
     */
    const semPerfil = await prisma.tribunal.findMany({
      where: { ativo: true, perfis: { none: {} } },
      select: { sigla: true, esfera: true },
    });

    expect(semPerfil).toHaveLength(50);
    expect(new Set(semPerfil.map((t) => t.esfera))).toEqual(
      new Set(['ESTADUAL', 'TRABALHISTA']),
    );

    /* E existe exatamente UM perfil sem tribunal — o índice parcial da migration
       garante que dois não possam ter o mesmo nome, mas quantidade é decisão de
       produto, e é aqui que ela fica registrada. */
    const multi = await prisma.perfilImportacao.findMany({
      where: { ativo: true, tribunalId: null },
      select: { nome: true, aba: true, colunasObrigatorias: true },
    });
    expect(multi).toHaveLength(1);
    /* A aba é declarada: com o campo nulo o leitor pega a PRIMEIRA aba do
       arquivo, em silêncio — e o arquivo de pré-precatórios tem duas. */
    expect(multi[0].aba).toBe('Oportunidades');
    /* `tribunal` e `fase` são obrigatórias porque o modo não tem como supri-las:
       sem tribunal o processo não tem onde ser gravado; sem fase ele seria
       vendido como coisa que não é. */
    expect(multi[0].colunasObrigatorias.sort()).toEqual(['cpf', 'fase', 'processo', 'tribunal']);
  });
});

describe('Importação — o destino é escolhido, e conferido', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * Com o tribunal selecionável, mandar a planilha do TRF1 para o TRF5 vira um
   * erro possível — e nada mais no fluxo o detectaria: o número é texto opaco em
   * todo o resto do sistema, então milhares de processos entrariam sob o
   * tribunal errado, com chave composta válida e zero erro. Desfazer exigiria
   * apagar um a um.
   */
  it('recusa planilha cujo número CNJ aponta para outro tribunal', async () => {
    const { org, user } = await semearOrganizacao();

    await expect(
      importacao.importar({
        arquivo: planilha('01'),
        organizationId: org.id,
        userId: user.id,
        dryRun: true,
        lote: { tribunal: 'TRF5', exercicio: 2027 },
      }),
    ).rejects.toThrow(/TRF1.*TRF5|TRF5.*TRF1/);
  });

  it('a MESMA planilha passa quando o destino é o tribunal certo', async () => {
    const { org, user } = await semearOrganizacao();

    const s = await importacao.importar({
      arquivo: planilha('01'),
      organizationId: org.id,
      userId: user.id,
      dryRun: true,
      lote: { tribunal: 'TRF1', exercicio: 2028 },
    });

    expect(s.destino).toEqual({ tribunal: 'TRF1', exercicio: 2028 });
    expect(s.totalLinhas).toBe(12);
  });

  /**
   * Dois limiares evitam falso positivo. Poucos números divergentes acontecem
   * (processo redistribuído) e não podem barrar a carga inteira.
   */
  it('amostra pequena não é suficiente para recusar', async () => {
    const { org, user } = await semearOrganizacao();

    const s = await importacao.importar({
      arquivo: planilha('01', 5),
      organizationId: org.id,
      userId: user.id,
      dryRun: true,
      lote: { tribunal: 'TRF5', exercicio: 2027 },
    });
    expect(s.dryRun).toBe(true);
  });

  it('grava no tribunal e exercício pedidos, não no padrão', async () => {
    const { org, user } = await semearOrganizacao();

    const r = await importarEProcessar({
      arquivo: planilha('01'),
      organizationId: org.id,
      userId: user.id,
      lote: { tribunal: 'TRF1', exercicio: 2028 },
    });

    expect(r.processos.criados).toBe(12);
    const gravados = await observador.processo.findMany({
      select: { exercicio: true, tribunal: { select: { sigla: true } } },
    });
    expect(gravados).toHaveLength(12);
    expect(gravados.every((p) => p.tribunal.sigla === 'TRF1' && p.exercicio === 2028)).toBe(true);
  });

  it('tribunal inexistente falha antes de escrever qualquer linha', async () => {
    const { org, user } = await semearOrganizacao();

    await expect(
      importacao.importar({
        arquivo: planilha('05'),
        organizationId: org.id,
        userId: user.id,
        lote: { tribunal: 'TRF9', exercicio: 2027 },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(await observador.processo.count()).toBe(0);
    expect(await prisma.pessoa.count()).toBe(0);
  });
});

describe('Importação — reenvio e diff-and-update', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  const lote = { tribunal: 'TRF5', exercicio: 2027 };

  /**
   * Reenviar o arquivo IDÊNTICO é bloqueado pelo hash SHA-256 — é a proteção
   * contra duplicar a carteira por engano (clicar duas vezes, arrastar de novo).
   * Só vale para gravação: a simulação continua liberada, senão não daria para
   * conferir um arquivo já importado.
   */
  it('reenviar o MESMO arquivo é recusado', async () => {
    const { org, user } = await semearOrganizacao();
    await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });

    await expect(
      importacao.importar({
        arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
      }),
    ).rejects.toThrow(/já foi importado/);

    // Mas simular continua permitido.
    const s = await importacao.importar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, dryRun: true, lote,
    });
    expect(s.dryRun).toBe(true);
  });

  /**
   * O caso REAL do diff: a planilha corrigida tem bytes diferentes (passa pelo
   * hash) e conteúdo igual. Nada pode mudar, e a timeline não pode crescer —
   * é o que faz o botão de reimportar ser seguro de apertar.
   */
  it('planilha corrigida com o mesmo conteúdo não altera nada', async () => {
    const { org, user } = await semearOrganizacao();

    const primeira = await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });
    expect(primeira.processos.criados).toBe(12);

    /* Antes isto conferia o campo `eventos` da resposta. Ele saiu: era sempre
       criados + atualizados, e devolver a soma ao lado das parcelas só levanta
       a dúvida de por que os dois números deveriam diferir. A pergunta que
       importa — a timeline cresceu doze linhas? — passa a ser feita à tabela,
       que é onde a resposta vale. */
    const eventosAntes = await observador.eventoProcesso.count();
    expect(eventosAntes).toBe(12);

    const segunda = await importarEProcessar({
      arquivo: planilha('05', 12, '\n\n'), organizationId: org.id, userId: user.id, lote,
    });

    expect(segunda.processos.criados).toBe(0);
    expect(segunda.processos.atualizados).toBe(0);
    expect(segunda.processos.inalterados).toBe(12);
    expect(await observador.eventoProcesso.count()).toBe(eventosAntes);
  });

  /**
   * Vazio NÃO apaga: a planilha de teste não traz coluna de situação, então um
   * campo preenchido no banco sobrevive à reimportação. É deliberado — uma
   * planilha parcial não pode virar exclusão em massa.
   */
  it('coluna ausente na planilha não apaga o que já está no banco', async () => {
    const { org, user } = await semearOrganizacao();
    await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });

    const alvo = await prisma.processo.findFirstOrThrow({ select: { id: true } });
    await prisma.processo.update({
      where: { id: alvo.id },
      data: { situacao: 'Pago ao beneficiário' },
    });

    const r = await importarEProcessar({
      arquivo: planilha('05', 12, '\n\n'), organizationId: org.id, userId: user.id, lote,
    });

    expect(r.processos.inalterados).toBe(12);
    const depois = await prisma.processo.findUniqueOrThrow({
      where: { id: alvo.id }, select: { situacao: true },
    });
    expect(depois.situacao).toBe('Pago ao beneficiário');
  });
});

/**
 * O enfileiramento roda dentro do laço de LINHAS, mas a unidade de consulta ao
 * provedor é a PESSOA. Enquanto os dois não foram amarrados, a mesma planilha
 * produzia três respostas para "quantos vão enriquecer": a simulação prometia
 * 3.866, o relatório da execução dizia 4.033 e a fila recebia 3.839. Nenhum
 * estava errado isolado — cada um respondia a uma pergunta ligeiramente
 * diferente, e o operador via a diferença na tela sem explicação.
 */
describe('Importação — quantos vão para a fila', () => {
  beforeEach(async () => {
    await limparDados();
    lotesEnfileirados.length = 0;
  });
  afterAll(encerrar);

  const lote = { tribunal: 'TRF5', exercicio: 2027 };

  it('titular em três precatórios conta como UMA pessoa na fila', async () => {
    const { org, user } = await semearOrganizacao();

    const r = await importarEProcessar({
      arquivo: planilhaTitularRepetido(), organizationId: org.id, userId: user.id, lote,
    });

    expect(r.totalLinhas).toBe(4);
    expect(r.processos.criados).toBe(4);
    // O ponto: 4 linhas, 4 precatórios — e 2 pessoas.
    expect(r.enfileirados).toBe(2);

    /* E a fila recebeu cada TITULAR uma vez só, não um por linha.
       A aferição era por CPF; passou a ser por `pessoaId` porque o job não
       carrega mais o CPF. Não é perda de rigor: `Pessoa.cpf` é único, então
       contar pessoas distintas é contar CPFs distintos. */
    const pessoas = lotesEnfileirados.flat().map((i) => i.pessoaId);
    expect(pessoas).toHaveLength(2);
    expect(new Set(pessoas).size).toBe(2);
  });

  /**
   * ── O FIO QUE FICOU SOLTO UM MÊS ──
   *
   * O perfil do TRF1 mapeia `vara` e `natureza` desde 09/08/2026, e a migration
   * que os criou avisava: "`natureza` e `vara` são chaves NOVAS. O importador
   * genérico ainda não as lê." O banco tinha as colunas, o perfil tinha os
   * aliases, `CAMPOS_LOGAVEIS` já sabia comparar as duas — e a API simplesmente
   * não montava os campos ao reconciliar. A planilha trazia o juízo de origem e
   * ele caía no chão, calado.
   *
   * É a mesma classe do buraco que `situacao` já teve, e que o comentário do
   * fallback descreve: coluna no banco, alias no perfil, e nada chegando ao
   * delta. Aquele foi fechado quando alguém reimportou pela tela e viu que os
   * processos vinham "inalterados" — sinal de que o diff LEU o campo.
   *
   * Este caso fecha o mesmo tipo de vão sem depender de alguém reparar.
   */
  it('o juízo de origem da planilha chega ao processo', async () => {
    const { org, user } = await semearOrganizacao();
    const csv =
      'CPF,Nome,Processo,Juízo de origem,Natureza\n' +
      `${cpfValido(920000001)},TITULAR DO TRF1,0300001-11.2026.4.01.0000,3ª Vara Federal de Goiânia,alimentar\n`;

    const r = await importarEProcessar({
      arquivo: { buffer: Buffer.from(csv, 'utf8'), originalname: 'trf1.csv' } as Express.Multer.File,
      organizationId: org.id,
      userId: user.id,
      /* TRF1 de propósito: é o perfil que mapeia `vara` e `natureza`. O do TRF5,
         usado nos demais casos deste arquivo, não os mapeia — então este caminho
         não seria exercitado com o lote padrão. */
      lote: { tribunal: 'TRF1', exercicio: 2027 },
    });

    expect(r.processos.criados).toBe(1);

    const p = await prisma.processo.findFirstOrThrow({
      where: { numeroPrecatorio: '0300001-11.2026.4.01.0000' },
      select: { vara: true, natureza: true },
    });
    expect(p.vara).toBe('3ª Vara Federal de Goiânia');
    expect(p.natureza).toBe('alimentar');
  });

  /**
   * ── O CAMINHO QUE O PRÓPRIO CÓDIGO DECLARAVA SEM REDE ──
   *
   * `reconciliados` existe para o caso de VÁRIAS LINHAS DO MESMO PROCESSO: a
   * primeira decide os campos e as demais só criam o vínculo da parte, para a
   * importação não ficar em thrash — cada linha reescrevendo o que a anterior
   * gravou, emitindo evento em todo processo em toda execução.
   *
   * O comentário dele avisava, com todas as letras, que "este caminho NÃO é
   * exercitado hoje": os processos do TRF5 têm uma parte cada, e as planilhas
   * dos testes repetem TITULAR, que é o caso oposto. `reconciliados` nunca
   * acertava em cheio, nem em produção nem na suíte.
   *
   * Ele deixa de ser hipótese com os PRÉ-PRECATÓRIOS. O arquivo de 03/09/2026
   * não tem número de requisitório — o único identificador é o número do
   * processo —, então dois requisitórios irmãos (o principal e os honorários
   * advocatícios, que são requisições distintas da mesma ação) chegariam como
   * duas linhas do MESMO processo, com credores diferentes.
   *
   * Este caso fixa o que acontece: UM processo, DUAS partes, UM evento. É o
   * registro de que o comportamento é COLAPSAR. Se um dia a decisão for que
   * irmãos viram processos separados, a mudança aparece AQUI, em vez de aparecer
   * como oportunidade sumida na carteira de um cliente.
   *
   * ⚠ E ELE NÃO COBRE O `reconciliados`, apesar de eu ter escrito que cobria.
   *
   * Conferi desligando o mapa (`const conhecido = undefined`): o caso continua
   * verde. O que garante o resultado é o `findUnique` pela chave composta — a
   * segunda linha ENCONTRA no banco o processo que a primeira acabou de criar e
   * segue pelo caminho de atualização, criando o vínculo da parte. O
   * `reconciliados` é um cache em memória por cima disso, e a diferença dele
   * seria visível só se as duas linhas trouxessem VALORES de processo
   * divergentes — o que este formato de planilha (CPF, Nome, Processo) não
   * permite expressar.
   *
   * Ou seja: o aviso do código continua valendo, e a rede dele continua sem
   * existir. O que passou a existir é a rede do COMPORTAMENTO OBSERVÁVEL, que é
   * o que o cliente vê.
   *
   * ⚠ No arquivo de hoje o caso não ocorre: são 1.169 linhas e 1.169 processos
   * distintos, conferido. O risco é de arquivos futuros, e é silencioso por
   * natureza — nada erra, um dos dois simplesmente não existe.
   */
  it('duas linhas do MESMO processo viram UM processo com DUAS partes', async () => {
    const { org, user } = await semearOrganizacao();
    const processo = '0200001-11.2026.4.05.0000';
    const csv =
      'CPF,Nome,Processo\n' +
      `${cpfValido(910000001)},TITULAR PRINCIPAL,${processo}\n` +
      `${cpfValido(910000002)},ADVOGADO HONORARIOS,${processo}\n`;

    const r = await importarEProcessar({
      arquivo: { buffer: Buffer.from(csv, 'utf8'), originalname: 'irmaos.csv' } as Express.Multer.File,
      organizationId: org.id,
      userId: user.id,
      lote,
    });

    expect(r.totalLinhas).toBe(2);
    /* UM processo, e não dois: as duas linhas falam da mesma ação. */
    expect(r.processos.criados).toBe(1);

    const criado = await prisma.processo.findFirstOrThrow({
      where: { numeroPrecatorio: processo },
      select: { id: true, partes: { select: { pessoa: { select: { nome: true } } } } },
    });
    /* As DUAS partes entram — é o que impede a segunda linha de sumir. */
    expect(criado.partes.map((p) => p.pessoa.nome).sort()).toEqual([
      'ADVOGADO HONORARIOS',
      'TITULAR PRINCIPAL',
    ]);

    /* E UM evento só: a segunda linha não reescreve o que a primeira gravou. */
    const eventos = await observador.eventoProcesso.count({ where: { processoId: criado.id } });
    expect(eventos).toBe(1);
  });

  /**
   * A simulação existe para o operador decidir se confirma. Se ela promete um
   * número e a execução entrega outro, ela deixa de servir para isso — e o
   * desvio some no meio de uma tela cheia de números certos.
   */
  it('a simulação promete exatamente o que a execução entrega', async () => {
    const { org, user } = await semearOrganizacao();

    const s = await importacao.importar({
      arquivo: planilhaTitularRepetido(),
      organizationId: org.id, userId: user.id, dryRun: true, lote,
    });
    const r = await importarEProcessar({
      arquivo: planilhaTitularRepetido(), organizationId: org.id, userId: user.id, lote,
    });

    expect(s.seriamEnfileiradas).toBe(r.enfileirados);
  });

  /**
   * Quem falhou por causa transitória (timeout, 5xx, teto do dia) precisa
   * voltar para a fila. O critério antigo da importação era `=== 'PENDENTE'`,
   * então a pessoa em ERRO ficava esperando o cron — inclusive quando o
   * operador reimportava a planilha justamente para destravá-la.
   */
  it('quem está em ERRO volta para a fila; quem está SEM_DADOS não', async () => {
    const { org, user } = await semearOrganizacao();
    await importarEProcessar({
      arquivo: planilhaTitularRepetido(), organizationId: org.id, userId: user.id, lote,
    });

    const [a, b] = await prisma.pessoa.findMany({ orderBy: { cpf: 'asc' }, select: { id: true } });
    await prisma.pessoa.update({ where: { id: a.id }, data: { statusEnriquecimento: 'ERRO' } });
    await prisma.pessoa.update({ where: { id: b.id }, data: { statusEnriquecimento: 'SEM_DADOS' } });

    lotesEnfileirados.length = 0;
    const r = await importarEProcessar({
      arquivo: planilhaTitularRepetido('\n\n'), organizationId: org.id, userId: user.id, lote,
    });

    // Só o de ERRO. O SEM_DADOS o provedor já respondeu que não tem.
    expect(r.enfileirados).toBe(1);
    expect(lotesEnfileirados.flat().map((i) => i.pessoaId)).toEqual([a.id]);
  });
});

/**
 * B5 — a importação saiu da requisição.
 *
 * O trabalho custa 8,5 ms por linha (medido). Com o teto de 100 mil linhas que
 * o B6 estabeleceu, isso são catorze minutos dentro de um HTTP — que nenhum
 * proxy deixa terminar, e cujo corte deixaria a carga PROCESSANDO para sempre.
 *
 * O que estes testes cobrem é a DIVISÃO: o que a requisição ainda faz, o que
 * ela deixou de fazer, e o que acontece quando a metade de trás falha.
 */
describe('Importação — recebe na requisição, processa na fila', () => {
  beforeEach(async () => {
    await limparDados();
    lotesEnfileirados.length = 0;
  });
  afterAll(encerrar);

  const lote = { tribunal: 'TRF5', exercicio: 2027 };

  /** Uma linha com nome e mais nada: nem CPF nem processo. */
  function planilhaComLinhaVazia() {
    const csv =
      'CPF,Nome,Processo\n' +
      `${cpfValido(900000001)},FULANO,0100001-11.2026.4.05.0000\n` +
      ',SEM NADA,\n';
    return {
      buffer: Buffer.from(csv, 'utf8'),
      originalname: 'com-linha-vazia.csv',
    } as Express.Multer.File;
  }

  it('a requisição grava as linhas cruas e NÃO toca na carteira', async () => {
    const { org, user } = await semearOrganizacao();

    const r = await importacao.importar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });
    const importacaoId = idDoRecibo(r);

    /* O ponto do B5 inteiro: a resposta é um recibo, não um resultado. */
    expect(r).toMatchObject({ status: 'RECEBIDA', totalLinhas: 12 });

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: importacaoId } });
    expect(imp.status).toBe('RECEBIDA');
    expect(imp.processadas).toBe(0);
    /* O destino vai para o BANCO: é daqui que o worker o relê. */
    expect(imp.exercicio).toBe(2027);
    expect(imp.tribunalId).not.toBeNull();

    const linhas = await prisma.importacaoLinha.findMany({ where: { importacaoId } });
    expect(linhas).toHaveLength(12);
    expect(linhas.every((l) => l.status === 'PENDENTE')).toBe(true);
    /* Sem `dadosBrutos` o worker não teria de onde trabalhar: a planilha não é
       guardada em lugar nenhum. */
    expect(linhas.every((l) => l.dadosBrutos !== null)).toBe(true);

    // E nada foi escrito na carteira ainda.
    expect(await prisma.pessoa.count()).toBe(0);
    expect(await observador.processo.count()).toBe(0);
    expect(lotesEnfileirados).toHaveLength(0);
  });

  it('o worker RETOMA de onde parou, sem duplicar nada', async () => {
    const { org, user } = await semearOrganizacao();
    const primeira = await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });
    expect(primeira.sucesso).toBe(12);

    /* O estado que uma queda no meio deixa: parte das linhas processada, o
       resto em PENDENTE, a importação ainda em PROCESSANDO. */
    const ultimas = await prisma.importacaoLinha.findMany({
      where: { importacaoId: primeira.importacaoId },
      orderBy: { numeroLinha: 'desc' },
      take: 4,
      select: { id: true },
    });
    await prisma.importacaoLinha.updateMany({
      where: { id: { in: ultimas.map((l) => l.id) } },
      data: { status: 'PENDENTE' },
    });
    await prisma.importacao.update({
      where: { id: primeira.importacaoId },
      data: { status: 'PROCESSANDO', concluidoEm: null },
    });

    await importacao.processarImportacao(primeira.importacaoId);

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: primeira.importacaoId } });
    /* Os contadores vêm do BANCO, não de variáveis acumuladas: se viessem da
       memória, a segunda passada somaria 4 sucessos aos 12 e a tela mostraria
       16 linhas numa planilha de 12. */
    expect(imp.sucesso).toBe(12);
    expect(imp.processadas).toBe(12);
    expect(imp.status).toBe('CONCLUIDA');
    // E nenhum processo ou evento em dobro.
    expect(await observador.processo.count()).toBe(12);
    expect(await observador.eventoProcesso.count()).toBe(12);
    expect(imp.processosCriados).toBe(12);
  });

  it('processar de novo uma importação concluída não faz nada', async () => {
    const { org, user } = await semearOrganizacao();
    const r = await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });

    /* O BullMQ admite entregar o mesmo job duas vezes numa queda de rede. */
    await importacao.processarImportacao(r.importacaoId);

    expect(await observador.processo.count()).toBe(12);
    expect(await observador.eventoProcesso.count()).toBe(12);
  });

  /**
   * Esta recusa NASCEU com a fila. Antes o trabalho cabia na requisição e a
   * janela para reenviar era o tempo dela; agora a carga fica minutos em
   * RECEBIDA, e o operador que não vê progresso reenvia.
   */
  it('reenviar a planilha que JÁ está na fila é recusado', async () => {
    const { org, user } = await semearOrganizacao();
    await importacao.importar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });

    await expect(
      importacao.importar({
        arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
      }),
    ).rejects.toThrow(/já está sendo importado/);

    // Uma importação só, não duas.
    expect(await observador.importacao.count()).toBe(1);
  });

  /**
   * Sem fila não há quem processe. O pior desfecho seria a tela dizer
   * "recebida" e a barra ficar parada em zero para sempre, sem erro nenhum.
   */
  it('fila fora: marca FALHOU, não suja a carteira, e o reenvio funciona depois', async () => {
    const { org, user } = await semearOrganizacao();
    const original = filaFalsa.enfileirarImportacao;
    filaFalsa.enfileirarImportacao = async () => {
      throw new Error('a fila não respondeu em 3000ms (enfileirar-importacao)');
    };

    try {
      await expect(
        importacao.importar({
          arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
        }),
      ).rejects.toThrow(/fila de processamento não está respondendo/);
    } finally {
      filaFalsa.enfileirarImportacao = original;
    }

    const imp = await prisma.importacao.findFirstOrThrow();
    expect(imp.status).toBe('FALHOU');
    expect(imp.mensagemErro).toMatch(/fila/i);
    expect(await observador.processo.count()).toBe(0);
    expect(await prisma.pessoa.count()).toBe(0);

    /* FALHOU não entra na trava de hash — de propósito. Sem isso, o operador
       ficaria com um arquivo permanentemente bloqueado por uma queda de Redis
       que não teve nada a ver com ele. */
    const segunda = await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });
    expect(segunda.sucesso).toBe(12);
  });

  it('a linha guarda a qual PROCESSO ela entrou, não só a qual pessoa', async () => {
    const { org, user } = await semearOrganizacao();
    const r = await importarEProcessar({
      arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
    });

    const linhas = await prisma.importacaoLinha.findMany({
      where: { importacaoId: r.importacaoId, status: 'OK' },
      select: { pessoaId: true, processoId: true },
    });
    /* `processoId` existia no schema desde o começo e ficava SEMPRE nulo: a
       linha sabia quem era a pessoa e não a qual processo ela tinha entrado. */
    expect(linhas.every((l) => l.pessoaId !== null && l.processoId !== null)).toBe(true);
  });

  it('linha sem CPF e sem processo é IGNORADA, e não conta como falha', async () => {
    const { org, user } = await semearOrganizacao();
    const r = await importarEProcessar({
      arquivo: planilhaComLinhaVazia(), organizationId: org.id, userId: user.id, lote,
    });

    expect(r.totalLinhas).toBe(2);
    expect(r.sucesso).toBe(1);
    expect(r.ignoradas).toBe(1);
    expect(r.falhas).toBe(0);
    /* Falha mudaria o status para CONCLUIDA_COM_ERROS e faria as linhas em
       branco do fim de uma planilha parecerem problema. */
    expect(r.status).toBe('CONCLUIDA');
  });

  it('importação sem destino gravado não é processada às cegas', async () => {
    const { org, user } = await semearOrganizacao();
    const importacaoId = idDoRecibo(
      await importacao.importar({
        arquivo: planilha('05'), organizationId: org.id, userId: user.id, lote,
      }),
    );

    /* A forma das importações gravadas ANTES do B5: o tribunal existia só como
       argumento em memória do serviço. */
    await prisma.importacao.update({
      where: { id: importacaoId },
      data: { tribunalId: null, exercicio: null },
    });

    await importacao.processarImportacao(importacaoId);

    const imp = await prisma.importacao.findUniqueOrThrow({ where: { id: importacaoId } });
    expect(imp.status).toBe('FALHOU');
    expect(imp.mensagemErro).toMatch(/tribunal|exerc/i);
    // Nada entrou sob tribunal nenhum.
    expect(await observador.processo.count()).toBe(0);
  });

  /**
   * O cliente vê TUDO que foi liberado para ele — não o recorte da nossa
   * importação.
   *
   * Aconteceu de verdade: o primeiro cliente pagou por "250 precatórios por
   * mês", o motor entregou os 250 (sorteia da base inteira, sem filtro de
   * tribunal) e a tela mostrou 158. Os outros 92 estavam gravados, pagos e
   * invisíveis — a carteira caía no LOTE_PADRAO TRF5/2027 e escondia o que
   * viesse de outro tribunal. E a defasagem CRESCIA a cada ciclo.
   */
  describe('a carteira do cliente não é recortada por lote', () => {
    /* O mesmo valor do LOTE_PADRAO — declarado aqui porque o `LOTE` do bloco
       anterior não alcança este escopo, assim como o `vincular` abaixo. */
    const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

    /** Dá um titular ao processo — `buscar` devolve PESSOAS, não processos. */
    async function comTitular(processoId: string, seq: number, nome: string) {
      const pessoa = await prisma.pessoa.create({
        data: { cpf: cpfValido(seq), nome, nomeNormalizado: nome },
        select: { id: true },
      });
      await prisma.processoPessoa.create({ data: { processoId, pessoaId: pessoa.id } });
      return pessoa;
    }

    /** Um cliente com processos liberados em DOIS tribunais diferentes. */
    async function clienteComDoisTribunais() {
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      const noTrf5 = await semearProcesso({ organizationId: org.id, sigla: 'TRF5' });
      const noTrf1 = await semearProcesso({ organizationId: org.id, sigla: 'TRF1' });
      await liberarProcesso(c.org.id, noTrf5.id);
      await liberarProcesso(c.org.id, noTrf1.id);
      /* Um terceiro que NÃO é dele: o escopo por liberação continua valendo, e
         tirar o recorte de lote não pode virar "vê a base inteira". */
      await semearProcesso({ organizationId: org.id, sigla: 'TRF1' });
      return { org, c };
    }

    it('o resumo conta os dois tribunais, sem lote pedido', async () => {
      const { c } = await clienteComDoisTribunais();

      const r = await carteira.resumo({ usuario: c.escopo });

      expect(r.processos).toBe(2); // antes vinha 1: só o TRF5
      /* Sem recorte, e a resposta DIZ isso — o chip da tela lê daqui, e
         anunciar "TRF5 · 2027" para uma carteira nacional era a segunda
         mentira da mesma tela. */
      expect(r.lote).toBeNull();
    });

    it('o cliente NÃO passa a ver o que não é dele', async () => {
      /* A trava que não pode ter sido afrouxada junto: são 3 processos na base,
         2 liberados. Se o escopo tivesse ido embora com o lote, viriam 3. */
      const { c } = await clienteComDoisTribunais();

      expect((await carteira.resumo({ usuario: c.escopo })).processos).toBe(2);
      expect(await observador.processo.count()).toBe(3);
    });

    it('pedir um tribunal explicitamente ainda filtra — é o seletor da tela', async () => {
      const { c } = await clienteComDoisTribunais();

      const so5 = await carteira.resumo({ usuario: c.escopo, lote: LOTE });

      expect(so5.processos).toBe(1);
      expect(so5.lote).toEqual(LOTE);
    });

    it('a operação INTERNA continua recortada por lote, como sempre foi', async () => {
      /* A metade que não podia mudar: o lote é como a NOSSA importação se
         organiza, e o dono da base depende dele para não somar safras. */
      const { org } = await clienteComDoisTribunais();

      const r = await carteira.resumo({ usuario: interno(org.id) });

      expect(r.processos).toBe(1); // só o TRF5 do LOTE_PADRAO
      expect(r.lote).toEqual(LOTE);
    });

    it('o painel do cliente também soma os dois tribunais', async () => {
      /* O painel tem DOIS caminhos de escopo — o raw de `porPrioridade` e o
         `doLote` — e o recorte precisava sair dos dois. */
      const { c } = await clienteComDoisTribunais();

      const p = await carteira.painel({ usuario: c.escopo });
      const total = p.operacao.porPrioridade.reduce((s, x) => s + x.quantidade, 0);

      expect(total).toBe(2);
      expect(p.lote).toBeNull();
    });

    it('a busca do cliente encontra titular de qualquer tribunal', async () => {
      /* `buscar` devolve PESSOAS, não processos — por isso cada processo aqui
         precisa de titular vinculado. Sem isso o teste mediria zero contra zero
         e passaria por engano com o recorte de volta. */
      const { org } = await semearOrganizacao();
      const c = await semearCliente();
      const no5 = await semearProcesso({ organizationId: org.id, sigla: 'TRF5' });
      const no1 = await semearProcesso({ organizationId: org.id, sigla: 'TRF1' });
      await comTitular(no5.id, 900000201, 'ANA DO TRF5');
      await comTitular(no1.id, 900000202, 'BRUNO DO TRF1');
      await liberarProcesso(c.org.id, no5.id);
      await liberarProcesso(c.org.id, no1.id);

      const r = await carteira.buscar({ pagina: 1, porPagina: 20, usuario: c.escopo });

      expect(r.total).toBe(2);
      expect(r.itens.map((i) => i.nome).sort()).toEqual(['ANA DO TRF5', 'BRUNO DO TRF1']);
    });
  });
});
