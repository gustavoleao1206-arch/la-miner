import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { ClientesService } from '../../src/modules/clientes/clientes.service';
import {
  encerrar,
  limparDados,
  liberarProcesso,
  prisma,
  semearCliente,
  semearOrganizacao,
  semearProcesso,
} from './ambiente';

/**
 * ── O FIM DA VIDA DE UMA CONTA ──
 *
 * O painel sabia analisar cliente e não sabia removê-lo, então conta abandonada
 * ficava para sempre — ruído para quem opera e dado pessoal guardado sem
 * propósito.
 *
 * O que estes testes fixam não é "apaga": é QUEM DECIDE O MODO. A escolha entre
 * excluir e anonimizar sai do histórico da conta e das constraints reais do
 * banco, nunca do clique de quem está com pressa. Fatura paga é comprovação de
 * receita; `processos` e `importacoes` são RESTRICT no Postgres. Nos três casos
 * a resposta certa é a mesma: tira a PESSOA e deixa o REGISTRO.
 */

const servico = () => new ClientesService(prisma as never);

/** O ADMIN que executa a ação — sempre de uma organização diferente do alvo. */
async function ator() {
  const interna = await semearOrganizacao('Leão Amorim (teste)');
  return { userId: interna.user.id, organizationId: interna.org.id, orgInterna: interna.org.id };
}

async function assinaturaCom(organizationId: string, statusFatura?: 'PAGA' | 'ABERTA') {
  const plano = await prisma.plano.create({
    data: { nome: `Plano ${Math.random().toString(36).slice(2, 8)}`, processosPorCiclo: 250, preco: 799 },
    select: { id: true },
  });
  const assinatura = await prisma.assinatura.create({
    data: { organizationId, planoId: plano.id, status: 'ATIVA' },
    select: { id: true },
  });
  if (statusFatura) {
    await prisma.fatura.create({
      data: {
        assinaturaId: assinatura.id,
        competencia: new Date(Date.UTC(2026, 0, 1)),
        vencimentoEm: new Date(Date.UTC(2026, 0, 10)),
        valor: 799,
        status: statusFatura,
      },
    });
  }
  return assinatura.id;
}

describe('Exclusão de contas de cliente', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  // ── Conta abandonada: some inteira ──

  it('cliente que NUNCA pagou é excluído por completo, com a cascata', async () => {
    const a = await ator();
    const { org, user } = await semearCliente();
    await assinaturaCom(org.id, 'ABERTA');
    const cnpj = (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { cnpj: true },
    })).cnpj!;

    const sondagem = await servico().sondar(org.id, a.organizationId);
    expect(sondagem.modo).toBe('EXCLUIDA');
    expect(sondagem.faturasPagas).toBe(0);

    const r = await servico().excluir(org.id, cnpj, a);
    expect(r.modo).toBe('EXCLUIDA');

    /* A organização e tudo que pendura nela: fora. */
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
    expect(await prisma.assinatura.count({ where: { organizationId: org.id } })).toBe(0);
  });

  /**
   * ── R-09 DA AUDITORIA LGPD ──
   *
   * O caminho EXCLUIDA chama `organization.delete()` e conta com a cascata. Mas
   * `consultas_cliente.userId` é ON DELETE RESTRICT e NADA apaga essas linhas —
   * nem `decidir`, nem `anonimizar`. Resultado: o cliente que nunca pagou,
   * nunca importou, mas fez UMA busca, tem um botão que promete "será removida
   * por completo" e entrega um 500 sem explicação.
   *
   * A trilha não pode simplesmente sumir: ela é a prestação de contas de quem
   * viu qual CPF, e o art. 16 admite guardar para cumprir obrigação legal. Se
   * ela fica, a conta não pode ser apagada por completo — então a promessa é
   * que está errada, não o banco.
   */
  it('cliente COM TRILHA de consulta: a sondagem diz a verdade e a exclusão não estoura', async () => {
    const a = await ator();
    const { org, user } = await semearCliente('Escritório que buscou');
    const cnpj = (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { cnpj: true },
    })).cnpj!;

    await prisma.consultaCliente.create({
      data: { userId: user.id, tipo: 'CPF', termo: '39053344705', cpfConsultado: '39053344705' },
    });

    const sondagem = await servico().sondar(org.id, a.organizationId);
    expect(sondagem.modo).toBe('ANONIMIZADA');
    expect(sondagem.motivo).toMatch(/consulta/i);

    /* E a operação COMPLETA — era aqui que estourava a chave estrangeira. */
    const r = await servico().excluir(org.id, cnpj, a);
    expect(r.modo).toBe('ANONIMIZADA');

    /* A pessoa saiu... */
    const depois = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(depois.email).toMatch(/@removido\.invalid$/);
    expect(depois.nome).toBe('Usuário removido');
    /* ...e a trilha ficou, agora apontando para alguém sem identidade. */
    expect(await prisma.consultaCliente.count({ where: { userId: user.id } })).toBe(1);
  });

  it('a ANONIMIZAÇÃO não regrava na trilha o nome e o CNPJ que ela acabou de apagar', async () => {
    /* O defeito era tratar os dois caminhos igual. Na EXCLUIDA a organização
       some, e o log é o único lugar que sabe que ela existiu — nome e documento
       ficam (o caso logo abaixo prova). Na ANONIMIZADA a organização CONTINUA
       no banco, com nome e documento removidos de propósito: gravá-los aqui
       recriava, dentro do audit_logs, a cópia identificável que a operação
       existe para destruir — e o cron de retenção nunca limpa este campo. */
    const a = await ator();
    const { org, user } = await semearCliente('Escritório Identificável');
    const cnpj = (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { cnpj: true },
    })).cnpj!;
    await prisma.consultaCliente.create({
      data: { userId: user.id, tipo: 'CPF', termo: '39053344705' },
    });

    const r = await servico().excluir(org.id, cnpj, a);
    expect(r.modo).toBe('ANONIMIZADA');

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { acao: { in: ['EXCLUIR_CLIENTE', 'ANONIMIZAR_CLIENTE'] } },
    });
    const gravado = JSON.stringify(log.dadosAntes);
    expect(gravado).not.toContain('Escritório Identificável');
    expect(gravado).not.toContain(cnpj);
  });

  it('a trilha SOBREVIVE à exclusão e se basta — o vínculo com a org vira nulo', async () => {
    const a = await ator();
    const { org } = await semearCliente('Escritório Fantasma');
    const cnpj = (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { cnpj: true },
    })).cnpj!;

    await servico().excluir(org.id, cnpj, a);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { acao: 'EXCLUIR_CLIENTE', entidadeId: org.id },
      select: { organizationId: true, dadosAntes: true },
    });
    /* SET NULL: o log fica órfão de propósito, e é por isso que o conteúdo
       precisa bastar-se. Um registro que perdeu a referência e não guardou o
       essencial não responde "quem apagou este cliente?". */
    expect(log.organizationId).toBeNull();
    expect(log.dadosAntes).toMatchObject({ nome: 'Escritório Fantasma', cnpj });
  });

  // ── Conta que pagou: anonimiza ──

  describe('quando há fatura paga', () => {
    it('ANONIMIZA em vez de excluir: sai a pessoa, fica o registro fiscal', async () => {
      const a = await ator();
      const { org, user } = await semearCliente();
      const assinaturaId = await assinaturaCom(org.id, 'PAGA');
      const cnpj = (await prisma.organization.findUniqueOrThrow({
        where: { id: org.id },
        select: { cnpj: true },
      })).cnpj!;
      /* O processo pertence à INTERNA (dona da base) e é LIBERADO ao cliente:
         é assim em produção, e importa aqui porque processo NO NOME DO CLIENTE
         mudaria o modo por outro motivo, mascarando o que este teste mede. */
      const p = await semearProcesso({ organizationId: a.orgInterna });
      await liberarProcesso(org.id, p.id);

      /* ── A CONTA PRECISA ESTAR LOGADA PARA O TESTE VALER ──
         A primeira versão deste teste afirmava que a sessão morre, mas
         `semearCliente` já nasce sem família e sem refresh: a asserção passava
         sozinha, e a mutação que APAGA a revogação sobreviveu. Sessão viva de
         verdade é o que transforma a asserção em prova. */
      const familia = '11111111-1111-4111-8111-111111111111';
      await prisma.user.update({
        where: { id: user.id },
        data: { familiaSessaoAtual: familia },
      });
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: `hash-${user.id}`,
          familiaId: familia,
          expiraEm: new Date(Date.now() + 7 * 24 * 3_600_000),
        },
      });

      const sondagem = await servico().sondar(org.id, a.organizationId);
      expect(sondagem.modo).toBe('ANONIMIZADA');
      expect(sondagem.motivo).toMatch(/comprovação de receita/);

      const r = await servico().excluir(org.id, cnpj, a);
      expect(r.modo).toBe('ANONIMIZADA');

      /* O REGISTRO FICA: fatura paga é documento fiscal, não linha de banco. */
      expect(await prisma.fatura.count({ where: { assinaturaId, status: 'PAGA' } })).toBe(1);
      const assinatura = await prisma.assinatura.findUniqueOrThrow({
        where: { id: assinaturaId },
        select: { status: true },
      });
      /* Encerrada: nenhum cron deve faturar uma conta que não existe mais. */
      expect(assinatura.status).toBe('CANCELADA');

      /* A PESSOA SAI. */
      const depois = await prisma.organization.findUniqueOrThrow({
        where: { id: org.id },
        select: { nome: true, cnpj: true, telefone: true, ativo: true },
      });
      expect(depois.cnpj).toBeNull();
      expect(depois.telefone).toBeNull();
      expect(depois.ativo).toBe(false);
      expect(depois.nome).not.toContain('Cliente de Teste');

      const usuario = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { email: true, nome: true, ativo: true, senhaHash: true, familiaSessaoAtual: true },
      });
      expect(usuario.email).toMatch(/@removido\.invalid$/);
      expect(usuario.nome).toBe('Usuário removido');
      expect(usuario.ativo).toBe(false);
      /* Sessão derrubada: sem isto a conta anonimizada seguiria navegando com o
         token que já tinha em mãos. */
      expect(usuario.familiaSessaoAtual).toBeNull();
      const vivos = await prisma.refreshToken.count({
        where: { userId: user.id, revogadoEm: null },
      });
      expect(vivos).toBe(0);

      /* E a carteira — o volume de verdade — vai embora. */
      expect(await prisma.carteiraProcesso.count({ where: { organizationId: org.id } })).toBe(0);
      expect(await prisma.processoLiberado.count({ where: { organizationId: org.id } })).toBe(0);
    });

    it('o e-mail liberado permite um cadastro novo com o mesmo endereço', async () => {
      const a = await ator();
      const { org, user } = await semearCliente();
      await assinaturaCom(org.id, 'PAGA');
      const antes = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { email: true },
      });
      const cnpj = (await prisma.organization.findUniqueOrThrow({
        where: { id: org.id },
        select: { cnpj: true },
      })).cnpj!;

      await servico().excluir(org.id, cnpj, a);

      /* O `@unique` do e-mail deixou de bloquear: quem foi removido pode voltar
         a se cadastrar com o mesmo endereço. Sem isto, "anonimizar" seria uma
         forma silenciosa de banir a pessoa para sempre. */
      const livre = await prisma.user.findUnique({ where: { email: antes.email } });
      expect(livre).toBeNull();
    });
  });

  // ── Registros que o BANCO protege ──

  it('processo próprio força a anonimização — o Postgres recusaria a exclusão', async () => {
    const a = await ator();
    const { org } = await semearCliente();
    /* Processo NO NOME DO CLIENTE: `processos` é RESTRICT, medido nas
       constraints. Oferecer "excluir" aqui seria prometer o que o banco nega. */
    await semearProcesso({ organizationId: org.id });

    const sondagem = await servico().sondar(org.id, a.organizationId);

    expect(sondagem.modo).toBe('ANONIMIZADA');
    expect(sondagem.processosProprios).toBe(1);
    expect(sondagem.motivo).toMatch(/o banco protege/);
  });

  // ── As travas ──

  it('a organização INTERNA nunca pode ser excluída — é a dona da base', async () => {
    const a = await ator();
    const outra = await semearOrganizacao('Outra interna');

    await expect(servico().sondar(outra.org.id, a.organizationId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('o administrador não apaga a própria organização', async () => {
    const a = await ator();

    await expect(servico().sondar(a.organizationId, a.organizationId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('confirmação errada não apaga nada', async () => {
    const a = await ator();
    const { org } = await semearCliente();

    await expect(servico().excluir(org.id, '11222333000181', a)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    /* O ponto: a conta continua lá. */
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
  });

  it('confirmação vazia não passa — seria o mesmo que não pedir', async () => {
    const a = await ator();
    const { org } = await semearCliente();

    await expect(servico().excluir(org.id, '', a)).rejects.toBeInstanceOf(BadRequestException);
    expect(await prisma.organization.findUnique({ where: { id: org.id } })).not.toBeNull();
  });

  it('o CNPJ é aceito COM máscara — quem digita copia da tela', async () => {
    const a = await ator();
    const { org } = await semearCliente();
    const cnpj = (await prisma.organization.findUniqueOrThrow({
      where: { id: org.id },
      select: { cnpj: true },
    })).cnpj!;
    const comMascara = `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;

    const r = await servico().excluir(org.id, comMascara, a);

    expect(r.modo).toBe('EXCLUIDA');
  });

  it('cliente inexistente devolve 404, não 500', async () => {
    const a = await ator();

    await expect(
      servico().sondar('00000000-0000-4000-8000-000000000000', a.organizationId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
