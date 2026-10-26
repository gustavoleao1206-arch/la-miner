import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CrmService } from '../../src/modules/crm/crm.service';
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

/**
 * O service recebe o PrismaService por injeção, mas não usa nada dele além do
 * client — então o client de teste serve, e não é preciso subir o Nest inteiro
 * para exercitar a regra de negócio.
 */
const crm = new CrmService(prisma as never);

const OUTRO_TENANT = '00000000-0000-4000-8000-000000000000';

describe('CRM — isolamento por organização', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * A checagem de tenant é centralizada em `processoDaOrganizacao`, e o erro
   * perigoso é de OMISSÃO: uma rota nova que esqueça a chamada não quebra teste
   * nenhum — só passa a aceitar o UUID de outro cliente. Este bloco cobre as
   * quatro entradas de escrita para que o esquecimento apareça aqui.
   */
  it('nenhuma escrita aceita processo de outra organização', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const intruso = { ...autor, organizationId: OUTRO_TENANT };

    await expect(crm.criarAnotacao(processo.id, intruso, { texto: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    await expect(crm.definirPrioridade(processo.id, intruso, 'URGENTE')).rejects.toThrow(
      NotFoundException,
    );
    await expect(crm.definirEtiquetas(processo.id, intruso, [])).rejects.toThrow(NotFoundException);
    await expect(crm.criarTarefa(processo.id, intruso, { titulo: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('o processo de um tenant é invisível para o outro', async () => {
    const a = await semearOrganizacao('Escritório A');
    const b = await semearOrganizacao('Escritório B');
    const doA = await semearProcesso({ organizationId: a.org.id });

    await crm.criarAnotacao(doA.id, a.autor, { texto: 'visível só para A' });

    /* B não pode nem ler pela porta de escrita: a mensagem é a mesma de
       "não existe", para o 404 não confirmar a existência do id alheio. */
    await expect(crm.criarAnotacao(doA.id, b.autor, { texto: 'invasão' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('responsável tem de ser da mesma organização', async () => {
    const a = await semearOrganizacao('Escritório A');
    const b = await semearOrganizacao('Escritório B');
    const doA = await semearProcesso({ organizationId: a.org.id });

    /* Sem esta trava, o nome de um funcionário de B apareceria na tela de A —
       que não deveria sequer saber que ele existe. */
    await expect(crm.definirResponsavel(doA.id, a.autor, b.user.id)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CRM — anotações e a LGPD', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * Anotação NÃO é EventoProcesso, e este teste tranca a diferença.
   *
   * Texto livre de escritório contém dado pessoal ("ligar para a filha no
   * 81 9xxxx"). A timeline é append-only e um pedido de exclusão do titular não
   * a alcançaria. Se alguém "otimizar" gravando a anotação como OBSERVACAO na
   * timeline, o buraco reabre — e este teste cai.
   */
  it('criar anotação não escreve na timeline append-only', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    await crm.criarAnotacao(processo.id, autor, { texto: 'contato: filha da requerente' });

    expect(await observador.eventoProcesso.count({ where: { processoId: processo.id } })).toBe(0);
  });

  /**
   * Art. 18 da LGPD: exclusão tem de EXCLUIR. Soft delete deixaria o texto no
   * banco, e é justamente o texto que o pedido manda apagar.
   */
  it('remover anotação apaga o texto do banco, não marca como removida', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const agulha = 'telefone do filho 81 90000-0000';

    const anotacao = await crm.criarAnotacao(processo.id, autor, { texto: agulha });
    await crm.removerAnotacao(processo.id, anotacao.id, autor);

    const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM anotacoes_processo WHERE texto LIKE '%81 90000-0000%'`,
    );
    expect(Number(n)).toBe(0);
  });

  it('só o autor edita; ADMIN pode remover a de outro (para atender exclusão)', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const anotacao = await crm.criarAnotacao(processo.id, autor, { texto: 'do autor' });

    const outro = { ...autor, id: OUTRO_TENANT };
    await expect(
      crm.editarAnotacao(processo.id, anotacao.id, outro, { texto: 'reescrita' }),
    ).rejects.toThrow(ForbiddenException);

    /* OPERADOR que não é autor também não apaga... */
    await expect(
      crm.removerAnotacao(processo.id, anotacao.id, { ...outro, papel: 'OPERADOR' }),
    ).rejects.toThrow(ForbiddenException);

    /* ...mas ADMIN apaga, e é isso que torna o art. 18 executável quando o
       autor saiu do escritório. */
    await expect(
      crm.removerAnotacao(processo.id, anotacao.id, { ...outro, papel: 'ADMIN' }),
    ).resolves.toEqual({ removida: true });
    expect(user.id).toBeDefined();
  });

  it('anotação de outro processo não é alcançável pela URL deste', async () => {
    const { org, autor } = await semearOrganizacao();
    const p1 = await semearProcesso({ organizationId: org.id });
    const p2 = await semearProcesso({ organizationId: org.id });
    const noP1 = await crm.criarAnotacao(p1.id, autor, { texto: 'do p1' });

    await expect(crm.editarAnotacao(p2.id, noP1.id, autor, { texto: 'x' })).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CRM — prioridade e timeline', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('mudar prioridade gera UM evento, com de/para', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    await crm.definirPrioridade(processo.id, autor, 'URGENTE');

    const eventos = await observador.eventoProcesso.findMany({ where: { processoId: processo.id } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].descricao).toBe('Prioridade alterada de normal para urgente');
    expect(eventos[0].detalhe).toEqual({ prioridade: { de: 'NORMAL', para: 'URGENTE' } });
  });

  it('repetir a MESMA prioridade não polui a timeline', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    await crm.definirPrioridade(processo.id, autor, 'ALTA');
    const segunda = await crm.definirPrioridade(processo.id, autor, 'ALTA');

    expect(segunda.alterado).toBe(false);
    expect(await observador.eventoProcesso.count({ where: { processoId: processo.id } })).toBe(1);
  });

  /**
   * O log é append-only: um NOME de funcionário gravado ali sobreviveria à saída
   * dele da empresa e a um pedido de exclusão DELE. Por isso só o UUID entra —
   * apagado o usuário, aponta para ninguém.
   */
  it('evento de responsável guarda UUID, nunca o nome', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const nome = (await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { nome: true },
    })).nome;

    await crm.definirResponsavel(processo.id, autor, user.id);

    const evento = await prisma.eventoProcesso.findFirstOrThrow({
      where: { processoId: processo.id, camposAlterados: { has: 'responsavelId' } },
    });
    expect(evento.descricao).toBe('Responsável atribuído');
    expect(JSON.stringify(evento)).not.toContain(nome);
    expect(evento.detalhe).toEqual({ responsavelId: { de: null, para: user.id } });
  });
});

describe('CRM — etiquetas', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('criar etiqueta repetida devolve a existente, sem estourar o unique', async () => {
    const { org } = await semearOrganizacao();
    const primeira = await crm.criarEtiqueta(org.id, { nome: '  Acordo   em  andamento ' });
    const segunda = await crm.criarEtiqueta(org.id, { nome: 'Acordo em andamento' });

    expect(primeira.nome).toBe('Acordo em andamento');
    expect(segunda.id).toBe(primeira.id);
    expect(await observador.etiqueta.count()).toBe(1);
  });

  /**
   * Validar dentro do laço deixaria o processo com METADE das etiquetas quando
   * uma delas fosse inválida — um estado que ninguém pediu.
   */
  it('etiqueta inválida no lote não aplica nenhuma', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const valida = await crm.criarEtiqueta(org.id, { nome: 'Válida' });

    await crm.definirEtiquetas(processo.id, autor, [valida.id]);
    await expect(
      crm.definirEtiquetas(processo.id, autor, [valida.id, OUTRO_TENANT]),
    ).rejects.toThrow(NotFoundException);

    // Continua com a aplicação anterior, intacta.
    expect(await prisma.processoEtiqueta.count({ where: { processoId: processo.id } })).toBe(1);
  });

  it('duplicata na lista não vira vínculo duplicado', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const e = await crm.criarEtiqueta(org.id, { nome: 'Uma' });

    await crm.definirEtiquetas(processo.id, autor, [e.id, e.id, e.id]);
    expect(await prisma.processoEtiqueta.count({ where: { processoId: processo.id } })).toBe(1);
  });

  /**
   * A falha mais grave que a auditoria encontrou, e a mais silenciosa.
   *
   * `ProcessoEtiqueta` só guarda (processoId, etiquetaId) — o tenant mora em
   * `Etiqueta.organizationId`. O `deleteMany` filtrava só por processo, então
   * salvar as etiquetas de um processo LIBERADO apagava as do time interno e as
   * dos outros clientes. Não era ataque: era o fluxo normal do produto.
   *
   * E era indiagnosticável dos dois lados, porque a LEITURA sempre foi escopada
   * — cada um via só as próprias sumirem, sem nada apontando para o outro.
   */
  it('cliente que salva etiquetas não destrói as dos outros tenants', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    const daCasa = await crm.criarEtiqueta(org.id, { nome: 'Triagem interna' });
    const doCliente = await crm.criarEtiqueta(cliente.org.id, { nome: 'Meu acordo' });

    await crm.definirEtiquetas(processo.id, autor, [daCasa.id]);
    await crm.definirEtiquetas(processo.id, cliente.autor, [doCliente.id]);

    /* Os dois convivem no MESMO processo. Antes da correção, o segundo salvar
       zerava o primeiro. */
    const todos = await prisma.processoEtiqueta.findMany({
      where: { processoId: processo.id },
      select: { etiquetaId: true },
    });
    expect(todos.map((t) => t.etiquetaId).sort()).toEqual([daCasa.id, doCliente.id].sort());
  });

  /**
   * O caso que escapava de TODA validação: com a lista vazia, o `if
   * (unicos.length > 0)` é pulado inteiro. Um cliente sem possuir etiqueta
   * alguma zerava a triagem interna do escritório.
   */
  it('lista vazia limpa só as próprias etiquetas', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    const daCasa = await crm.criarEtiqueta(org.id, { nome: 'Urgente interno' });
    await crm.definirEtiquetas(processo.id, autor, [daCasa.id]);

    const restou = await crm.definirEtiquetas(processo.id, cliente.autor, []);

    expect(restou).toHaveLength(0); // o cliente não tem etiqueta nenhuma
    expect(
      await prisma.processoEtiqueta.count({ where: { processoId: processo.id } }),
    ).toBe(1); // a do time interno continua lá
  });

  /* A leitura de retorno também é escopada: devolver a etiqueta alheia vazaria o
     vocabulário interno do outro tenant ("Cliente difícil", "Cobrar honorário"). */
  it('o retorno não mostra etiqueta de outro tenant', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    const daCasa = await crm.criarEtiqueta(org.id, { nome: 'Segredo interno' });
    await crm.definirEtiquetas(processo.id, autor, [daCasa.id]);

    const doCliente = await crm.criarEtiqueta(cliente.org.id, { nome: 'Minha' });
    const visto = await crm.definirEtiquetas(processo.id, cliente.autor, [doCliente.id]);

    expect(visto.map((v) => v.etiqueta.nome)).toEqual(['Minha']);
  });
});

/**
 * ── O FUNIL COMERCIAL ──
 *
 * Antes disto, "em que pé está este processo" vivia em anotação de texto livre e
 * em etiquetas. A informação existia e não SOMAVA: "quantos dos 250 deste mês
 * viraram proposta?" não tinha resposta possível.
 */
describe('CRM — funil e registro de contato', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('processo sem overlay começa em NOVO, e mover grava com data', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    const r = await crm.definirEstagio(processo.id, autor, { estagio: 'PROPOSTA' });

    expect(r).toEqual({ estagio: 'PROPOSTA', alterado: true });
    const overlay = await prisma.carteiraProcesso.findUniqueOrThrow({
      where: { organizationId_processoId: { organizationId: org.id, processoId: processo.id } },
    });
    expect(overlay.estagio).toBe('PROPOSTA');
    /* `estagioEm` é o que responde "parado há quantos dias" — a pergunta que
       separa um funil vivo de uma lista de intenções. */
    expect(overlay.estagioEm).not.toBeNull();
  });

  it('mover no funil escreve UM evento, com de/para, e sem dado pessoal', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    await crm.definirEstagio(processo.id, autor, { estagio: 'EM_CONTATO' });

    const eventos = await observador.eventoProcesso.findMany({ where: { processoId: processo.id } });
    expect(eventos).toHaveLength(1);
    expect(eventos[0].descricao).toBe('Funil: novo → em contato');
    expect(eventos[0].detalhe).toEqual({ estagio: { de: 'NOVO', para: 'EM_CONTATO' } });
    /* PRIVADO da org que escreveu: o funil de um cliente não pode aparecer na
       timeline do time interno nem na de outro cliente. */
    expect(eventos[0].organizationId).toBe(org.id);
  });

  it('repetir o MESMO estágio não polui a timeline', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    await crm.definirEstagio(processo.id, autor, { estagio: 'PROPOSTA' });
    const r = await crm.definirEstagio(processo.id, autor, { estagio: 'PROPOSTA' });

    expect(r.alterado).toBe(false);
    expect(await observador.eventoProcesso.count({ where: { processoId: processo.id } })).toBe(1);
  });

  /**
   * Sair de PERDIDO tem de LIMPAR o motivo. Deixá-lo para trás é o tipo de
   * resíduo que reaparece num relatório como se fosse atual — "perdido: titular
   * faleceu" num processo que está em proposta.
   */
  it('o motivo da perda só existe em PERDIDO, e sai ao mudar de estágio', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const chave = { organizationId_processoId: { organizationId: org.id, processoId: processo.id } };

    await crm.definirEstagio(processo.id, autor, {
      estagio: 'PERDIDO',
      motivoPerda: 'Titular já cedeu para outro escritório',
    });
    expect((await prisma.carteiraProcesso.findUniqueOrThrow({ where: chave })).motivoPerda).toBe(
      'Titular já cedeu para outro escritório',
    );

    await crm.definirEstagio(processo.id, autor, { estagio: 'EM_CONTATO' });
    expect((await prisma.carteiraProcesso.findUniqueOrThrow({ where: chave })).motivoPerda).toBeNull();
  });

  /**
   * "Novo" significa "ninguém tocou". Manter ali um processo que acabou de
   * receber uma ligação faria o funil mentir no primeiro dia de uso.
   */
  it('registrar contato tira o processo de NOVO — e só dele', async () => {
    const { org, autor } = await semearOrganizacao();
    const a = await semearProcesso({ organizationId: org.id });
    const b = await semearProcesso({ organizationId: org.id });

    const primeiro = await crm.registrarContato(a.id, autor, { resultado: 'NAO_ATENDEU' });
    expect(primeiro.estagio).toBe('EM_CONTATO');

    /* Já em PROPOSTA: uma ligação não faz o processo VOLTAR no funil. */
    await crm.definirEstagio(b.id, autor, { estagio: 'PROPOSTA' });
    const segundo = await crm.registrarContato(b.id, autor, { resultado: 'ATENDEU' });
    expect(segundo.estagio).toBe('PROPOSTA');
  });

  it('o contato grava canal, resultado e autor — e atualiza o último contato', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });

    const { contato } = await crm.registrarContato(processo.id, autor, {
      canal: 'WHATSAPP',
      resultado: 'RECADO',
      observacao: 'Falei com a filha, retorna às 18h',
    });

    expect(contato).toMatchObject({ canal: 'WHATSAPP', resultado: 'RECADO' });
    expect(contato.autor.id).toBe(autor.id);

    /* `ultimoContatoEm` é DENORMALIZADO e gravado na mesma transação: é ele que
       a fila de trabalho usa para "quem está há mais tempo sem ser tocado". */
    const overlay = await prisma.carteiraProcesso.findUniqueOrThrow({
      where: { organizationId_processoId: { organizationId: org.id, processoId: processo.id } },
    });
    expect(overlay.ultimoContatoEm).not.toBeNull();
  });

  /**
   * O contato que um escritório fez é trabalho comercial DELE. O escritório
   * vizinho que recebeu o mesmo precatório — o que acontece o tempo todo, já que
   * não há exclusividade — não pode ver com quem o outro falou.
   */
  it('o contato de um tenant é invisível para o outro no MESMO processo', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    await crm.registrarContato(processo.id, autor, {
      resultado: 'ATENDEU',
      observacao: 'segredo do time interno',
    });
    await crm.registrarContato(processo.id, cliente.autor, { resultado: 'NUMERO_ERRADO' });

    const doCliente = await crm.contatos(processo.id, cliente.autor);
    expect(doCliente).toHaveLength(1);
    expect(doCliente[0].resultado).toBe('NUMERO_ERRADO');

    const daCasa = await crm.contatos(processo.id, autor);
    expect(daCasa).toHaveLength(1);
    expect(daCasa[0].observacao).toBe('segredo do time interno');
  });

  it('o funil de um tenant não vê o estágio do outro no mesmo processo', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    await crm.definirEstagio(processo.id, autor, { estagio: 'FECHADO' });

    /* Para o cliente, o mesmo precatório continua intocado. */
    const doCliente = await crm.funil(cliente.autor);
    expect(doCliente).toMatchObject({ total: 1, NOVO: 1, FECHADO: 0 });
    expect((await crm.funil(autor)).FECHADO).toBe(1);
  });

  /**
   * Processo LIBERADO que nunca ganhou linha no overlay não aparece no
   * `groupBy` — e é o caso MAIS COMUM no começo do mês. Sem calcular NOVO por
   * diferença, a tela mostraria um funil que soma menos que a carteira, e
   * ninguém saberia onde foi parar o resto.
   */
  it('o funil SOMA a carteira inteira, mesmo com processos que ninguém tocou', async () => {
    const { org, autor } = await semearOrganizacao();
    const processos = [];
    for (let i = 0; i < 5; i++) processos.push(await semearProcesso({ organizationId: org.id }));

    await crm.definirEstagio(processos[0].id, autor, { estagio: 'PROPOSTA' });
    await crm.definirEstagio(processos[1].id, autor, { estagio: 'FECHADO' });

    const f = await crm.funil(autor);

    expect(f.total).toBe(5);
    expect(f.NOVO + f.EM_CONTATO + f.PROPOSTA + f.FECHADO + f.PERDIDO).toBe(5);
    expect(f).toMatchObject({ NOVO: 3, PROPOSTA: 1, FECHADO: 1 });
  });

  /**
   * O funil TEM de aceitar o mesmo recorte da fila.
   *
   * Sem isso, o total do funil conta a carteira inteira enquanto a fila mostra
   * um tribunal/exercício, e os dois números nunca fecham — foi assim que se
   * descobriu, com um cliente cujo funil dizia 500 e cuja fila dizia 183.
   */
  it('o funil aceita o recorte por lote, como a fila', async () => {
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    await semearProcesso({ organizationId: org.id, sigla: 'TRF1', exercicio: 2028 });

    expect((await crm.funil(autor)).total).toBe(3);
    expect((await crm.funil(autor, { lote: { tribunal: 'TRF5', exercicio: 2027 } })).total).toBe(2);
    expect((await crm.funil(autor, { lote: { tribunal: 'TRF1', exercicio: 2028 } })).total).toBe(1);
  });

  it('semContato conta quem nunca recebeu uma tentativa — inclusive quem só foi triado', async () => {
    const { org, autor } = await semearOrganizacao();
    const a = await semearProcesso({ organizationId: org.id });
    const b = await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });

    /* `b` foi TRIADO (ganhou estágio), mas ninguém ligou para ele: continua
       contando como "sem contato". Triar não é trabalhar. */
    await crm.definirEstagio(b.id, autor, { estagio: 'PROPOSTA' });
    await crm.registrarContato(a.id, autor, { resultado: 'ATENDEU' });

    expect((await crm.funil(autor)).semContato).toBe(2);
  });

  it('estágio e contato recusam processo de outra organização', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const intruso = { ...autor, organizationId: OUTRO_TENANT };

    await expect(
      crm.definirEstagio(processo.id, intruso, { estagio: 'FECHADO' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      crm.registrarContato(processo.id, intruso, { resultado: 'ATENDEU' }),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * ── DOIS ESCRITÓRIOS SOBRE O MESMO PROCESSO ──
 *
 * Os casos acima usam um tenant que NÃO enxerga o processo, e por isso não
 * alcançavam o buraco real: como não há exclusividade, o mesmo precatório é
 * liberado a vários clientes de propósito, e `processoVisivel` responde SIM aos
 * dois. Era só isso que separava a anotação de um da mão do outro — o resto era
 * o UUID não ser adivinhável. Aqui a trava passa a ser trava, e não sorte.
 */
describe('CRM — dois escritórios enxergando o MESMO processo', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  async function doisEscritorios() {
    const { org } = await semearOrganizacao();
    const processo = await semearProcesso({ organizationId: org.id });
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    await liberarProcesso(a.org.id, processo.id);
    await liberarProcesso(b.org.id, processo.id);
    return { processo, a, b };
  }

  it('B não edita nem apaga a anotação de A', async () => {
    const { processo, a, b } = await doisEscritorios();
    const anotacao = await crm.criarAnotacao(processo.id, a.autor, { texto: 'ligar após as 18h' });

    /* B ENXERGA o processo — é o que torna o caso perigoso, e o que faz o 404
       abaixo significar "não é seu", e não "não existe para você". */
    await expect(crm.contatos(processo.id, b.autor)).resolves.toBeDefined();

    await expect(
      crm.editarAnotacao(processo.id, anotacao.id, b.autor, { texto: 'sequestrado' }),
    ).rejects.toThrow(NotFoundException);
    await expect(crm.removerAnotacao(processo.id, anotacao.id, b.autor)).rejects.toThrow(
      NotFoundException,
    );

    /* Nem o ADMIN de B: administrador é papel DENTRO de um inquilino. A regra
       que deixa ADMIN apagar anotação alheia existe para atender pedido de
       exclusão do titular — no escritório dele. */
    const adminDeB = { ...b.autor, papel: 'ADMIN' as const };
    await expect(crm.removerAnotacao(processo.id, anotacao.id, adminDeB)).rejects.toThrow(
      NotFoundException,
    );

    const viva = await prisma.anotacaoProcesso.findUnique({ where: { id: anotacao.id } });
    expect(viva?.texto).toBe('ligar após as 18h');
  });

  it('B não edita, atribui, conclui nem apaga a tarefa de A', async () => {
    /* O pior dos dois: `editarTarefa` não checa autoria de propósito ("tarefa é
       trabalho combinado do time"). Sem o tenant, esse time incluía o
       concorrente. */
    const { processo, a, b } = await doisEscritorios();
    const tarefa = await crm.criarTarefa(processo.id, a.autor, { titulo: 'Ligar para o titular' });

    await expect(
      crm.editarTarefa(processo.id, tarefa.id, b.autor, { titulo: 'não é sua' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      crm.editarTarefa(processo.id, tarefa.id, b.autor, { concluida: true }),
    ).rejects.toThrow(NotFoundException);
    await expect(crm.removerTarefa(processo.id, tarefa.id, b.autor)).rejects.toThrow(
      NotFoundException,
    );

    const viva = await prisma.tarefaProcesso.findUnique({ where: { id: tarefa.id } });
    expect(viva?.titulo).toBe('Ligar para o titular');
    expect(viva?.concluidaEm).toBeNull();
  });

  it('CONTRAPONTO: dentro do MESMO escritório, o colega continua trabalhando a tarefa', async () => {
    /* Sem este caso, fechar a porta para todo mundo passaria como conserto — e
       quebraria o uso normal, que é justamente outra pessoa concluir o que foi
       atribuído a ela. */
    const { processo, a } = await doisEscritorios();
    const tarefa = await crm.criarTarefa(processo.id, a.autor, { titulo: 'Ligar' });
    const colega = await prisma.user.create({
      data: {
        organizationId: a.org.id,
        email: `colega+${a.org.id.slice(0, 8)}@teste.local`,
        nome: 'Colega',
        papel: 'CLIENTE',
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });
    const autorColega = { ...a.autor, id: colega.id };

    await expect(
      crm.editarTarefa(processo.id, tarefa.id, autorColega, { concluida: true }),
    ).resolves.toBeDefined();
    const feita = await prisma.tarefaProcesso.findUnique({ where: { id: tarefa.id } });
    expect(feita?.concluidaEm).not.toBeNull();
  });
});
