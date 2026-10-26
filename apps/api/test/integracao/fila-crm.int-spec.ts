import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CarteiraService } from '../../src/modules/carteira/carteira.service';
import { CrmService } from '../../src/modules/crm/crm.service';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  liberarProcesso,
  encerrar,
} from './ambiente';

const carteira = new CarteiraService(prisma as never);
const crm = new CrmService(prisma as never);


const LOTE = { tribunal: 'TRF5', exercicio: 2027 };

const pedir = (usuario: unknown, extra: Record<string, unknown> = {}) =>
  carteira.fila({
    pagina: 1,
    porPagina: 50,
    lote: LOTE,
    usuario: usuario as never,
    ...extra,
  });

/**
 * ── A FILA DE TRABALHO ──
 *
 * A tela de UM processo já era rica. O que faltava era trabalhar a carteira como
 * LISTA: chegam 250 processos no dia 1º e, para tocá-los, era preciso abrir um a
 * um sem saber quais já tinham sido trabalhados.
 */
describe('CRM — fila de trabalho', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('processo sem overlay entra na fila com os padrões explícitos', async () => {
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, valor: 500 });

    const r = await pedir(autor);

    expect(r.total).toBe(1);
    /* A tela não pode precisar SABER que ausência de linha significa "novo". */
    expect(r.itens[0]).toMatchObject({
      estagio: 'NOVO',
      prioridade: 'NORMAL',
      responsavel: null,
      ultimoContatoEm: null,
      tarefasAbertas: 0,
      tarefasAtrasadas: 0,
    });
  });

  /**
   * A ARMADILHA que o `filtroDeOverlay` existe para fechar: um `some` ingênuo
   * deixaria de fora todo processo que ninguém tocou — e o filtro "novos"
   * mostraria ZERO no começo do mês, que é quando ele mais importa.
   */
  it('filtrar por NOVO inclui os processos que nunca ganharam overlay', async () => {
    const { org, autor } = await semearOrganizacao();
    const intocado = await semearProcesso({ organizationId: org.id, valor: 100 });
    const tocado = await semearProcesso({ organizationId: org.id, valor: 200 });
    await crm.definirEstagio(tocado.id, autor, { estagio: 'PROPOSTA' });

    const novos = await pedir(autor, { estagio: 'NOVO' });

    expect(novos.total).toBe(1);
    expect(novos.itens[0].id).toBe(intocado.id);
  });

  it('"ainda sem contato" também inclui quem só foi triado', async () => {
    const { org, autor } = await semearOrganizacao();
    const intocado = await semearProcesso({ organizationId: org.id, valor: 100 });
    const soTriado = await semearProcesso({ organizationId: org.id, valor: 200 });
    const contatado = await semearProcesso({ organizationId: org.id, valor: 300 });
    /* Triar NÃO é trabalhar: ganhar prioridade não tira ninguém da fila de
       "precisa de uma ligação". */
    await crm.definirPrioridade(soTriado.id, autor, 'ALTA');
    await crm.registrarContato(contatado.id, autor, { resultado: 'ATENDEU' });

    const r = await pedir(autor, { semContato: true });

    expect(r.itens.map((i) => i.id).sort()).toEqual([intocado.id, soTriado.id].sort());
  });

  it('filtra por responsável, e "nenhum" traz os órfãos', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const meu = await semearProcesso({ organizationId: org.id, valor: 100 });
    const orfao = await semearProcesso({ organizationId: org.id, valor: 200 });
    await crm.definirResponsavel(meu.id, autor, user.id);

    expect((await pedir(autor, { responsavelId: user.id })).itens.map((i) => i.id)).toEqual([meu.id]);
    expect((await pedir(autor, { responsavelId: 'nenhum' })).itens.map((i) => i.id)).toEqual([
      orfao.id,
    ]);
  });

  /**
   * No multi-tenant, um processo liberado a dois clientes tem tarefas dos dois.
   * A fila de um não pode acender por causa do atraso do outro.
   */
  it('tarefa atrasada só conta a da PRÓPRIA organização', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id, valor: 100 });
    await liberarProcesso(cliente.org.id, processo.id);

    const ontem = new Date();
    ontem.setUTCDate(ontem.getUTCDate() - 5);
    await crm.criarTarefa(processo.id, cliente.autor, {
      titulo: 'Ligar',
      prazo: ontem.toISOString().slice(0, 10),
    });

    /* A tarefa atrasada é do CLIENTE: a fila dele acende, a do time interno não. */
    expect((await pedir(cliente.autor, { tarefaAtrasada: true })).total).toBe(1);
    expect((await pedir(autor, { tarefaAtrasada: true })).total).toBe(0);
  });

  it('o cliente só vê na fila o que foi liberado a ele', async () => {
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    const liberado = await semearProcesso({ organizationId: org.id, valor: 100 });
    await semearProcesso({ organizationId: org.id, valor: 999 });
    await liberarProcesso(cliente.org.id, liberado.id);

    const r = await pedir(cliente.autor);

    expect(r.total).toBe(1);
    expect(r.itens[0].id).toBe(liberado.id);
  });

  /**
   * Em Postgres, ORDER BY ... DESC coloca NULL PRIMEIRO. Sem `nulls: 'last'`, o
   * precatório sem valor lançado lideraria a fila de trabalho — o oposto da
   * régua "comece pelo dinheiro".
   */
  it('ordena por valor, e o processo sem valor não toma o topo', async () => {
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id, valor: null });
    await semearProcesso({ organizationId: org.id, valor: 100 });
    await semearProcesso({ organizationId: org.id, valor: 900 });

    const r = await pedir(autor);

    expect(r.itens.map((i) => i.valor)).toEqual(['900', '100', null]);
  });

  it('estágio inválido não é ignorado em silêncio', async () => {
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id });
    /* O serviço aceita o valor tipado; quem recusa texto livre é o controller.
       Aqui se afere que um filtro DESCONHECIDO não devolve a carteira inteira. */
    const r = await pedir(autor, { estagio: 'FECHADO' });
    expect(r.total).toBe(0);
  });
});

describe('CRM — ação em massa', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  it('aplica a todos, e conta quantos de fato MUDARAM', async () => {
    const { org, autor } = await semearOrganizacao();
    const a = await semearProcesso({ organizationId: org.id });
    const b = await semearProcesso({ organizationId: org.id });
    const c = await semearProcesso({ organizationId: org.id });
    /* `c` já está em ALTA: aplicar ALTA aos três não pode contar como três
       alterações nem escrever três linhas de histórico. */
    await crm.definirPrioridade(c.id, autor, 'ALTA');

    const r = await crm.acaoEmLote(autor, {
      processoIds: [a.id, b.id, c.id],
      prioridade: 'ALTA',
    });

    expect(r).toMatchObject({ pedidos: 3, aplicados: 3, alterados: 2, ignorados: 0 });
    /* Autor INTERNO: a prioridade dele mora na coluna do Processo. Conferir o
       overlay aqui passaria à toa — `every` sobre lista vazia é verdadeiro. */
    const processos = await prisma.processo.findMany({ where: { organizationId: org.id } });
    expect(processos.map((p) => p.prioridade)).toEqual(['ALTA', 'ALTA', 'ALTA']);
  });

  /**
   * A lista vem de uma tela que pode estar desatualizada. Recusar TUDO por causa
   * de um id obsoleto faria o operador refazer a seleção inteira sem entender
   * por quê — então os invisíveis são ignorados e CONTADOS.
   */
  it('id de outro tenant é ignorado e contado, sem derrubar o lote', async () => {
    const { org, autor } = await semearOrganizacao();
    const outra = await semearCliente('Escritório Vizinho');
    const meu = await semearProcesso({ organizationId: org.id });
    /* Processo que EXISTE e pertence a outro tenant — o caso perigoso de
       verdade, e não um uuid inventado que nem chave estrangeira tem. */
    const alheio = await semearProcesso({ organizationId: outra.org.id });

    const r = await crm.acaoEmLote(autor, {
      processoIds: [meu.id, alheio.id],
      estagio: 'EM_CONTATO',
    });

    expect(r).toMatchObject({ pedidos: 2, aplicados: 1, ignorados: 1 });
    /* E o alheio continua intocado. */
    expect(
      await observador.carteiraProcesso.count({ where: { processoId: alheio.id } }),
    ).toBe(0);
  });

  it('nenhum processo visível é 404, não um lote vazio silencioso', async () => {
    const { autor } = await semearOrganizacao();
    const outra = await semearCliente('Escritório Vizinho');
    const alheio = await semearProcesso({ organizationId: outra.org.id });

    await expect(
      crm.acaoEmLote(autor, { processoIds: [alheio.id], estagio: 'FECHADO' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('o evento diz que veio de uma ação EM LOTE', async () => {
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.acaoEmLote(autor, { processoIds: [p.id], estagio: 'PROPOSTA' });

    const [evento] = await observador.eventoProcesso.findMany({ where: { processoId: p.id } });
    /* Quem lê a timeline meses depois precisa distinguir uma decisão sobre ESTE
       processo de uma varrida sobre duzentos. */
    expect(evento.descricao).toContain('Em lote');
    expect(evento.organizationId).toBe(org.id);
  });

  it('marcar PERDIDO em massa grava o motivo informado', async () => {
    /**
     * Antes do conserto isto era IMPOSSÍVEL: `acaoEmLote` gravava
     * `motivoPerda: null` incondicionalmente, e o formulário nem tinha o campo.
     * Marcar 200 processos como perdidos não deixava registrar por quê — e "por
     * que perdemos" é a pergunta mais acionável do funil inteiro.
     */
    const { org, autor } = await semearOrganizacao();
    const p1 = await semearProcesso({ organizationId: org.id });
    const p2 = await semearProcesso({ organizationId: org.id });

    await crm.acaoEmLote(autor, {
      processoIds: [p1.id, p2.id],
      estagio: 'PERDIDO',
      motivoPerda: 'lote sem telefone válido',
    });

    const overlays = await prisma.carteiraProcesso.findMany({
      where: { organizationId: org.id, processoId: { in: [p1.id, p2.id] } },
      select: { estagio: true, motivoPerda: true },
    });
    expect(overlays).toHaveLength(2);
    expect(overlays.every((o) => o.estagio === 'PERDIDO')).toBe(true);
    expect(overlays.every((o) => o.motivoPerda === 'lote sem telefone válido')).toBe(true);
  });

  it('sair de PERDIDO limpa o motivo — mas quem já estava lá não é apagado', async () => {
    const { org, autor } = await semearOrganizacao();
    const volta = await semearProcesso({ organizationId: org.id });
    const fica = await semearProcesso({ organizationId: org.id });

    await crm.acaoEmLote(autor, {
      processoIds: [volta.id, fica.id],
      estagio: 'PERDIDO',
      motivoPerda: 'sem retorno em três tentativas',
    });

    /* Só um deles volta para PROPOSTA. O outro é REMARCADO como PERDIDO na
       mesma varrida — e, como já estava nesse estágio, o overlay dele não é
       tocado e o motivo escrito sobrevive. */
    await crm.acaoEmLote(autor, { processoIds: [volta.id], estagio: 'PROPOSTA' });
    await crm.acaoEmLote(autor, { processoIds: [fica.id], estagio: 'PERDIDO' });

    const depois = await prisma.carteiraProcesso.findMany({
      where: { organizationId: org.id, processoId: { in: [volta.id, fica.id] } },
      select: { processoId: true, estagio: true, motivoPerda: true },
    });
    const oVolta = depois.find((d) => d.processoId === volta.id)!;
    const oFica = depois.find((d) => d.processoId === fica.id)!;

    /* Motivo de perda em processo que voltou a negociar seria uma justificativa
       velha reaparecendo em relatório como se fosse atual. */
    expect(oVolta.estagio).toBe('PROPOSTA');
    expect(oVolta.motivoPerda).toBeNull();
    expect(oFica.motivoPerda).toBe('sem retorno em três tentativas');
  });

  it('o motivo da perda NÃO vai para a timeline', async () => {
    /* EventoProcesso é append-only e não se apaga a pedido do titular. Texto
       livre ali dentro é dado pessoal que a exclusão não alcança. */
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.acaoEmLote(autor, {
      processoIds: [p.id],
      estagio: 'PERDIDO',
      motivoPerda: 'filha informou que o titular faleceu',
    });

    const eventos = await observador.eventoProcesso.findMany({ where: { processoId: p.id } });
    const cru = JSON.stringify(eventos);
    expect(cru).not.toContain('faleceu');
    expect(cru).not.toContain('filha');
  });

  it('o evento em lote grava o DE/PARA em campo, e não só na frase', async () => {
    /**
     * A rota individual sempre gravou `detalhe: { estagio: { de, para } }`. A
     * ação em massa, não — e ela é justamente a que move 250 processos de uma
     * vez. Qualquer pergunta futura do tipo "quanto tempo fica em PROPOSTA"
     * teria de ignorar as varridas, que são a maioria dos movimentos.
     */
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.definirEstagio(p.id, autor, { estagio: 'EM_CONTATO' });
    await crm.acaoEmLote(autor, { processoIds: [p.id], estagio: 'PROPOSTA', prioridade: 'ALTA' });

    const eventos = await observador.eventoProcesso.findMany({
      where: { processoId: p.id },
      orderBy: { criadoEm: 'asc' },
    });
    const detalhe = eventos.at(-1)!.detalhe as {
      emLote?: boolean;
      estagio?: { de: string; para: string };
      prioridade?: { de: string; para: string };
    };

    expect(detalhe.emLote).toBe(true);
    expect(detalhe.estagio).toEqual({ de: 'EM_CONTATO', para: 'PROPOSTA' });
    expect(detalhe.prioridade).toEqual({ de: 'NORMAL', para: 'ALTA' });

    /* Enum e id apenas: EventoProcesso é append-only e não se apaga a pedido do
       titular. É a mesma razão de o motivo da perda ficar de fora daqui. */
    expect(JSON.stringify(detalhe)).not.toMatch(/[a-z]+@|\d{11}|R\$/);
  });

  /**
   * O `PUT` de etiquetas do processo individual SUBSTITUI o conjunto. Fazer isso
   * em massa apagaria a triagem que alguém já tinha feito em cada um deles.
   */
  it('etiqueta em massa ACRESCENTA, nunca substitui', async () => {
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });
    const antiga = await crm.criarEtiqueta(org.id, { nome: 'Já tinha' });
    const nova = await crm.criarEtiqueta(org.id, { nome: 'Do lote' });
    await crm.definirEtiquetas(p.id, autor, [antiga.id]);

    await crm.acaoEmLote(autor, { processoIds: [p.id], etiquetaIds: [nova.id] });

    const vinculos = await prisma.processoEtiqueta.findMany({ where: { processoId: p.id } });
    expect(vinculos.map((v) => v.etiquetaId).sort()).toEqual([antiga.id, nova.id].sort());
  });

  it('etiqueta de outra organização é recusada', async () => {
    const { org, autor } = await semearOrganizacao();
    const cliente = await semearCliente();
    const p = await semearProcesso({ organizationId: org.id });
    const alheia = await crm.criarEtiqueta(cliente.org.id, { nome: 'Deles' });

    await expect(
      crm.acaoEmLote(autor, { processoIds: [p.id], etiquetaIds: [alheia.id] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('lote sem alteração pedida é recusado', async () => {
    const { org, autor } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await expect(crm.acaoEmLote(autor, { processoIds: [p.id] })).rejects.toThrow(
      BadRequestException,
    );
  });

  /**
   * O teto não é limitação de recurso: é o tamanho do ERRO possível. Marcar a
   * carteira inteira como PERDIDO num clique é o desastre que ele evita.
   */
  it('acima do teto de 500 é recusado', async () => {
    const { autor } = await semearOrganizacao();
    const ids = Array.from(
      { length: 501 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );

    await expect(crm.acaoEmLote(autor, { processoIds: ids, estagio: 'FECHADO' })).rejects.toThrow(
      /até 500 processos/,
    );
  });

  it('remover responsável em massa é possível, e é diferente de não mexer', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });
    await crm.definirResponsavel(p.id, autor, user.id);

    /* `responsavelId: null` REMOVE; ausente não mexe. São coisas diferentes, e
       sem a distinção "tirar o dono de 40 processos" seria inexprimível. */
    await crm.acaoEmLote(autor, { processoIds: [p.id], responsavelId: null });

    const depois = await prisma.processo.findUniqueOrThrow({ where: { id: p.id } });
    expect(depois.responsavelId).toBeNull();
  });

  /**
   * ── A DUALIDADE, NOS DOIS LADOS ──
   *
   * Prioridade e responsável têm DUAS fontes de verdade, de propósito: o time
   * interno usa as colunas do próprio Processo, o cliente usa o overlay dele. A
   * ação em massa tem de respeitar isso — escrever tudo no overlay seria mais
   * simples e faria o mesmo botão gravar em lugares diferentes conforme o
   * operador clicasse num processo ou em vinte.
   *
   * Foi este teste que pegou o defeito: a primeira versão lia só o overlay, e a
   * triagem do time interno ficava invisível para a própria fila dele.
   */
  it('a ação em massa grava onde CADA lado guarda a sua triagem', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const cliente = await semearCliente();
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(cliente.org.id, processo.id);

    await crm.acaoEmLote(autor, { processoIds: [processo.id], prioridade: 'URGENTE' });
    await crm.acaoEmLote(cliente.autor, { processoIds: [processo.id], prioridade: 'BAIXA' });

    /* O time interno escreveu na coluna do processo… */
    const doProcesso = await prisma.processo.findUniqueOrThrow({ where: { id: processo.id } });
    expect(doProcesso.prioridade).toBe('URGENTE');

    /* …e o cliente, no overlay DELE. Uma não sobrescreveu a outra. */
    const doCliente = await prisma.carteiraProcesso.findUniqueOrThrow({
      where: {
        organizationId_processoId: { organizationId: cliente.org.id, processoId: processo.id },
      },
    });
    expect(doCliente.prioridade).toBe('BAIXA');

    /* E cada fila mostra a sua. */
    expect((await pedir(autor)).itens[0].prioridade).toBe('URGENTE');
    expect((await pedir(cliente.autor)).itens[0].prioridade).toBe('BAIXA');
    void user;
  });
});

/**
 * ── O CHIP E A LISTA SÃO O MESMO RECORTE ──
 *
 * O número dentro do chip e a lista abaixo dele nascem da MESMA montagem de
 * `where` (condicoes-da-fila.ts). Estes casos existem para que a igualdade seja
 * verificada, e não confiada: um total que contradiz a lista não é informação,
 * é ruído — e o cliente que vê isso não reporta um bug, conclui que o sistema
 * mente.
 */
describe('CRM — funil e fila fecham entre si', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('com filtro de responsável ligado, o funil conta o que a fila mostra', async () => {
    const { org, autor, user } = await semearOrganizacao();
    const colega = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `colega+${org.id.slice(0, 8)}@teste.local`,
        nome: 'Colega',
        papel: 'OPERADOR',
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });

    const meus = [
      await semearProcesso({ organizationId: org.id }),
      await semearProcesso({ organizationId: org.id }),
    ];
    const dele = await semearProcesso({ organizationId: org.id });
    for (const p of meus) await crm.definirResponsavel(p.id, autor, user.id);
    await crm.definirResponsavel(dele.id, autor, colega.id);
    await crm.definirEstagio(meus[0].id, autor, { estagio: 'PROPOSTA' });

    const filtros = { responsavelId: user.id };
    const f = await crm.funil(autor, { filtros });
    const lista = await carteira.fila({ ...filtros, pagina: 1, porPagina: 50, usuario: autor });

    /* Sem os filtros no funil, este `total` seria 3 e a lista teria 2. */
    expect(f.total).toBe(2);
    expect(lista.total).toBe(2);
    expect(f.NOVO + f.EM_CONTATO + f.PROPOSTA + f.FECHADO + f.PERDIDO).toBe(lista.total);
  });

  it('clicar num estágio NÃO zera os outros chips', async () => {
    /* O recorte de estágio é da LISTA. Se o estoque o obedecesse, filtrar por
       "Proposta" mostraria "Novos 0" e o operador perderia a referência de onde
       está — e voltaria a clicar em cada chip só para descobrir os números. */
    const { org, autor } = await semearOrganizacao();
    const a = await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });
    await crm.definirEstagio(a.id, autor, { estagio: 'PROPOSTA' });

    const comChip = await crm.funil(autor, { filtros: { estagio: 'PROPOSTA' } });

    expect(comChip.total).toBe(2);
    expect(comChip.PROPOSTA).toBe(1);
    expect(comChip.NOVO).toBe(1);
  });

  it('o movimento conta só quem mudou de estágio DENTRO da janela', async () => {
    const { org, autor } = await semearOrganizacao();
    const recente = await semearProcesso({ organizationId: org.id });
    const antigo = await semearProcesso({ organizationId: org.id });
    await crm.definirEstagio(recente.id, autor, { estagio: 'PROPOSTA' });
    await crm.definirEstagio(antigo.id, autor, { estagio: 'PROPOSTA' });

    /* Recua o carimbo por escrita direta: não há como voltar o relógio pelos
       serviços, e é a data que este teste existe para exercitar. */
    await prisma.carteiraProcesso.update({
      where: { organizationId_processoId: { organizationId: org.id, processoId: antigo.id } },
      data: { estagioEm: new Date(Date.now() - 40 * 86_400_000) },
    });

    const f = await crm.funil(autor, { dias: 30 });

    /* O ESTOQUE não tem janela: os dois continuam em proposta. */
    expect(f.PROPOSTA).toBe(2);
    /* O MOVIMENTO tem: só um se mexeu nos últimos 30 dias. */
    expect(f.movimento.PROPOSTA).toBe(1);
    expect(f.movimento.dias).toBe(30);
  });

  it('processo que NINGUÉM tocou não entra no movimento', async () => {
    /**
     * A regressão mais provável desta etapa: o estoque de NOVO é calculado por
     * DIFERENÇA (linha ausente = ninguém tocou). Copiar essa ideia para o
     * movimento faria toda a carteira intocada contar como "movimentou" — o
     * oposto exato do que a palavra significa.
     */
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });
    await semearProcesso({ organizationId: org.id });

    const f = await crm.funil(autor);

    expect(f.NOVO).toBe(3);
    expect(f.movimento.NOVO).toBe(0);
    expect(f.movimento.EM_CONTATO).toBe(0);
  });

  it('TRIAR não é MOVIMENTAR', async () => {
    /* Definir prioridade ou responsável cria a linha do overlay sem carimbar
       `estagioEm`. Se carimbasse, "movimento" viraria "alguém mexeu em algo", e
       o número perderia o sentido comercial que justifica existir. */
    const { org, autor, user } = await semearOrganizacao();
    const p = await semearProcesso({ organizationId: org.id });

    await crm.definirPrioridade(p.id, autor, 'URGENTE');
    await crm.definirResponsavel(p.id, autor, user.id);

    const f = await crm.funil(autor);
    expect(f.movimento.NOVO).toBe(0);
  });

  it('o movimento de um escritório não aparece no do outro', async () => {
    const { org } = await semearOrganizacao();
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    const processo = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(a.org.id, processo.id);
    await liberarProcesso(b.org.id, processo.id);

    await crm.definirEstagio(processo.id, a.autor, { estagio: 'FECHADO' });

    /* O MESMO precatório: fechado para A, intocado para B. */
    expect((await crm.funil(a.autor)).movimento.FECHADO).toBe(1);
    expect((await crm.funil(b.autor)).movimento.FECHADO).toBe(0);
    expect((await crm.funil(b.autor)).NOVO).toBe(1);
  });

  it('a safra agrupa pela COMPETÊNCIA do ciclo, não pela data de liberação', async () => {
    /**
     * `gerarLote` permite regerar um mês passado. Nesse caso `liberadoEm` é HOJE
     * e `competencia` é o mês antigo — agrupar pela data de liberação jogaria um
     * ciclo inteiro na safra errada, e o dono veria um mês inflado e outro
     * mutilado sem nada explicando por quê.
     *
     * Este teste cria exatamente essa situação: os dois processos são liberados
     * AGORA, em competências diferentes.
     */
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const deMarco = await semearProcesso({ organizationId: org.id });
    const deAbril = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(c.org.id, deMarco.id, '2026-03-01T00:00:00.000Z');
    await liberarProcesso(c.org.id, deAbril.id, '2026-04-01T00:00:00.000Z');

    const s = await crm.safras(c.autor);

    expect(s).toHaveLength(2);
    /* Mais recente primeiro: é a safra em que se trabalha. */
    expect(s[0].competencia.toISOString().slice(0, 7)).toBe('2026-04');
    expect(s[1].competencia.toISOString().slice(0, 7)).toBe('2026-03');
    expect(s[0].liberados).toBe(1);
    expect(s[1].liberados).toBe(1);
  });

  it('a safra conta o estágio de HOJE, e o intocado entra como NOVO', async () => {
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const fechado = await semearProcesso({ organizationId: org.id });
    const intocado = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(c.org.id, fechado.id, '2026-03-01T00:00:00.000Z');
    await liberarProcesso(c.org.id, intocado.id, '2026-03-01T00:00:00.000Z');
    await crm.definirEstagio(fechado.id, c.autor, { estagio: 'FECHADO' });

    const [marco] = await crm.safras(c.autor);

    expect(marco.liberados).toBe(2);
    expect(marco.FECHADO).toBe(1);
    /* Sem o LEFT JOIN, o processo que ninguém tocou sumiria da safra — e ele é
       a maior parte dela no começo do mês. */
    expect(marco.NOVO).toBe(1);
    expect(marco.NOVO + marco.EM_CONTATO + marco.PROPOSTA + marco.FECHADO + marco.PERDIDO).toBe(
      marco.liberados,
    );
  });

  it('a safra diz quantos dela caem no lote em foco', async () => {
    /* O sorteio do ciclo NÃO filtra por tribunal. Sem este número, o dono
       compararia "2 liberados" com uma fila de 1 e concluiria que sumiu um. */
    const { org } = await semearOrganizacao();
    const c = await semearCliente();
    const noFoco = await semearProcesso({ organizationId: org.id, sigla: 'TRF5', exercicio: 2027 });
    const fora = await semearProcesso({ organizationId: org.id, sigla: 'TRF1', exercicio: 2028 });
    await liberarProcesso(c.org.id, noFoco.id, '2026-03-01T00:00:00.000Z');
    await liberarProcesso(c.org.id, fora.id, '2026-03-01T00:00:00.000Z');

    const semLote = await crm.safras(c.autor);
    const comLote = await crm.safras(c.autor, { lote: { tribunal: 'TRF5', exercicio: 2027 } });

    /* O total do ciclo NÃO muda com o recorte — a safra é a safra. */
    expect(semLote[0].liberados).toBe(2);
    expect(comLote[0].liberados).toBe(2);
    /* O que muda é quantos dela a tela está mostrando. */
    expect(semLote[0].noRecorte).toBe(2);
    expect(comLote[0].noRecorte).toBe(1);
  });

  it('a safra de um escritório não enxerga a do outro', async () => {
    const { org } = await semearOrganizacao();
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    const p = await semearProcesso({ organizationId: org.id });
    await liberarProcesso(a.org.id, p.id, '2026-03-01T00:00:00.000Z');
    await crm.definirEstagio(p.id, a.autor, { estagio: 'FECHADO' });

    expect((await crm.safras(a.autor))[0].FECHADO).toBe(1);
    /* B nem tem safra: não recebeu nada. */
    expect(await crm.safras(b.autor)).toHaveLength(0);
  });

  it('a organização INTERNA não tem safra — é ela quem libera', async () => {
    const { org, autor } = await semearOrganizacao();
    await semearProcesso({ organizationId: org.id });

    /* Lista vazia, não erro: a tela do sócio mostra o funil e o movimento, e
       simplesmente não mostra o bloco de safras. */
    expect(await crm.safras(autor)).toEqual([]);
  });

  it('os motivos de perda saem escritos, do mais recente para o mais antigo', async () => {
    const { org, autor } = await semearOrganizacao();
    const p1 = await semearProcesso({ organizationId: org.id });
    const p2 = await semearProcesso({ organizationId: org.id });
    const semMotivo = await semearProcesso({ organizationId: org.id });

    await crm.definirEstagio(p1.id, autor, { estagio: 'PERDIDO', motivoPerda: 'já cedeu a outro' });
    await crm.definirEstagio(p2.id, autor, { estagio: 'PERDIDO', motivoPerda: 'telefone errado' });
    await crm.definirEstagio(semMotivo.id, autor, { estagio: 'PERDIDO' });

    const perdas = await crm.perdas(autor);

    /* Só quem TEM motivo: uma lista com linhas vazias sugeriria que o motivo se
       perdeu, quando ninguém escreveu. */
    expect(perdas).toHaveLength(2);
    expect(perdas.map((p) => p.motivo)).toContain('telefone errado');
    expect(perdas[0].numeroPrecatorio).toBeTruthy();
  });

  it('"frio há mais de N dias" inclui quem NUNCA foi tocado e exclui os resolvidos', async () => {
    const { org, autor } = await semearOrganizacao();
    const nunca = await semearProcesso({ organizationId: org.id });
    const frio = await semearProcesso({ organizationId: org.id });
    const quente = await semearProcesso({ organizationId: org.id });
    const fechado = await semearProcesso({ organizationId: org.id });

    await crm.registrarContato(frio.id, autor, { resultado: 'NAO_ATENDEU' });
    await crm.registrarContato(quente.id, autor, { resultado: 'ATENDEU' });
    await crm.registrarContato(fechado.id, autor, { resultado: 'ATENDEU' });
    await crm.definirEstagio(fechado.id, autor, { estagio: 'FECHADO' });

    const recuar = (id: string, dias: number) =>
      prisma.carteiraProcesso.update({
        where: { organizationId_processoId: { organizationId: org.id, processoId: id } },
        data: { ultimoContatoEm: new Date(Date.now() - dias * 86_400_000) },
      });
    await recuar(frio.id, 20);
    await recuar(fechado.id, 40);

    const r = await carteira.fila({ frioDias: 15, pagina: 1, porPagina: 50, usuario: autor });
    const ids = r.itens.map((i) => i.id);

    /* Quem nunca recebeu uma ligação está frio há MAIS tempo, não menos. */
    expect(ids).toContain(nunca.id);
    expect(ids).toContain(frio.id);
    expect(ids).not.toContain(quente.id);
    /* Fechado há 40 dias não está frio: está RESOLVIDO. */
    expect(ids).not.toContain(fechado.id);
  });
});
