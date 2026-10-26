import { TitularService } from '../../src/modules/titular/titular.service';
import { RetencaoAgendada } from '../../src/modules/titular/retencao.agendada';
import { FilaService } from '../../src/modules/fila/fila.service';
import { EnriquecimentoProcessor } from '../../src/modules/fila/enriquecimento.processor';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  encerrar,
} from './ambiente';

const titular = new TitularService(prisma as never);

/** ConfigService mínimo: devolve o número de dias que o caso quiser. */
const configCom = (dias: number) => ({ get: () => dias }) as never;

/**
 * Exclusão a pedido do titular (LGPD art. 18) e retenção do dado bruto.
 *
 * A asserção que sustenta tudo é a última: a exclusão precisa SOBREVIVER ao
 * ciclo de enriquecimento. Apagar as linhas e deixar a pessoa elegível à fila
 * é uma exclusão que dura até o próximo domingo.
 */
describe('Titular — direitos sobre os próprios dados', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /** Uma pessoa com contato e histórico, como o enriquecimento a deixa. */
  async function pessoaEnriquecida(cpf = '39053344705') {
    const pessoa = await prisma.pessoa.create({
      data: {
        cpf,
        nome: 'MARIA DE SOUZA',
        nomeNormalizado: 'MARIA DE SOUZA',
        statusEnriquecimento: 'SINCRONIZADO',
        ultimaSincronizacao: new Date(),
        dataNascimento: new Date('1970-05-02'),
        nomeMae: 'JOANA DE SOUZA',
        situacaoCadastral: 'REGULAR',
        telefones: { create: [{ ddd: '81', numero: '999998888', tipo: 'MOVEL' }] },
        emails: { create: [{ endereco: 'maria@exemplo.com.br' }] },
        enderecos: { create: [{ logradouro: 'Rua A', cidade: 'Recife', uf: 'PE' }] },
      },
      select: { id: true },
    });
    await prisma.enriquecimento.create({
      data: {
        pessoaId: pessoa.id,
        provider: 'CONTACTRA',
        versao: 1,
        status: 'SUCESSO',
        custoCreditos: 0.2,
        /* A resposta CRUA — o ponto cego que uma exclusão ingênua deixaria. */
        dadosBrutos: {
          telefones: [{ ddd: '81', numero: '999998888' }],
          emails: ['maria@exemplo.com.br'],
          enderecos: [{ logradouro: 'Rua A' }],
        },
      },
    });
    return pessoa;
  }

  it('apaga contato, dados derivados E a resposta crua do provedor', async () => {
    const p = await pessoaEnriquecida();

    const r = await titular.excluir('39053344705', 'pedido por e-mail', 'admin-1');

    expect(r.jaEstavaExcluido).toBe(false);
    expect(r.apagados).toMatchObject({ telefones: 1, emails: 1, enderecos: 1, respostasDoProvedor: 1 });

    expect(await prisma.telefone.count({ where: { pessoaId: p.id } })).toBe(0);
    expect(await prisma.email.count({ where: { pessoaId: p.id } })).toBe(0);
    expect(await prisma.endereco.count({ where: { pessoaId: p.id } })).toBe(0);

    const pessoa = await prisma.pessoa.findUniqueOrThrow({
      where: { id: p.id },
      select: {
        cpf: true,
        nome: true,
        dataNascimento: true,
        nomeMae: true,
        situacaoCadastral: true,
        statusEnriquecimento: true,
        exclusaoEm: true,
        exclusaoMotivo: true,
      },
    });
    expect(pessoa.dataNascimento).toBeNull();
    expect(pessoa.nomeMae).toBeNull();
    expect(pessoa.situacaoCadastral).toBeNull();
    expect(pessoa.statusEnriquecimento).toBe('EXCLUIDO');
    expect(pessoa.exclusaoEm).not.toBeNull();
    expect(pessoa.exclusaoMotivo).toBe('pedido por e-mail');

    /* CPF e nome FICAM: vêm do precatório, que é ato público. Apagá-los
       desligaria a pessoa do processo e quebraria a carteira. */
    expect(pessoa.cpf).toBe('39053344705');
    expect(pessoa.nome).toBe('MARIA DE SOUZA');
  });

  it('a exclusão de fachada é impossível: o payload do provedor some', async () => {
    /**
     * Apagar só telefones/e-mails/endereços deixaria a resposta crua intacta,
     * com TUDO dentro. O teste procura o dado onde ele realmente se esconde.
     */
    const p = await pessoaEnriquecida();

    await titular.excluir('39053344705', 'pedido', 'admin-1');

    const consultas = await prisma.enriquecimento.findMany({
      where: { pessoaId: p.id },
      select: { id: true, dadosBrutos: true, custoCreditos: true, status: true },
    });
    // A LINHA fica — é a prova de que consultamos, e a conferência da fatura.
    expect(consultas).toHaveLength(1);
    expect(consultas[0].status).toBe('SUCESSO');
    expect(consultas[0].custoCreditos).not.toBeNull();
    // O CONTEÚDO, não.
    expect(consultas[0].dadosBrutos).toBeNull();

    const cru = JSON.stringify(consultas);
    expect(cru).not.toContain('999998888');
    expect(cru).not.toContain('maria@exemplo.com.br');
  });

  /**
   * ── A ASSERÇÃO QUE SUSTENTA A EXCLUSÃO ──
   *
   * Sem estado terminal, o cron pegaria a pessoa no ciclo seguinte (ele busca
   * PENDENTE, ERRO e SINCRONIZADO vencido) e o provedor reporia tudo. A
   * exclusão duraria até a próxima madrugada.
   */
  /**
   * ── R-02 DA AUDITORIA LGPD ──
   *
   * `ImportacaoLinha.dadosBrutos` guarda a linha INTEIRA como veio do tribunal
   * e nunca era apagada por ninguém — nem por prazo, nem pela exclusão. Era a
   * maior cópia integral de dado pessoal do sistema, com o CPF indexado, e a
   * exclusão declarava-se cumprida com ela intacta.
   *
   * O caso cobre as DUAS linhas de propósito: a que conciliou (tem `pessoaId`)
   * e a que falhou (tem `pessoaId` nulo e o CPF só na coluna e no payload). Um
   * filtro por `pessoaId`, que é o instinto, deixaria a segunda para trás — e a
   * linha que falhou é justamente a que ninguém revisita.
   */
  it('a exclusão alcança a PLANILHA CRUA, inclusive a linha que não conciliou', async () => {
    const { org, user } = await semearOrganizacao();
    const cpf = '39053344705';
    const pessoa = await pessoaEnriquecida(cpf);

    const imp = await prisma.importacao.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        arquivoNome: 'TRF5 2027.xlsx',
        arquivoHash: `hash-${Date.now()}`,
        arquivoTipo: 'xlsx',
        status: 'CONCLUIDA',
        totalLinhas: 2,
      },
      select: { id: true },
    });
    await prisma.importacaoLinha.createMany({
      data: [
        {
          importacaoId: imp.id,
          numeroLinha: 1,
          status: 'OK',
          pessoaId: pessoa.id,
          cpf,
          dadosBrutos: { NOME: 'MARIA DE SOUZA', CPF: cpf, VALOR: '12345,67' },
        },
        {
          importacaoId: imp.id,
          numeroLinha: 2,
          status: 'ERRO',
          cpf,
          mensagemErro: `Titular MARIA DE SOUZA (${cpf}) sem processo correspondente`,
          dadosBrutos: { NOME: 'MARIA DE SOUZA', CPF: cpf },
        },
      ],
    });

    const r = await titular.excluir(cpf, 'pedido do titular', user.id);
    expect(r.apagados.linhasDePlanilha).toBe(2);

    const linhas = await prisma.importacaoLinha.findMany({
      where: { importacaoId: imp.id },
      orderBy: { numeroLinha: 'asc' },
      select: { cpf: true, dadosBrutos: true, mensagemErro: true, status: true },
    });

    /* A LINHA fica: é o registro de que a planilha teve duas, e uma falhou.
       Some o CONTEÚDO — mesma fronteira do payload do provedor. */
    expect(linhas).toHaveLength(2);
    expect(linhas.map((l) => l.status)).toEqual(['OK', 'ERRO']);
    for (const l of linhas) {
      expect(l.cpf).toBeNull();
      expect(l.mensagemErro).toBeNull();
      expect(l.dadosBrutos).toEqual({});
      expect(JSON.stringify(l.dadosBrutos)).not.toContain('MARIA');
      expect(JSON.stringify(l.dadosBrutos)).not.toContain(cpf);
    }
  });

  it('quem foi excluído NUNCA volta para a fila de enriquecimento', async () => {
    const p = await pessoaEnriquecida();
    await titular.excluir('39053344705', 'pedido', 'admin-1');

    /* A fila de verdade, com um Queue dublê: o que se afere é a SELEÇÃO no
       banco, não o transporte. `enfileirarLote` registra o que passou. */
    const enfileirados: string[] = [];
    const filaDuble = {
      addBulk: async (jobs: { data: { pessoaId: string } }[]) => {
        jobs.forEach((j) => enfileirados.push(j.data.pessoaId));
        return jobs;
      },
      add: async () => ({}),
    } as never;

    /* O segundo Queue é o da IMPORTAÇÃO (B5). O FilaService o injeta, mas
       `enfileirarPendentes` não o toca — o mesmo dublê serve para os dois. */
    await new FilaService(filaDuble, filaDuble, prisma as never).enfileirarPendentes(1000);

    expect(enfileirados).not.toContain(p.id);
  });

  it('quem já estava NA FILA quando pediu exclusão não chega ao provedor pago', async () => {
    /**
     * A SEGUNDA METADE DA MESMA GARANTIA, e a que faltava.
     *
     * O caso acima prova a SELEÇÃO: quem foi excluído não é escolhido para
     * entrar na fila. Isso não cobre quem JÁ estava lá dentro — e o intervalo é
     * real: o cron enfileira 500 por vez e a fila drena devagar, então passam
     * horas entre enfileirar e processar.
     *
     * Antes, o job carregava o CPF no próprio corpo: chegada a vez dele, o
     * worker consultaria a Contactra — consulta PAGA — e traria de volta
     * telefone, e-mail e endereço de quem tinha acabado de mandar apagar. O
     * `excluir` limpa o banco e não tinha como alcançar o que já estava no
     * Redis.
     *
     * Agora o CPF é lido do banco na hora do uso, e é aqui que a exclusão passa
     * a valer também para trabalho já enfileirado. O que este caso afere não é o
     * status devolvido: é o provedor NÃO ter sido chamado.
     *
     * ⚠ A pessoa é criada CRUA de propósito, sem passar pelo
     * `pessoaEnriquecida()`. Aquele helper grava um enriquecimento bem-sucedido
     * HOJE, e a checagem de idempotência do processor roda antes desta guarda —
     * o job sairia como JA_SINCRONIZADO_HOJE e o teste passaria sem exercitar
     * nada. Não há problema nessa ordem em produção (nenhum dos dois caminhos
     * chama o provedor), mas o caso que precisa de prova é o do acúmulo da
     * fila: quem ainda NÃO foi consultado hoje.
     */
    const p = await prisma.pessoa.create({
      data: { cpf: '39053344705', nome: 'MARIA DE SOUZA', nomeNormalizado: 'MARIA DE SOUZA' },
      select: { id: true },
    });
    await titular.excluir('39053344705', 'pedido', 'admin-1');

    const consultas: string[] = [];
    const provedor = {
      nome: 'CONTACTRA',
      consultarPorCpf: async (cpf: string) => {
        consultas.push(cpf);
        return { status: 'SUCESSO' as const, pessoa: null, custoCreditos: 1 };
      },
    };
    const processor = new EnriquecimentoProcessor(
      prisma as never,
      { get: (_c: string, padrao?: unknown) => padrao } as never,
      provedor as never,
      { garantirDisponibilidade: async () => undefined } as never,
    );

    const r = await processor.process({ data: { pessoaId: p.id }, id: 'job-1' } as never);

    expect(r.status).toBe('TITULAR_EXCLUIDO');
    expect(consultas).toEqual([]);
  });

  it('CONTRAPONTO: quem NÃO foi excluído continua entrando na fila', async () => {
    /* Sem este caso, um bug que esvaziasse a fila inteira passaria como
       "exclusão funcionando". */
    const pendente = await prisma.pessoa.create({
      data: { cpf: '52998224725', nome: 'JOAO', nomeNormalizado: 'JOAO' },
      select: { id: true },
    });

    const enfileirados: string[] = [];
    const filaDuble = {
      addBulk: async (jobs: { data: { pessoaId: string } }[]) => {
        jobs.forEach((j) => enfileirados.push(j.data.pessoaId));
        return jobs;
      },
      add: async () => ({}),
    } as never;

    /* O segundo Queue é o da IMPORTAÇÃO (B5). O FilaService o injeta, mas
       `enfileirarPendentes` não o toca — o mesmo dublê serve para os dois. */
    await new FilaService(filaDuble, filaDuble, prisma as never).enfileirarPendentes(1000);

    expect(enfileirados).toContain(pendente.id);
  });

  it('repetir o pedido não é erro, e não apaga duas vezes', async () => {
    await pessoaEnriquecida();
    const primeira = await titular.excluir('39053344705', 'pedido', 'admin-1');
    const segunda = await titular.excluir('39053344705', 'pedido de novo', 'admin-1');

    expect(primeira.jaEstavaExcluido).toBe(false);
    expect(segunda.jaEstavaExcluido).toBe(true);
    /* A data do PRIMEIRO atendimento é a que vale — é ela que se apresenta. */
    expect(segunda.exclusaoEm).toEqual(primeira.exclusaoEm);
  });

  /**
   * ── O TEXTO QUE A EQUIPE DIGITA ──
   *
   * Os casos acima cobrem o dado que o PROVEDOR trouxe. Este cobre o outro, que
   * não vem de sistema nenhum: o que um advogado escreve num campo livre. A
   * exclusão se declarava cumprida com ele intacto no banco — e é onde cabe
   * qualquer coisa, inclusive o telefone que acabou de ser apagado da tabela de
   * telefones.
   */
  it('a exclusão alcança o texto livre do CRM, e preserva o FATO', async () => {
    const p = await pessoaEnriquecida();

    const org = await prisma.organization.create({
      data: { nome: 'Escritório', tipo: 'INTERNA', cnpj: `${Date.now()}`.slice(-14) },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `adv+${org.id.slice(0, 8)}@teste.local`,
        nome: 'Advogado',
        papel: 'ADMIN',
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });
    const tribunal = await prisma.tribunal.findUniqueOrThrow({ where: { sigla: 'TRF5' } });
    const processo = await prisma.processo.create({
      data: {
        numeroPrecatorio: `lgpd-${Date.now()}`,
        tribunalId: tribunal.id,
        organizationId: org.id,
        fase: 'PRECATORIO_EXPEDIDO',
        exercicio: 2027,
        entidadeDevedora: 'INSS',
        valor: 1000,
        partes: {
          create: { pessoaId: p.id, observacoes: 'atende só à tarde, filha 81 999998888' },
        },
      },
      select: { id: true },
    });

    await prisma.contatoProcesso.create({
      data: {
        processoId: processo.id,
        organizationId: org.id,
        autorId: user.id,
        canal: 'TELEFONE',
        resultado: 'ATENDEU',
        observacao: 'falei com a filha, 81 999998888',
      },
    });
    await prisma.anotacaoProcesso.create({
      data: {
        processoId: processo.id,
        organizationId: org.id,
        autorId: user.id,
        texto: 'internado no Hospital X desde 04/2026',
      },
    });
    await prisma.tarefaProcesso.create({
      data: {
        processoId: processo.id,
        organizationId: org.id,
        criadoPorId: user.id,
        titulo: 'Ligar para MARIA no 81 999998888',
      },
    });
    await prisma.carteiraProcesso.create({
      data: {
        organizationId: org.id,
        processoId: processo.id,
        estagio: 'PERDIDO',
        motivoPerda: 'titular internado, família não quer negociar',
      },
    });

    const r = await titular.excluir('39053344705', 'pedido', 'admin-1');

    expect(r.apagados).toMatchObject({
      observacoesDaParte: 1,
      observacoesDeContato: 1,
      anotacoes: 1,
      tarefasAnonimizadas: 1,
      motivosDePerda: 1,
    });

    const parte = await prisma.processoPessoa.findFirstOrThrow({ where: { pessoaId: p.id } });
    const contato = await prisma.contatoProcesso.findFirstOrThrow({
      where: { processoId: processo.id },
    });
    const tarefa = await prisma.tarefaProcesso.findFirstOrThrow({
      where: { processoId: processo.id },
    });
    const overlay = await prisma.carteiraProcesso.findFirstOrThrow({
      where: { processoId: processo.id },
    });

    expect(parte.observacoes).toBeNull();
    expect(contato.observacao).toBeNull();
    expect(tarefa.titulo).toMatch(/removido a pedido do titular/);
    expect(overlay.motivoPerda).toBeNull();
    expect(await observador.anotacaoProcesso.count({ where: { processoId: processo.id } })).toBe(0);

    /* O FATO fica: canal, resultado e estágio são a métrica do escritório e não
       dizem nada sobre a pessoa além de que se tentou falar com ela. A tarefa
       sobrevive como compromisso — some o texto, não o combinado. */
    expect(contato.canal).toBe('TELEFONE');
    expect(contato.resultado).toBe('ATENDEU');
    expect(overlay.estagio).toBe('PERDIDO');
    expect(await observador.tarefaProcesso.count({ where: { processoId: processo.id } })).toBe(1);

    /* A varredura que não depende de eu ter lembrado de cada campo: o telefone
       apagado não pode ter sobrado escrito em lugar nenhum do CRM. */
    const tudo = JSON.stringify([parte, contato, tarefa, overlay]);
    expect(tudo).not.toContain('999998888');
    expect(tudo).not.toContain('Hospital X');
  });

  it('a exclusão trata cada estado de proposta de um jeito, e o motivo é jurídico', async () => {
    /**
     * ACEITA é contrato executado: prova do que o próprio titular assinou, e
     * apagá-la destruiria a evidência de um acordo que ele fez.
     * RECUSADA é oferta que ninguém assinou: a linha fica (para "quantas
     * propostas até um sim" continuar existindo), os VALORES não — preservá-los
     * deixaria para sempre quanto foi oferecido a uma pessoa identificável.
     * Rascunho, substituída e cancelada não são fato jurídico nenhum.
     */
    const p = await pessoaEnriquecida();
    const org = await prisma.organization.create({
      data: { nome: 'Escritório', tipo: 'INTERNA', cnpj: `${Date.now()}`.slice(-14) },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `adv2+${org.id.slice(0, 8)}@teste.local`,
        nome: 'Advogado',
        papel: 'ADMIN',
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });
    const tribunal = await prisma.tribunal.findUniqueOrThrow({ where: { sigla: 'TRF5' } });
    const processo = await prisma.processo.create({
      data: {
        numeroPrecatorio: `neg-${Date.now()}`,
        tribunalId: tribunal.id,
        organizationId: org.id,
        fase: 'PRECATORIO_EXPEDIDO',
        exercicio: 2027,
        entidadeDevedora: 'INSS',
        valor: 1000,
        partes: { create: { pessoaId: p.id, valorIndividual: 1000000 } },
      },
      select: { id: true },
    });

    const comum = {
      organizationId: org.id,
      processoId: processo.id,
      autorId: user.id,
      modalidade: 'CESSAO' as const,
      valorProposto: 300000,
      baseValor: 1000000,
      observacao: 'titular disse que a filha decide',
    };
    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 1, status: 'SUBSTITUIDA' } });
    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 2, status: 'RECUSADA' } });
    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 3, status: 'ACEITA' } });

    /* Parcelas sob a ACEITA (contrato executado) e sob a RECUSADA (oferta que
       ninguém assinou). A regra que zera os valores da recusada tem de alcançar
       o cronograma dela também — senão o dinheiro oferecido continuaria escrito
       linha a linha, exatamente o que a pessoa pediu para apagar. */
    const propostas = await observador.propostaNegociacao.findMany({
      where: { processoId: processo.id },
      select: { id: true, status: true },
    });
    for (const prop of propostas) {
      await prisma.parcelaCessao.create({
        data: {
          propostaId: prop.id,
          processoId: processo.id,
          organizationId: org.id,
          numero: 1,
          valor: 150000,
          vencimento: new Date('2026-09-10'),
        },
      });
    }

    const r = await titular.excluir('39053344705', 'pedido', 'admin-1');

    expect(r.apagados).toMatchObject({ propostasApagadas: 1, propostasComValoresLimpos: 1 });

    const parcelas = await observador.parcelaCessao.findMany({
      where: { processoId: processo.id },
      include: { proposta: { select: { status: true } } },
    });
    /* Sobra UMA: a do contrato executado. As da substituída sumiram por CASCADE
       junto com a proposta; a da recusada foi apagada por regra. */
    expect(parcelas).toHaveLength(1);
    expect(parcelas[0].proposta.status).toBe('ACEITA');

    const restantes = await observador.propostaNegociacao.findMany({
      where: { processoId: processo.id },
      orderBy: { rodada: 'asc' },
    });
    expect(restantes.map((x) => x.status)).toEqual(['RECUSADA', 'ACEITA']);

    const recusada = restantes[0];
    const aceita = restantes[1];
    /* Recusada: a linha prova que houve tentativa; os números somem. */
    expect(recusada.valorProposto).toBeNull();
    expect(recusada.baseValor).toBeNull();
    /* Aceita: contrato executado, fica inteira. */
    expect(aceita.valorProposto?.toString()).toBe('300000');

    /* O texto livre some das DUAS: é onde cabe qualquer coisa. */
    expect(restantes.every((x) => x.observacao === null)).toBe(true);
    expect(JSON.stringify(restantes)).not.toContain('filha');
  });

  /**
   * ── R-06 DA AUDITORIA LGPD: ACESSO E PORTABILIDADE (art. 18, II e V) ──
   *
   * A Política prometia os dois; o produto só sabia contar. O que este caso
   * fixa é sobretudo a FRONTEIRA — o que sai, e principalmente o que NÃO sai.
   */
  /** Libera um processo para um escritório — a cadeia inteira, como em produção. */
  async function liberarPara(organizationId: string, processoId: string) {
    const plano = await prisma.plano.create({
      data: { nome: `Plano ${Math.random().toString(36).slice(2, 8)}`, processosPorCiclo: 10, preco: 0 },
      select: { id: true },
    });
    const assinatura = await prisma.assinatura.create({
      data: { organizationId, planoId: plano.id, status: 'ATIVA' },
      select: { id: true },
    });
    const lote = await prisma.loteAssinatura.create({
      data: { assinaturaId: assinatura.id, competencia: new Date('2026-08-01'), quantidadeAlvo: 10 },
      select: { id: true },
    });
    /* `loteId` é obrigatório: a liberação SEMPRE nasce de um ciclo, e o schema
       não deixa fabricar uma solta. Descobri escrevendo este teste, e é uma boa
       trava — liberação órfã não teria como aparecer no histórico do cliente. */
    await prisma.processoLiberado.create({ data: { organizationId, processoId, loteId: lote.id } });
  }

  it('devolve os dados do titular, e diz quais escritórios receberam o processo', async () => {
    const { org, user } = await semearOrganizacao();
    const escritorio = await semearCliente('Escritório Alfa');
    const pessoa = await pessoaEnriquecida('39053344705');

    const processo = await semearProcesso({ organizationId: org.id, valor: 5000 });
    await prisma.processoPessoa.create({
      data: { processoId: processo.id, pessoaId: pessoa.id, valorIndividual: 3000 },
    });
    /* Um co-titular no MESMO processo, com valor próprio: é o que prova que a
       exportação não entrega dado de outra pessoa junto. */
    const outro = await prisma.pessoa.create({
      data: { cpf: '11144477735', nome: 'JOAO DA SILVA', nomeNormalizado: 'JOAO DA SILVA' },
      select: { id: true },
    });
    await prisma.processoPessoa.create({
      data: { processoId: processo.id, pessoaId: outro.id, valorIndividual: 2000 },
    });
    await liberarPara(escritorio.org.id, processo.id);

    const r = await titular.dados('39053344705', { id: user.id, organizationId: org.id });

    expect(r.identificacao.nome).toBe('MARIA DE SOUZA');
    expect(r.identificacao.nomeMae).toBe('JOANA DE SOUZA');
    expect(r.contatos.telefones).toHaveLength(1);
    expect(r.contatos.emails[0].endereco).toBe('maria@exemplo.com.br');
    expect(r.origemDosDados.consultasAoProvedor).toHaveLength(1);
    expect(r.origemDosDados.consultasAoProvedor[0].provedor).toBe('CONTACTRA');

    expect(r.processos).toHaveLength(1);
    expect(r.processos[0].valorIndividual).toBe(3000);
    /* Art. 18, VII — com quem compartilhamos. É a resposta que mais surpreende
       quem pede acesso, e a única que o sistema pode dar com data. */
    expect(r.processos[0].escritoriosQueReceberam).toEqual([
      { escritorio: 'Escritório Alfa', recebidoEm: expect.any(Date) },
    ]);

    /* O valor do CO-TITULAR não pode aparecer em lugar nenhum do documento. */
    expect(JSON.stringify(r)).not.toContain('2000');
    expect(JSON.stringify(r)).not.toContain('JOAO DA SILVA');
  });

  it('a resposta CRUA do provedor nunca sai — só a existência da consulta', async () => {
    /* `dadosBrutos` traz gente que não é ela (o provedor devolve relacionados),
       é cópia do que já virou telefone/e-mail/endereço, e é o que a retenção
       apaga aos 180 dias. Entregá-lo seria desfazer as três decisões de uma vez. */
    const { org, user } = await semearOrganizacao();
    const pessoa = await pessoaEnriquecida('39053344705');
    /* Uma consulta cujo payload traz PARENTE — que é o que o provedor devolve
       de verdade junto com o titular. Marcador único de propósito: o endereço
       "Rua A" da fixture existe também na tabela de endereços, e é devolvido
       com razão (é dela). Medir por ele não provaria nada. */
    await prisma.enriquecimento.create({
      data: {
        pessoaId: pessoa.id,
        provider: 'CONTACTRA',
        versao: 2,
        status: 'SUCESSO',
        dadosBrutos: {
          relacionados: [{ nome: 'PARENTE QUE NAO PEDIU NADA', cpf: '11144477735' }],
        },
      },
    });

    const r = await titular.dados('39053344705', { id: user.id, organizationId: org.id });

    expect(JSON.stringify(r)).not.toContain('dadosBrutos');
    expect(JSON.stringify(r)).not.toContain('PARENTE QUE NAO PEDIU NADA');
    expect(JSON.stringify(r)).not.toContain('11144477735');
    /* Mas a EXISTÊNCIA das duas consultas sai: é o que presta contas. */
    expect(r.origemDosDados.consultasAoProvedor).toHaveLength(2);
  });

  it('o texto livre do escritório NÃO é devolvido — a caneta é dele', async () => {
    /* Parece incoerente com a exclusão, que APAGA esse texto, e não é: na
       exclusão alcançamos porque ele fala dela; no acesso, devolvê-lo seria
       entregar o trabalho de um terceiro em nome dele. O escritório é
       controlador do que digitou, e é a ele que esse pedido se dirige. */
    const { org, user } = await semearOrganizacao();
    const escritorio = await semearCliente('Escritório Alfa');
    const pessoa = await pessoaEnriquecida('39053344705');
    const processo = await semearProcesso({ organizationId: org.id, valor: 100 });
    await prisma.processoPessoa.create({ data: { processoId: processo.id, pessoaId: pessoa.id } });
    await prisma.anotacaoProcesso.create({
      data: {
        processoId: processo.id,
        organizationId: escritorio.org.id,
        autorId: escritorio.user.id,
        texto: 'SEGREDO DO ESCRITORIO: ela está internada',
      },
    });

    const r = await titular.dados('39053344705', { id: user.id, organizationId: org.id });

    expect(JSON.stringify(r)).not.toContain('SEGREDO DO ESCRITORIO');
    expect(JSON.stringify(r)).not.toContain('internada');
  });

  it('a trilha do atendimento guarda CONTAGENS, nunca o conteúdo entregue', async () => {
    /* `excluir` não toca em `audit_logs`. Um telefone gravado nesta trilha
       sobreviveria ao pedido de exclusão — a rota de acesso derrubaria a de
       apagar. Por isso só número entra aqui. */
    const { org, user } = await semearOrganizacao();
    await pessoaEnriquecida('39053344705');

    await titular.dados('39053344705', { id: user.id, organizationId: org.id });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { acao: 'ACESSO_TITULAR' } });
    expect(log.userId).toBe(user.id);
    expect(JSON.stringify(log.dadosAntes)).not.toContain('999998888');
    expect(JSON.stringify(log.dadosAntes)).not.toContain('maria@exemplo.com.br');
    expect(log.dadosAntes).toMatchObject({ telefones: 1, emails: 1, enderecos: 1 });
  });

  it('CPF que não está na base responde 404, não sucesso vazio', async () => {
    await expect(titular.excluir('52998224725', 'pedido', 'admin-1')).rejects.toThrow(/Nenhum titular/);
  });

  it('a situação denuncia exclusão de fachada antes de alguém confiar nela', async () => {
    await pessoaEnriquecida();

    const antes = await titular.situacao('39053344705');
    expect(antes.excluido).toBe(false);
    expect(antes.contatos).toEqual({ telefones: 1, emails: 1, enderecos: 1 });
    expect(antes.consultasComRespostaGuardada).toBe(1);

    await titular.excluir('39053344705', 'pedido', 'admin-1');

    const depois = await titular.situacao('39053344705');
    expect(depois.excluido).toBe(true);
    expect(depois.contatos).toEqual({ telefones: 0, emails: 0, enderecos: 0 });
    // Continua havendo consulta registrada, mas nenhuma com conteúdo guardado.
    expect(depois.consultas).toBe(1);
    expect(depois.consultasComRespostaGuardada).toBe(0);
  });
});

describe('Retenção do dado bruto do provedor', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  async function consultaEm(diasAtras: number, cpf: string) {
    const pessoa = await prisma.pessoa.create({
      data: { cpf, nome: 'X', nomeNormalizado: 'X' },
      select: { id: true },
    });
    const quando = new Date(Date.now() - diasAtras * 86_400_000);
    await prisma.enriquecimento.create({
      data: {
        pessoaId: pessoa.id,
        versao: 1,
        status: 'SUCESSO',
        dadosBrutos: { telefone: '81999998888' },
        criadoEm: quando,
      },
    });
    return pessoa;
  }

  it('descarta o conteúdo das consultas antigas e preserva a linha', async () => {
    const velha = await consultaEm(200, '39053344705');
    const nova = await consultaEm(10, '52998224725');

    const r = await new RetencaoAgendada(prisma as never, configCom(180)).executar('teste');

    expect(r.limpos).toBe(1);
    /* A linha sobrevive: é a trilha e a conferência da fatura do provedor. */
    expect(await prisma.enriquecimento.count()).toBe(2);

    const daVelha = await prisma.enriquecimento.findFirstOrThrow({ where: { pessoaId: velha.id } });
    const daNova = await prisma.enriquecimento.findFirstOrThrow({ where: { pessoaId: nova.id } });
    expect(daVelha.dadosBrutos).toBeNull();
    expect(daNova.dadosBrutos).not.toBeNull();
  });

  it('rodar de novo não reescreve o que já foi limpo', async () => {
    /* Sem o filtro `dadosBrutos NOT NULL`, o UPDATE tocaria todas as linhas
       antigas toda madrugada — escrita à toa numa tabela que só cresce. */
    await consultaEm(200, '39053344705');
    const job = new RetencaoAgendada(prisma as never, configCom(180));

    expect((await job.executar('teste')).limpos).toBe(1);
    expect((await job.executar('teste')).limpos).toBe(0);
  });

  it('retenção em 0 desliga a limpeza, em vez de apagar tudo', async () => {
    /* A leitura ingênua de "0 dias" seria "apague tudo agora". Aqui 0 é
       DESLIGADO — a diferença entre desativar um recurso e destruir a base. */
    await consultaEm(500, '39053344705');

    const r = await new RetencaoAgendada(prisma as never, configCom(0)).executar('teste');

    expect(r.limpos).toBe(0);
    expect(r.motivo).toMatch(/desligada/);
    expect(
      (await prisma.enriquecimento.findFirstOrThrow({ select: { dadosBrutos: true } })).dadosBrutos,
    ).not.toBeNull();
  });
});
