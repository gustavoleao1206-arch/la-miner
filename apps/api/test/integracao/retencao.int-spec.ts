import { RetencaoAgendada } from '../../src/modules/auditoria/retencao.agendada';
import { anonimizarIp } from '../../src/common/ip';
import { encerrar, limparDados, prisma, semearOrganizacao } from './ambiente';

/**
 * A POLÍTICA DE RETENÇÃO, provada contra o banco.
 *
 * O que se fixa: o corte respeita o PISO LEGAL (registros de acesso ficam
 * inteiros por 180 dias, art. 15 do Marco Civil), o que passou do prazo perde
 * IP e user agent SEM perder a linha do evento, e token expirado some depois de
 * 30 dias — enquanto o revogado-mas-válido, que denuncia roubo, fica.
 */
const configDe = (valores: Record<string, unknown>) =>
  ({ get: (chave: string, padrao?: unknown) => valores[chave] ?? padrao }) as never;

const DIA = 86_400_000;
const AGORA = new Date('2026-08-21T12:00:00.000Z');
const haDias = (n: number) => new Date(AGORA.getTime() - n * DIA);

describe('Retenção de IP e user agent', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('registro de acesso com menos de 180 dias fica INTEIRO — é obrigação do Marco Civil', async () => {
    const { user, org } = await semearOrganizacao();
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        acao: 'LOGIN',
        ip: '203.0.113.163',
        userAgent: 'Mozilla/5.0',
        criadoEm: haDias(179),
      },
    });

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const log = await prisma.auditLog.findFirstOrThrow({ where: { acao: 'LOGIN' } });
    expect(log.ip).toBe('203.0.113.163');
    expect(log.userAgent).toBe('Mozilla/5.0');
  });

  it('passado o prazo, IP e user agent viram nulo e o EVENTO continua lá', async () => {
    const { user, org } = await semearOrganizacao();
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        acao: 'LOGIN',
        ip: '203.0.113.163',
        userAgent: 'Mozilla/5.0',
        criadoEm: haDias(181),
      },
    });

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    expect(r.auditoriaAnonimizada).toBe(1);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { acao: 'LOGIN' } });
    /* A linha sobrevive: "houve um login neste dia" segue auditável. */
    expect(log.ip).toBeNull();
    expect(log.userAgent).toBeNull();
    expect(log.userId).toBe(user.id);
  });

  it('a trilha de consulta (quem olhou qual CPF) segue a mesma régua', async () => {
    const { user } = await semearOrganizacao();
    /* Buscadas por ID, e não pelo termo: o termo da linha antiga é descartado
       nesta mesma execução (prazo próprio, mais curto), então procurar por ele
       não acharia nada. O teste antigo fazia isso e quebrou — de propósito. */
    const antigaId = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'CPF', termo: '123', ip: '10.0.0.0', userAgent: 'x', criadoEm: haDias(200) },
        select: { id: true },
      })
    ).id;
    const recenteId = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'CPF', termo: '456', ip: '10.0.0.0', userAgent: 'x', criadoEm: haDias(10) },
        select: { id: true },
      })
    ).id;

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const [antiga, recente] = await Promise.all([
      prisma.consultaCliente.findUniqueOrThrow({ where: { id: antigaId } }),
      prisma.consultaCliente.findUniqueOrThrow({ where: { id: recenteId } }),
    ]);
    expect(antiga.ip).toBeNull();
    expect(antiga.userId).toBe(user.id); // a prestação de contas fica
    expect(recente.ip).toBe('10.0.0.0');
  });

  it('token EXPIRADO há mais de 30 dias é apagado; revogado-mas-válido fica', async () => {
    const { user } = await semearOrganizacao();
    const familia = '33333333-3333-4333-8333-333333333333';
    await prisma.refreshToken.createMany({
      data: [
        { userId: user.id, tokenHash: 'morto', familiaId: familia, expiraEm: haDias(31), ip: '1.1.1.1' },
        { userId: user.id, tokenHash: 'recem-expirado', familiaId: familia, expiraEm: haDias(5), ip: '1.1.1.1' },
        /* Revogado mas ainda dentro da validade: é o que denuncia reuso. */
        { userId: user.id, tokenHash: 'revogado-vivo', familiaId: familia, expiraEm: new Date(AGORA.getTime() + 5 * DIA), revogadoEm: haDias(1), ip: '1.1.1.1' },
      ],
    });

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    expect(r.tokensApagados).toBe(1);
    const restantes = await prisma.refreshToken.findMany({ select: { tokenHash: true } });
    expect(restantes.map((t) => t.tokenHash).sort()).toEqual(['recem-expirado', 'revogado-vivo']);
  });

  /**
   * ── R-02 DA AUDITORIA LGPD: A PLANILHA CRUA ──
   *
   * `ImportacaoLinha.dadosBrutos` é a linha inteira como veio do tribunal. A
   * finalidade declarada — "reprocessar sem o arquivo" — vence em dias; o
   * prazo era infinito. O caso do PENDENTE é o mais importante dos três: é ele
   * que impede a limpeza de quebrar uma importação interrompida no meio.
   */
  async function importacaoCom(
    linhas: { numeroLinha: number; status: 'PENDENTE' | 'OK' | 'ERRO'; criadoEm: Date }[],
  ) {
    const { org, user } = await semearOrganizacao();
    const imp = await prisma.importacao.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        arquivoNome: 'TRF5 2027.xlsx',
        arquivoHash: `hash-${Math.random().toString(36).slice(2)}`,
        arquivoTipo: 'xlsx',
        status: 'CONCLUIDA',
      },
      select: { id: true },
    });
    for (const l of linhas) {
      await prisma.importacaoLinha.create({
        data: {
          importacaoId: imp.id,
          numeroLinha: l.numeroLinha,
          status: l.status,
          criadoEm: l.criadoEm,
          cpf: '39053344705',
          mensagemErro: 'Titular MARIA DE SOUZA sem processo',
          dadosBrutos: { NOME: 'MARIA DE SOUZA', CPF: '39053344705' },
        },
      });
    }
    return imp.id;
  }

  const linhaDe = (importacaoId: string, numeroLinha: number) =>
    prisma.importacaoLinha.findFirstOrThrow({
      where: { importacaoId, numeroLinha },
      select: { cpf: true, dadosBrutos: true, mensagemErro: true, status: true },
    });

  it('planilha com mais de 90 dias perde o conteúdo, e a LINHA fica', async () => {
    const imp = await importacaoCom([{ numeroLinha: 1, status: 'OK', criadoEm: haDias(91) }]);

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    expect(r.linhasDePlanilha).toBe(1);
    const l = await linhaDe(imp, 1);
    expect(l.dadosBrutos).toEqual({});
    expect(l.cpf).toBeNull();
    expect(l.mensagemErro).toBeNull();
    /* O FATO sobrevive: a linha existiu e o resultado dela continua legível. */
    expect(l.status).toBe('OK');
  });

  it('planilha com menos de 90 dias fica intacta — ainda dá para reprocessar', async () => {
    const imp = await importacaoCom([{ numeroLinha: 1, status: 'OK', criadoEm: haDias(89) }]);

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const l = await linhaDe(imp, 1);
    expect(l.cpf).toBe('39053344705');
    expect(JSON.stringify(l.dadosBrutos)).toContain('MARIA');
  });

  it('linha PENDENTE NUNCA é limpa, por mais velha que seja', async () => {
    /* A trava que impede a LGPD de quebrar o produto. O processamento pagina
       EXATAMENTE pelas linhas PENDENTE: limpar uma delas apagaria o conteúdo de
       que o worker precisa, e a importação interrompida jamais se recuperaria.
       Uma importação parada há meses é o caso real — é por isso que ela ficou
       parada. */
    const imp = await importacaoCom([{ numeroLinha: 1, status: 'PENDENTE', criadoEm: haDias(400) }]);

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    expect(r.linhasDePlanilha).toBe(0);
    const l = await linhaDe(imp, 1);
    expect(l.cpf).toBe('39053344705');
    expect(JSON.stringify(l.dadosBrutos)).toContain('MARIA');
  });

  it('o prazo da planilha é configurável, e vale o que a configuração disser', async () => {
    const imp = await importacaoCom([{ numeroLinha: 1, status: 'OK', criadoEm: haDias(30) }]);

    const r = await new RetencaoAgendada(
      prisma as never,
      configDe({ RETENCAO_PLANILHA_DIAS: 15 }),
    ).executar(AGORA);

    expect(r.linhasDePlanilha).toBe(1);
    expect((await linhaDe(imp, 1)).cpf).toBeNull();
  });

  it('planilha já limpa não é reescrita toda madrugada', async () => {
    await importacaoCom([{ numeroLinha: 1, status: 'OK', criadoEm: haDias(200) }]);
    const cron = new RetencaoAgendada(prisma as never, configDe({}));

    expect((await cron.executar(AGORA)).linhasDePlanilha).toBe(1);
    expect((await cron.executar(AGORA)).linhasDePlanilha).toBe(0);
  });

  it('é idempotente: rodar de novo não conta nada', async () => {
    const { user, org } = await semearOrganizacao();
    await prisma.auditLog.create({
      data: { organizationId: org.id, userId: user.id, acao: 'LOGIN', ip: '1.2.3.4', criadoEm: haDias(400) },
    });
    const cron = new RetencaoAgendada(prisma as never, configDe({}));

    await cron.executar(AGORA);
    const segunda = await cron.executar(AGORA);

    expect(segunda.auditoriaAnonimizada).toBe(0);
  });
});


/**
 * ── O TEXTO DIGITADO NA BUSCA ──
 *
 * Era o último campo desta trilha sem prazo nenhum: numa busca por nome ele É um
 * nome completo, e escapava das DUAS rotinas de descarte — sobrevivia à
 * anonimização do cliente e ao pedido de exclusão do titular.
 *
 * O que estes casos fixam é a fronteira: some a REDAÇÃO, fica o FATO. E fixam,
 * principalmente, que a correção de privacidade não degradou o direito de
 * privacidade que dependia dela.
 */
describe('Retenção do termo de busca', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  const CPF = '52998224725'; // válido no dígito verificador

  it('passado o prazo o texto vira nulo, e a linha continua contando quem consultou', async () => {
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: {
          userId: user.id,
          tipo: 'NOME',
          termo: 'MARIA DE SOUZA, RUA DAS FLORES 120',
          totalResultados: 3,
          contatoExibido: true,
          criadoEm: haDias(120),
        },
        select: { id: true },
      })
    ).id;

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.termo).toBeNull();
    /* O que a ANPD pergunta continua respondível. */
    expect(linha.userId).toBe(user.id);
    expect(linha.tipo).toBe('NOME');
    expect(linha.totalResultados).toBe(3);
    expect(linha.contatoExibido).toBe(true);
    expect(r?.termosDescartados).toBe(1);
  });

  it('dentro do prazo o texto fica inteiro', async () => {
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'NOME', termo: 'MARIA DE SOUZA', criadoEm: haDias(30) },
        select: { id: true },
      })
    ).id;

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.termo).toBe('MARIA DE SOUZA');
  });

  it('o prazo é configurável e NÃO herda o piso de 180 dos registros de acesso', async () => {
    /* A distinção é de natureza: o art. 15 do Marco Civil obriga a guardar
       REGISTRO DE ACESSO por 6 meses. O que a pessoa digitou é CONTEÚDO — a lei
       manda protegê-lo, não retê-lo. Se alguém um dia amarrar os dois prazos,
       este caso reprova. */
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'NOME', termo: 'JOAO', ip: '10.0.0.0', criadoEm: haDias(45) },
        select: { id: true },
      })
    ).id;

    await new RetencaoAgendada(
      prisma as never,
      configDe({ RETENCAO_TERMO_BUSCA_DIAS: 30 }),
    ).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.termo).toBeNull();
    /* 45 dias é MENOS que os 180 do acesso: o IP tem de continuar lá. */
    expect(linha.ip).toBe('10.0.0.0');
  });

  it('o CPF que estava só no texto é PROMOVIDO antes de o texto sair', async () => {
    /**
     * O caso que impede a correção de virar regressão.
     *
     * `trilhaCpf` casa por `cpfConsultado` OU `termo contains <cpf>`. O gravador
     * só preenche `cpfConsultado` quando o digitado tem EXATAMENTE 11 dígitos —
     * então "52998224725 81" (13 dígitos) deixava o CPF só no texto. Apagar o
     * texto sem promover tiraria essa consulta da resposta ao titular.
     */
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'CPF', termo: `${CPF} 81`, criadoEm: haDias(120) },
        select: { id: true },
      })
    ).id;

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.cpfConsultado).toBe(CPF); // o fato foi preservado…
    expect(linha.termo).toBeNull(); // …e a redação, descartada
    expect(r?.termosPromovidos).toBe(1);
  });

  it('11 dígitos que NÃO são CPF não viram consulta inventada', async () => {
    /* Celular com DDD tem 11 dígitos. Promover às cegas escreveria um telefone
       na coluna de CPF e inventaria, na trilha, uma consulta que nunca houve. */
    const { user } = await semearOrganizacao();
    const telefone = '81999998888';
    expect(telefone).toHaveLength(11); // o perigo é exatamente este
    const id = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'CPF', termo: `ligar ${telefone}`, criadoEm: haDias(120) },
        select: { id: true },
      })
    ).id;

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.cpfConsultado).toBeNull();
    expect(linha.termo).toBeNull();
    expect(r?.termosPromovidos).toBe(0);
  });

  it('não sobrescreve um cpfConsultado que já existe', async () => {
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: {
          userId: user.id,
          tipo: 'CPF',
          termo: `${CPF} 81`,
          cpfConsultado: '39053344705',
          criadoEm: haDias(120),
        },
        select: { id: true },
      })
    ).id;

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.cpfConsultado).toBe('39053344705');
  });

  it('número de precatório colado SEM máscara não vira CPF fantasma', async () => {
    /**
     * O furo mais perigoso desta correção, e ele foi MEDIDO.
     *
     * A primeira versão de `cpfNoTexto` deslizava uma janela de 11 dígitos
     * dentro de cada corrida numérica, confiando no dígito verificador como
     * peneira. O verificador só é boa peneira quando a corrida TEM 11 dígitos
     * (1% de falso positivo). Deslizando dentro de 20 dígitos ele desaba: 26%
     * dos números de precatório do TRF5 colados sem máscara geram uma janela
     * DV-válida — e, como a cauda do tribunal/ano é comum a todos, os falsos
     * positivos se concentram em pouquíssimos valores. O cron carimbaria
     * milhares de linhas com o mesmo CPF inexistente.
     *
     * E o caminho é rotineiro: a busca trata 6+ dígitos como CPF, colar o
     * número sem máscara não acha nada, o operador repete — cada tentativa
     * grava uma linha `tipo='CPF'` com 20 dígitos no termo.
     */
    const { user } = await semearOrganizacao();
    const semMascara = '99000014820254050000'; // 20 dígitos, formato do TRF5
    expect(semMascara).toHaveLength(20);
    const id = (
      await prisma.consultaCliente.create({
        data: { userId: user.id, tipo: 'CPF', termo: semMascara, criadoEm: haDias(120) },
        select: { id: true },
      })
    ).id;

    const r = await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    /* Não achar é recuperável; carimbar o CPF errado numa trilha de prestação
       de contas não é. */
    expect(linha.cpfConsultado).toBeNull();
    expect(r?.termosPromovidos).toBe(0);
    expect(linha.termo).toBeNull(); // o texto sai de qualquer jeito
  });

  it('o número do precatório NÃO é descartado — é a trilha do processo com várias partes', async () => {
    /**
     * O caso que quase passou despercebido.
     *
     * Em `PROCESSO` e `PROPOSTA` o termo não é digitado: é o `numeroPrecatorio`,
     * escrito pelo sistema. E quando o processo tem MAIS DE UMA parte,
     * `cpfConsultado` fica nulo de propósito — escolher um dos titulares
     * registraria mentira sobre os outros —, então o termo é a ÚNICA
     * rastreabilidade. O comentário em `carteira.controller.ts` diz isso com
     * todas as letras.
     *
     * Descartá-lo deixaria a linha dizendo "alguém abriu algum processo": uma
     * correção de privacidade destruindo a prestação de contas que ela existe
     * para sustentar.
     */
    const { user } = await semearOrganizacao();
    const id = (
      await prisma.consultaCliente.create({
        data: {
          userId: user.id,
          tipo: 'PROCESSO',
          termo: '0001234-56.2020.4.05.8300',
          cpfConsultado: null, // processo com várias partes
          criadoEm: haDias(300),
        },
        select: { id: true },
      })
    ).id;

    await new RetencaoAgendada(prisma as never, configDe({})).executar(AGORA);

    const linha = await prisma.consultaCliente.findUniqueOrThrow({ where: { id } });
    expect(linha.termo).toBe('0001234-56.2020.4.05.8300');
  });

  it('é idempotente: a segunda madrugada não reescreve nada', async () => {
    /* Sem o filtro "ainda não foi limpo", o UPDATE reescreveria todas as linhas
       antigas toda noite numa tabela que só cresce — escrita à toa e ruído no
       autovacuum. Mesma lição da linha crua da planilha. */
    const { user } = await semearOrganizacao();
    await prisma.consultaCliente.create({
      data: { userId: user.id, tipo: 'NOME', termo: 'MARIA', criadoEm: haDias(120) },
    });
    const cron = new RetencaoAgendada(prisma as never, configDe({}));

    const primeira = await cron.executar(AGORA);
    const segunda = await cron.executar(AGORA);

    expect(primeira?.termosDescartados).toBe(1);
    expect(segunda?.termosDescartados).toBe(0);
    expect(segunda?.termosPromovidos).toBe(0);
  });

});

describe('anonimizarIp', () => {
  it('IPv4 perde o último octeto', () => {
    expect(anonimizarIp('203.0.113.163')).toBe('203.0.113.0');
    expect(anonimizarIp('::ffff:10.20.30.40')).toBe('10.20.30.0');
  });
  it('IPv6 fica no prefixo /48', () => {
    expect(anonimizarIp('2804:14d:5c81:8f2b:1d2e:3f4a:5b6c:7d8e')).toBe('2804:14d:5c81::');
  });
  it('vazio e lixo viram nulo, nunca exceção', () => {
    expect(anonimizarIp(undefined)).toBeNull();
    expect(anonimizarIp('')).toBeNull();
    expect(anonimizarIp('nao-e-ip')).toBeNull();
  });
});
