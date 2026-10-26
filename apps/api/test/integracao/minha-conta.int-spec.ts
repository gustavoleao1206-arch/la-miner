import { MinhaContaService } from '../../src/modules/minha-conta/minha-conta.service';
import {
  encerrar,
  limparDados,
  prisma,
  semearCliente,
  semearOrganizacao,
  semearProcesso,
} from './ambiente';

/**
 * ── R-06 PARTE B: A EXPORTAÇÃO DO PRÓPRIO CLIENTE (LGPD art. 18, V) ──
 *
 * O escritório assinante também é titular: cadastro, usuários, financeiro. Esta
 * rota entrega isso sem ele precisar pedir a ninguém.
 *
 * O que estes casos mais protegem, porém, é a AUSÊNCIA. A decisão do dono foi
 * que a carteira NÃO entra — nem os processos, nem os contatos dos titulares —,
 * e o custo disso está declarado: quem cancelar não leva a agenda que usava. Em
 * troca, milhares de terceiros que nunca contrataram nada deixam de caber num
 * arquivo único e baixável.
 *
 * Uma decisão dessas se perde na primeira refatoração se não estiver amarrada
 * por teste. É o que os casos de "não sai" fazem aqui.
 */
const servico = () => new MinhaContaService(prisma as never);

async function assinarCom(organizationId: string) {
  const plano = await prisma.plano.create({
    data: { nome: `Plano ${Math.random().toString(36).slice(2, 8)}`, processosPorCiclo: 250, preco: 497 },
    select: { id: true },
  });
  const assinatura = await prisma.assinatura.create({
    data: {
      organizationId,
      planoId: plano.id,
      status: 'ATIVA',
      /* Traço de infraestrutura: o id do cliente no gateway. Existe na fixture
         justamente para o teste provar que ele NÃO sai na exportação. */
      clienteExternoId: 'cus_SEGREDO_DO_GATEWAY',
    },
    select: { id: true },
  });
  await prisma.fatura.create({
    data: {
      assinaturaId: assinatura.id,
      competencia: new Date('2026-08-01'),
      valor: 497,
      status: 'PAGA',
      vencimentoEm: new Date('2026-08-10'),
      pagoEm: new Date('2026-08-05'),
      idExterno: 'pay_SEGREDO_DO_GATEWAY',
      urlPagamento: 'https://gateway.invalid/pay_SEGREDO_DO_GATEWAY',
    },
  });
  await prisma.loteAssinatura.create({
    data: {
      assinaturaId: assinatura.id,
      competencia: new Date('2026-08-01'),
      quantidadeAlvo: 250,
      quantidadeLiberada: 250,
    },
  });
  return assinatura.id;
}

describe('Exportação dos dados da própria conta', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('entrega cadastro, usuarios, assinatura, faturas e ciclos', async () => {
    const cliente = await semearCliente('Escritorio Alfa');
    await assinarCom(cliente.org.id);

    const r = await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id });

    expect(r.organizacao.nome).toBe('Escritorio Alfa');
    expect(r.usuarios).toHaveLength(1);
    const noBanco = await prisma.user.findUniqueOrThrow({
      where: { id: cliente.user.id },
      select: { email: true },
    });
    expect(r.usuarios[0].email).toBe(noBanco.email);
    expect(r.assinatura?.status).toBe('ATIVA');
    expect(r.assinatura?.plano.processosPorCiclo).toBe(250);
    /* String, e nao numero: centavo em ponto flutuante e como se perde um
       centavo por linha num arquivo que a contabilidade do cliente vai somar. */
    expect(typeof r.assinatura?.plano.preco).toBe('string');
    expect(r.assinatura?.faturas).toHaveLength(1);
    expect(r.assinatura?.faturas[0].status).toBe('PAGA');
    expect(r.assinatura?.ciclosRecebidos[0].processosEntregues).toBe(250);
  });

  it('NUNCA entrega credencial: senha, segundo fator ou token', async () => {
    /* `User` guarda senhaHash, mfaSegredo e os hashes de token na MESMA tabela
       do nome e do e-mail. Um `...usuario` distraido poria a senha dentro de um
       arquivo que o cliente baixa e guarda onde quiser. Por isso a projecao e
       por remontagem, campo a campo — e por isso este caso existe. */
    const cliente = await semearCliente();
    await prisma.user.update({
      where: { id: cliente.user.id },
      data: { mfaSegredo: 'v1.SEGREDO_TOTP_CIFRADO', senhaResetTokenHash: 'HASH_DE_RESET' },
    });

    const bruto = JSON.stringify(await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id }));

    for (const proibido of ['senhaHash', 'mfaSegredo', 'SEGREDO_TOTP', 'HASH_DE_RESET', 'familiaSessaoAtual', '$argon2']) {
      expect(bruto).not.toContain(proibido);
    }
  });

  it('NAO leva a carteira nem o contato dos titulares — a decisao do dono, amarrada', async () => {
    /* O caso central. A conta tem processo liberado e o titular tem telefone,
       e-mail e endereco: se a exportacao os alcancasse, apareceriam aqui. */
    const { org } = await semearOrganizacao();
    const cliente = await semearCliente();
    const assinaturaId = await assinarCom(cliente.org.id);

    const processo = await semearProcesso({ organizationId: org.id, valor: 9000 });
    const pessoa = await prisma.pessoa.create({
      data: {
        cpf: '39053344705',
        nome: 'MARIA DE SOUZA',
        nomeNormalizado: 'MARIA DE SOUZA',
        telefones: { create: [{ ddd: '81', numero: '999998888', tipo: 'MOVEL' }] },
        emails: { create: [{ endereco: 'maria@exemplo.com.br' }] },
        enderecos: { create: [{ logradouro: 'Rua Secreta', cidade: 'Recife', uf: 'PE' }] },
      },
      select: { id: true },
    });
    await prisma.processoPessoa.create({ data: { processoId: processo.id, pessoaId: pessoa.id } });
    const lote = await prisma.loteAssinatura.findFirstOrThrow({
      where: { assinaturaId },
      select: { id: true },
    });
    await prisma.processoLiberado.create({
      data: { organizationId: cliente.org.id, processoId: processo.id, loteId: lote.id },
    });

    const bruto = JSON.stringify(await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id }));

    expect(bruto).not.toContain('MARIA DE SOUZA');
    expect(bruto).not.toContain('39053344705');
    expect(bruto).not.toContain('999998888');
    expect(bruto).not.toContain('maria@exemplo.com.br');
    expect(bruto).not.toContain('Rua Secreta');
    expect(bruto).not.toContain(processo.id);
  });

  it('NAO leva traco de infraestrutura do gateway', async () => {
    /* `cobranca.service` ja decidiu apagar todo traco de infraestrutura da
       resposta do cliente. Reexporta-los aqui desfaria a decisao por uma porta
       lateral, sem ninguem perceber. */
    const cliente = await semearCliente();
    await assinarCom(cliente.org.id);

    const bruto = JSON.stringify(await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id }));

    expect(bruto).not.toContain('SEGREDO_DO_GATEWAY');
    expect(bruto).not.toContain('gateway.invalid');
  });

  it('DIZ o que nao tem, em vez de omitir em silencio', async () => {
    /* Exportacao incompleta em silencio e pior que nenhuma: quem recebe supoe
       que ali esta tudo, e a reclamacao seguinte e legitima. */
    const cliente = await semearCliente();

    const r = await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id });

    expect(r.naoIncluido.carteiraDeProcessos).toMatch(/terceiros/i);
    expect(r.naoIncluido.comoOTitularPedeOsDadosDele).toMatch(/protocolo/i);
    expect(r.naoIncluido.anotacoesEHistoricoDoCrm).toBeTruthy();
  });

  it('a exportacao deixa trilha, e a trilha guarda CONTAGENS', async () => {
    const cliente = await semearCliente();
    await assinarCom(cliente.org.id);

    await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id });

    const log = await prisma.auditLog.findFirstOrThrow({ where: { acao: 'EXPORTAR_DADOS_DA_CONTA' } });
    expect(log.userId).toBe(cliente.user.id);
    expect(log.organizationId).toBe(cliente.org.id);
    expect(log.dadosAntes).toMatchObject({ usuarios: 1, faturas: 1, ciclos: 1 });
    /* O documento nao pode morar na trilha: `audit_logs` sobrevive a exclusao
       da conta, e o cron de retencao nao limpa este campo. */
    const { email } = await prisma.user.findUniqueOrThrow({
      where: { id: cliente.user.id },
      select: { email: true },
    });
    expect(JSON.stringify(log.dadosAntes)).not.toContain(email);
  });

  it('conta sem assinatura exporta assim mesmo, com assinatura nula', async () => {
    /* Quem cadastrou e nunca pagou tambem tem direito aos proprios dados —
       e e justamente quem mais tende a pedir. */
    const cliente = await semearCliente();

    const r = await servico().exportar({ id: cliente.user.id, organizationId: cliente.org.id });

    expect(r.assinatura).toBeNull();
    expect(r.usuarios).toHaveLength(1);
  });
});
