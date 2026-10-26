import { SolicitacoesService } from '../../src/modules/titular/solicitacoes.service';
import { TitularService } from '../../src/modules/titular/titular.service';
import { encerrar, limparDados, prisma, semearOrganizacao } from './ambiente';

/**
 * ── R-05 DA AUDITORIA LGPD: A CENTRAL DE PRIVACIDADE ──
 *
 * `SolicitacaoTitular` existia no schema desde a etapa 1 — protocolo, tipo,
 * status, prazo — e nenhuma linha de código a lia ou escrevia. O EFEITO da
 * exclusão existia; o PROCESSO não. Um pedido chegava por e-mail, alguém
 * atendia, e não sobrava protocolo, prazo nem prova de tempestividade, que é o
 * que se apresenta à ANPD.
 *
 * O que estes casos fixam é a ligação entre as duas pontas: o mesmo clique que
 * marca "atendido" é o que apaga o dado. Separá-los criaria o pior estado
 * possível — um protocolo dizendo que foi atendido sem nada ter acontecido.
 */
const configDe = (valores: Record<string, unknown>) =>
  ({ get: (chave: string, padrao?: unknown) => valores[chave] ?? padrao }) as never;

const titular = new TitularService(prisma as never);
const central = (valores: Record<string, unknown> = {}) =>
  new SolicitacoesService(prisma as never, configDe(valores), titular);

const CPF = '39053344705';

async function pessoaComContato(cpf = CPF) {
  return prisma.pessoa.create({
    data: {
      cpf,
      nome: 'MARIA DE SOUZA',
      nomeNormalizado: 'MARIA DE SOUZA',
      telefones: { create: [{ ddd: '81', numero: '999998888', tipo: 'MOVEL' }] },
      emails: { create: [{ endereco: 'maria@exemplo.com.br' }] },
    },
    select: { id: true },
  });
}

describe('Central de Privacidade', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('registrar gera protocolo legível e começa a contar o prazo', async () => {
    const p = await central().registrar({ cpf: CPF, tipo: 'EXCLUSAO', email: 'maria@exemplo.com.br' });

    /* Formato EXATO, e o `{6}` e o que importa: a versao anterior tirava o
       sufixo de base64url e removia `-` e `_`, entao em ~17% dos casos ele saia
       com menos de seis caracteres. O teste falhava de vez em quando e passava
       na tentativa seguinte — o pior modo de falhar. */
    expect(p.protocolo).toMatch(/^LGPD-\d{8}-[A-HJ-NP-Z2-9]{6}$/);
    expect(p.status).toBe('RECEBIDA');
    expect(p.prazoLimite).toBeInstanceOf(Date);
    const dias = Math.round((p.prazoLimite!.getTime() - p.recebidoEm.getTime()) / 86_400_000);
    expect(dias).toBe(15);
  });

  it('o prazo é configurável — o número por tipo de pedido é decisão jurídica', async () => {
    const p = await central({ PRAZO_SOLICITACAO_TITULAR_DIAS: 5 }).registrar({ cpf: CPF, tipo: 'ACESSO' });
    const dias = Math.round((p.prazoLimite!.getTime() - p.recebidoEm.getTime()) / 86_400_000);
    expect(dias).toBe(5);
  });

  it('o sufixo tem SEMPRE seis caracteres — cem protocolos seguidos', async () => {
    /* Cem de uma vez porque o defeito anterior aparecia em ~17% dos sorteios:
       um unico caso passaria cinco vezes em seis e esconderia a falha. */
    const c = central();
    const protocolos = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        c.registrar({ cpf: String(i).padStart(11, '0'), tipo: 'ACESSO' }),
      ),
    );

    for (const p of protocolos) {
      expect(p.protocolo).toMatch(/^LGPD-\d{8}-[A-HJ-NP-Z2-9]{6}$/);
    }
    /* E nenhum simbolo ambiguo: o protocolo e ditado ao telefone. */
    const sufixos = protocolos.map((p) => p.protocolo.split('-')[2]).join('');
    expect(sufixos).not.toMatch(/[IO01]/);
  });

  it('dois pedidos no mesmo instante não colidem de protocolo', async () => {
    /* Sem contador sequencial de propósito: dois pedidos disputariam o mesmo
       número. O sufixo aleatório resolve, e este caso é o que prova. */
    const [a, b] = await Promise.all([
      central().registrar({ cpf: CPF, tipo: 'ACESSO' }),
      central().registrar({ cpf: '11144477735', tipo: 'ACESSO' }),
    ]);
    expect(a.protocolo).not.toBe(b.protocolo);
  });

  it('a fila mostra o que vence primeiro, e marca o que já venceu', async () => {
    const c = central();
    const novo = await c.registrar({ cpf: CPF, tipo: 'ACESSO' });
    const antigo = await c.registrar({ cpf: '11144477735', tipo: 'CORRECAO' });
    /* Um pedido cujo prazo já passou — o caso que a tela existe para gritar. */
    await prisma.solicitacaoTitular.update({
      where: { id: antigo.id },
      data: { prazoLimite: new Date(Date.now() - 3 * 86_400_000) },
    });

    const fila = await c.listar({});

    expect(fila.map((p) => p.id)).toEqual([antigo.id, novo.id]);
    expect(fila[0].vencido).toBe(true);
    expect(fila[0].diasParaVencer).toBeLessThan(0);
    expect(fila[1].vencido).toBe(false);
  });

  it('atender um pedido de EXCLUSÃO apaga de verdade, e o protocolo prova', async () => {
    const { org, user } = await semearOrganizacao();
    const pessoa = await pessoaComContato();
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'EXCLUSAO' });

    const r = await c.atender(pedido.id, { id: user.id, organizationId: org.id });

    expect(r.protocolo).toBe(pedido.protocolo);
    /* O EFEITO aconteceu... */
    expect(await prisma.telefone.count({ where: { pessoaId: pessoa.id } })).toBe(0);
    expect(await prisma.email.count({ where: { pessoaId: pessoa.id } })).toBe(0);
    const depois = await prisma.pessoa.findUniqueOrThrow({ where: { id: pessoa.id } });
    expect(depois.exclusaoEm).not.toBeNull();
    /* ...e o REGISTRO conta o que aconteceu, com números. */
    const atendido = await prisma.solicitacaoTitular.findUniqueOrThrow({ where: { id: pedido.id } });
    expect(atendido.status).toBe('ATENDIDA');
    expect(atendido.respondidoEm).not.toBeNull();
    expect(atendido.resposta).toContain('Telefones: 1');
  });

  it('o motivo da exclusão carrega o protocolo — é assim que se responde à ANPD', async () => {
    const { org, user } = await semearOrganizacao();
    const pessoa = await pessoaComContato();
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'EXCLUSAO' });

    await c.atender(pedido.id, { id: user.id, organizationId: org.id });

    const depois = await prisma.pessoa.findUniqueOrThrow({ where: { id: pessoa.id } });
    expect(depois.exclusaoMotivo).toContain(pedido.protocolo);
  });

  it('atender ACESSO entrega o relatório, mas NÃO o guarda na resposta', async () => {
    /* A coluna `resposta` sobreviveria a um pedido de exclusão posterior:
       guardar o relatório ali faria o atendimento do acesso virar a cópia que a
       exclusão não alcança. Fica o registro DE QUE foi entregue. */
    const { org, user } = await semearOrganizacao();
    await pessoaComContato();
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'ACESSO' });

    const r = await c.atender(pedido.id, { id: user.id, organizationId: org.id });

    expect(r.documento?.contatos.telefones).toHaveLength(1);
    const atendido = await prisma.solicitacaoTitular.findUniqueOrThrow({ where: { id: pedido.id } });
    expect(atendido.status).toBe('ATENDIDA');
    expect(atendido.resposta).not.toContain('999998888');
    expect(atendido.resposta).not.toContain('maria@exemplo.com.br');
  });

  it('tipo que o sistema não sabe executar é RECUSADO com clareza, não fingido', async () => {
    const { org, user } = await semearOrganizacao();
    await pessoaComContato();
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'CORRECAO' });

    await expect(c.atender(pedido.id, { id: user.id, organizationId: org.id })).rejects.toThrow(
      /atendido manualmente/,
    );
    /* E continua em aberto: recusar a automação não pode encerrar o pedido. */
    const ainda = await prisma.solicitacaoTitular.findUniqueOrThrow({ where: { id: pedido.id } });
    expect(ainda.status).toBe('RECEBIDA');
  });

  it('pedido já atendido não reabre — a prova de tempestividade seria destruída', async () => {
    const { org, user } = await semearOrganizacao();
    await pessoaComContato();
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'EXCLUSAO' });
    await c.atender(pedido.id, { id: user.id, organizationId: org.id });

    await expect(c.atender(pedido.id, { id: user.id, organizationId: org.id })).rejects.toThrow(
      /já foi atendido/,
    );
    await expect(c.atualizar(pedido.id, { status: 'EM_ANALISE' })).rejects.toThrow(/já foi atendido/);
  });

  it('anotar andamento não encerra o pedido nem carimba data de resposta', async () => {
    const c = central();
    const pedido = await c.registrar({ cpf: CPF, tipo: 'OPOSICAO' });

    const r = await c.atualizar(pedido.id, { status: 'EM_ANALISE', resposta: 'Aguardando documento.' });

    expect(r.status).toBe('EM_ANALISE');
    expect(r.respondidoEm).toBeNull();
  });
});
