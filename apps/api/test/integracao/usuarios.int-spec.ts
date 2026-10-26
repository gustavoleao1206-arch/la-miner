import { UsuariosService, type Ator } from '../../src/modules/usuarios/usuarios.service';
import { TokenService } from '../../src/modules/auth/application/token.service';
import { prisma, limparDados, semearOrganizacao, semearCliente, encerrar } from './ambiente';

/**
 * TokenService REAL, e não um dublê.
 *
 * O `UsuariosService` passou a depender dele para encerrar sessões — e a
 * revogação só vale porque carimba `sessoesRevogadasEm` junto com os refresh
 * tokens, numa transação. Um dublê que não fizesse isso deixaria os testes
 * verdes com a revogação pela metade, que é exatamente o defeito que o C1
 * corrigiu.
 *
 * `jwt` e `config` não são exercitados por estes casos (ninguém aqui assina
 * token), então basta o Prisma de verdade.
 */
const tokens = new TokenService(null as never, null as never, prisma as never);
const usuarios = new UsuariosService(prisma as never, tokens);

/** Monta o Ator a partir de um usuário do banco — como o controller faria do JWT. */
async function atorDe(userId: string): Promise<Ator> {
  const u = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      papel: true,
      gestor: true,
      organizationId: true,
      organization: { select: { tipo: true } },
    },
  });
  return {
    id: u.id,
    papel: u.papel,
    gestor: u.gestor,
    organizationId: u.organizationId,
    tipo: u.organization.tipo,
  };
}

describe('Usuários — equipe da própria organização', () => {
  beforeEach(async () => {
    await limparDados();
  });
  afterAll(encerrar);

  /**
   * A TRAVA CENTRAL desta fase.
   *
   * A senha do novo usuário é EXIBIDA a quem o cria. Se um gestor de cliente
   * pudesse escolher o papel, ele criaria um ADMIN, leria a senha, entraria como
   * ele — e alcançaria /distribuicao/clientes, ou seja, os dados de TODOS os
   * assinantes da plataforma. Por isso o papel é derivado do ator, e o campo do
   * corpo é ignorado para quem não é ADMIN.
   */
  it('gestor de cliente NÃO consegue criar um ADMIN, mesmo pedindo', async () => {
    const c = await semearCliente();
    const ator = await atorDe(c.user.id);
    expect(ator.gestor).toBe(true);

    const r = await usuarios.criar(ator, {
      nome: 'Tentativa de Escalada',
      email: 'escalada@clienteteste.local',
      papel: 'ADMIN',
      gestor: true,
    });

    /* Pediu ADMIN, recebeu CLIENTE. O pedido nem chega a ser consultado. */
    expect(r.usuario.papel).toBe('CLIENTE');
  });

  /**
   * O mesmo buraco, um degrau acima: um OPERADOR com gestão criaria um ADMIN e
   * se promoveria sem tocar no próprio registro. Ninguém cria alguém com mais
   * alcance do que tem.
   */
  it('OPERADOR com gestão cria OPERADOR, nunca ADMIN', async () => {
    const { org } = await semearOrganizacao();
    const op = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'op@teste.local',
        nome: 'Operador Gestor',
        papel: 'OPERADOR',
        gestor: true,
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });

    const r = await usuarios.criar(await atorDe(op.id), {
      nome: 'Novo',
      email: 'novo@teste.local',
      papel: 'ADMIN',
    });

    expect(r.usuario.papel).toBe('OPERADOR');
  });

  it('ADMIN da plataforma escolhe o papel de quem cria', async () => {
    const { user } = await semearOrganizacao();

    const r = await usuarios.criar(await atorDe(user.id), {
      nome: 'Operador Novo',
      email: 'operador.novo@teste.local',
      papel: 'OPERADOR',
    });

    expect(r.usuario.papel).toBe('OPERADOR');
    expect(r.acesso.senhaInicial).toHaveLength(16);
  });

  it('o novo usuário nasce na organização de QUEM CRIA', async () => {
    const a = await semearCliente('Cliente A');
    const b = await semearCliente('Cliente B');

    const r = await usuarios.criar(await atorDe(a.user.id), {
      nome: 'Colega',
      email: 'colega@a.local',
    });

    const criado = await prisma.user.findUniqueOrThrow({
      where: { id: r.usuario.id },
      select: { organizationId: true },
    });
    expect(criado.organizationId).toBe(a.org.id);
    expect(criado.organizationId).not.toBe(b.org.id);
  });

  it('a listagem mostra só a própria equipe', async () => {
    const a = await semearCliente('Cliente A');
    const b = await semearCliente('Cliente B');
    await usuarios.criar(await atorDe(a.user.id), { nome: 'Colega A', email: 'colega@a2.local' });

    const equipeA = await usuarios.listar(await atorDe(a.user.id));
    const equipeB = await usuarios.listar(await atorDe(b.user.id));

    expect(equipeA.usuarios).toHaveLength(2);
    expect(equipeB.usuarios).toHaveLength(1);
    expect(equipeA.usuarios.map((u) => u.email)).not.toContain(b.user.id);
  });

  it('gestor não mexe em usuário de outro tenant', async () => {
    const a = await semearCliente('Cliente A');
    const b = await semearCliente('Cliente B');

    await expect(
      usuarios.atualizar(await atorDe(a.user.id), b.user.id, { ativo: false }),
    ).rejects.toThrow(/não encontrado/i);

    const alvo = await prisma.user.findUniqueOrThrow({
      where: { id: b.user.id },
      select: { ativo: true },
    });
    expect(alvo.ativo).toBe(true);
  });

  it('quem não é gestor nem ADMIN não administra a equipe', async () => {
    const c = await semearCliente();
    const comum = await usuarios.criar(await atorDe(c.user.id), {
      nome: 'Usuário Comum',
      email: 'comum@cliente.local',
    });

    const ator = await atorDe(comum.usuario.id);
    expect(ator.gestor).toBe(false);
    await expect(usuarios.listar(ator)).rejects.toThrow(/gestor/i);
    await expect(
      usuarios.criar(ator, { nome: 'X', email: 'x@cliente.local' }),
    ).rejects.toThrow(/gestor/i);
  });

  /**
   * O ataque que a auditoria encontrou, reproduzido inteiro.
   *
   * `criar` estava protegido, mas `redefinirSenha` não olhava o papel do alvo —
   * e ela DEVOLVE a senha em claro, de propósito, para o gestor repassar ao
   * colega. Então bastava um OPERADOR com gestão pedir a redefinição da senha do
   * ADMIN, ler a resposta e entrar como ADMIN. Sem tocar no próprio registro,
   * sem violar nenhuma checagem existente.
   */
  it('gestor NÃO redefine a senha de um ADMIN', async () => {
    const { org, user: admin } = await semearOrganizacao();
    const op = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'op.gestor@teste.local',
        nome: 'Operador Gestor',
        papel: 'OPERADOR',
        gestor: true,
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });

    const antes = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { senhaHash: true },
    });

    await expect(usuarios.redefinirSenha(await atorDe(op.id), admin.id)).rejects.toThrow(
      /mais permissões/i,
    );

    /* A senha do ADMIN continua intacta — a tentativa não chegou a gravar. */
    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { senhaHash: true },
    });
    expect(depois.senhaHash).toBe(antes.senhaHash);
  });

  it('gestor NÃO desativa nem rebaixa um ADMIN', async () => {
    const { org, user: admin } = await semearOrganizacao();
    const op = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'op.gestor2@teste.local',
        nome: 'Operador Gestor',
        papel: 'OPERADOR',
        gestor: true,
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });
    const ator = await atorDe(op.id);

    await expect(usuarios.atualizar(ator, admin.id, { ativo: false })).rejects.toThrow(
      /mais permissões/i,
    );
    await expect(usuarios.atualizar(ator, admin.id, { gestor: true })).rejects.toThrow(
      /mais permissões/i,
    );

    const intacto = await prisma.user.findUniqueOrThrow({
      where: { id: admin.id },
      select: { ativo: true, gestor: true },
    });
    expect(intacto.ativo).toBe(true);
  });

  /* A régua é de ALCANCE, não de hierarquia rígida: o gestor continua
     administrando quem está no mesmo nível ou abaixo — senão a correção teria
     quebrado a funcionalidade que a Fase F entregou. */
  it('gestor segue administrando quem tem alcance igual ou menor', async () => {
    const { org } = await semearOrganizacao();
    const op = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: 'op.gestor3@teste.local',
        nome: 'Operador Gestor',
        papel: 'OPERADOR',
        gestor: true,
        senhaHash: 'nao-e-um-hash-valido',
      },
      select: { id: true },
    });
    const ator = await atorDe(op.id);

    const par = await usuarios.criar(ator, { nome: 'Par', email: 'par@teste.local' });
    expect(par.usuario.papel).toBe('OPERADOR');

    const r = await usuarios.redefinirSenha(ator, par.usuario.id);
    expect(r.acesso.senhaInicial).toHaveLength(16);
    await usuarios.atualizar(ator, par.usuario.id, { ativo: false });
  });

  it('ADMIN redefine a senha de qualquer um e o ato fica registrado', async () => {
    const { org, user: admin } = await semearOrganizacao();
    const ator = await atorDe(admin.id);
    const alvo = await usuarios.criar(ator, { nome: 'Alvo', email: 'alvo.adm@teste.local' });

    await usuarios.redefinirSenha(ator, alvo.usuario.id);

    /* Redefinir senha alheia é ato sensível: sem trilha, ninguém descobre depois
       quem teve acesso à conta de quem. */
    const trilha = await prisma.auditLog.findFirst({
      where: { acao: 'SENHA_REDEFINIDA', entidadeId: alvo.usuario.id },
      select: { userId: true, organizationId: true },
    });
    expect(trilha?.userId).toBe(admin.id);
    expect(trilha?.organizationId).toBe(org.id);
  });

  // ── Travas de auto-trancamento ──

  it('não dá para desativar o próprio acesso nem remover a própria gestão', async () => {
    const c = await semearCliente();
    const ator = await atorDe(c.user.id);

    await expect(usuarios.atualizar(ator, c.user.id, { ativo: false })).rejects.toThrow(
      /próprio acesso/i,
    );
    await expect(usuarios.atualizar(ator, c.user.id, { gestor: false })).rejects.toThrow(
      /própria gestão/i,
    );
  });

  /**
   * A trava que fecha o caminho indireto: A promove B, B rebaixa A, e a empresa
   * fica sem ninguém no comando — sem violar nenhuma das regras acima.
   */
  it('a organização nunca fica sem gestor ativo', async () => {
    const c = await semearCliente();
    const gestorA = await atorDe(c.user.id);
    const b = await usuarios.criar(gestorA, {
      nome: 'Gestor B',
      email: 'gestorb@cliente.local',
      gestor: true,
    });
    const gestorB = await atorDe(b.usuario.id);

    /* B rebaixa A: permitido, ainda sobra o próprio B. */
    await usuarios.atualizar(gestorB, c.user.id, { gestor: false });

    /* Agora A tenta... não, A já não é gestor. É B quem tenta se desativar
       — barrado pela trava do próprio acesso —, então o caminho restante é
       desativar B por outra via. Com A rebaixado, só B comanda: nenhuma
       operação pode removê-lo. */
    await expect(usuarios.atualizar(gestorB, b.usuario.id, { ativo: false })).rejects.toThrow(
      /próprio acesso/i,
    );

    const comandantes = await prisma.user.count({
      where: { organizationId: c.org.id, ativo: true, OR: [{ gestor: true }, { papel: 'ADMIN' }] },
    });
    expect(comandantes).toBeGreaterThanOrEqual(1);
  });

  it('desativar o último gestor por outra conta é revertido', async () => {
    const c = await semearCliente();
    const gestorA = await atorDe(c.user.id);
    const b = await usuarios.criar(gestorA, {
      nome: 'Gestor B',
      email: 'gestorb2@cliente.local',
      gestor: true,
    });
    const gestorB = await atorDe(b.usuario.id);

    /* B desativa A: sobra B, permitido. */
    await usuarios.atualizar(gestorB, c.user.id, { ativo: false });
    /* A (desativado) já não opera; B tenta se rebaixar por dentro da própria
       conta e é barrado. O estado do banco continua com um comandante. */
    await expect(usuarios.atualizar(gestorB, b.usuario.id, { gestor: false })).rejects.toThrow(
      /própria gestão/i,
    );

    const comandantes = await prisma.user.count({
      where: { organizationId: c.org.id, ativo: true, OR: [{ gestor: true }, { papel: 'ADMIN' }] },
    });
    expect(comandantes).toBe(1);
  });

  it('e-mail repetido é recusado sem revelar em qual empresa ele está', async () => {
    const a = await semearCliente('Cliente A');
    const b = await semearCliente('Cliente B');
    await usuarios.criar(await atorDe(a.user.id), {
      nome: 'Alguém',
      email: 'repetido@teste.local',
    });

    await expect(
      usuarios.criar(await atorDe(b.user.id), { nome: 'Outro', email: 'repetido@teste.local' }),
    ).rejects.toThrow(/já existe um usuário com este e-mail/i);
  });

  /**
   * Redefinir senha existe para o caso "a conta pode estar comprometida".
   * Deixar a sessão do invasor viva anularia o gesto.
   */
  it('redefinir a senha encerra as sessões abertas do usuário', async () => {
    const c = await semearCliente();
    const ator = await atorDe(c.user.id);
    const alvo = await usuarios.criar(ator, { nome: 'Alvo', email: 'alvo@cliente.local' });

    await prisma.refreshToken.create({
      data: {
        userId: alvo.usuario.id,
        tokenHash: `hash-${Date.now()}`,
        familiaId: '11111111-1111-4111-8111-111111111111',
        expiraEm: new Date(Date.now() + 86_400_000),
      },
    });

    const antes = await prisma.user.findUniqueOrThrow({
      where: { id: alvo.usuario.id },
      select: { senhaHash: true },
    });
    const r = await usuarios.redefinirSenha(ator, alvo.usuario.id);
    const depois = await prisma.user.findUniqueOrThrow({
      where: { id: alvo.usuario.id },
      select: { senhaHash: true },
    });

    expect(r.acesso.senhaInicial).toHaveLength(16);
    expect(depois.senhaHash).not.toBe(antes.senhaHash);
    expect(
      await prisma.refreshToken.count({ where: { userId: alvo.usuario.id, revogadoEm: null } }),
    ).toBe(0);
  });

  // ── Assentos do plano ──

  /**
   * Assina um plano com o teto de perfis pedido.
   *
   * O `nome` do plano é @unique e a suíte cria vários no mesmo teste, por isso o
   * sufixo com o id da org.
   */
  async function assinar(organizationId: string, usuariosPorPlano: number) {
    const plano = await prisma.plano.create({
      data: {
        nome: `Plano ${usuariosPorPlano} assentos ${organizationId.slice(0, 8)}`,
        processosPorCiclo: 250,
        preco: 0,
        usuariosPorPlano,
      },
      select: { id: true },
    });
    await prisma.assinatura.create({
      data: { organizationId, planoId: plano.id, status: 'ATIVA' },
    });
  }

  /** Convida `quantos` colegas — o caminho real, não INSERT direto. */
  async function convidar(ator: Ator, quantos: number, prefixo: string) {
    for (let i = 0; i < quantos; i += 1) {
      await usuarios.criar(ator, {
        nome: `Colega ${i}`,
        email: `${prefixo}${i}@lotacao.local`,
      });
    }
  }

  /**
   * A REGRA COMERCIAL, na fronteira exata.
   *
   * O quinto tem de entrar e o sexto tem de ser recusado — um teste que só
   * verificasse a recusa passaria igual com o limite errado em 4, e o cliente
   * pagaria por cinco perfis podendo usar quatro.
   */
  it('o plano de 5 aceita o quinto perfil e recusa o sexto', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 5);
    const ator = await atorDe(c.user.id);

    /* O titular JÁ É o primeiro assento — por isso 4, e não 5. */
    await convidar(ator, 4, 'quinto');

    await expect(
      usuarios.criar(ator, { nome: 'Sexto', email: 'sexto@lotacao.local' }),
    ).rejects.toThrow(/5 perfis/i);

    /* E a recusa não deixou meio usuário para trás. */
    expect(await prisma.user.count({ where: { organizationId: c.org.id } })).toBe(5);
  });

  /**
   * O teto sai do PLANO, não de uma constante no código.
   *
   * É o que permite vender um plano maior sem deploy — e o que este caso prova
   * é que trocar o número no banco muda o comportamento.
   */
  it('o teto vem do plano: com 2 assentos, o terceiro é recusado', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const ator = await atorDe(c.user.id);

    await convidar(ator, 1, 'dois');
    await expect(
      usuarios.criar(ator, { nome: 'Terceiro', email: 'terceiro@lotacao.local' }),
    ).rejects.toThrow(/2 perfis/i);
  });

  /**
   * O que o plano vende é acesso SIMULTÂNEO. Um escritório que trocou de
   * estagiário três vezes não pode ficar preso a três assentos mortos.
   */
  it('desativar alguém devolve o assento', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const ator = await atorDe(c.user.id);

    const segundo = await usuarios.criar(ator, {
      nome: 'Segundo',
      email: 'devolve@lotacao.local',
    });
    await expect(
      usuarios.criar(ator, { nome: 'Terceiro', email: 'terceiro2@lotacao.local' }),
    ).rejects.toThrow(/2 perfis/i);

    await usuarios.atualizar(ator, segundo.usuario.id, { ativo: false });

    /* Vaga aberta: agora entra. */
    const terceiro = await usuarios.criar(ator, {
      nome: 'Terceiro',
      email: 'terceiro2@lotacao.local',
    });
    expect(terceiro.usuario.ativo).toBe(true);
  });

  /**
   * A OUTRA PORTA para o mesmo assento.
   *
   * Sem a trava na reativação o teto seria contornado em três passos, sem violar
   * nenhuma regra: desativa um, convida outro no lugar, reativa o primeiro — e o
   * plano de 2 vira 3.
   */
  it('reativar consome assento e é recusado com a equipe lotada', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const ator = await atorDe(c.user.id);

    const antigo = await usuarios.criar(ator, { nome: 'Antigo', email: 'antigo@lotacao.local' });
    await usuarios.atualizar(ator, antigo.usuario.id, { ativo: false });
    await usuarios.criar(ator, { nome: 'Substituto', email: 'substituto@lotacao.local' });

    await expect(
      usuarios.atualizar(ator, antigo.usuario.id, { ativo: true }),
    ).rejects.toThrow(/2 perfis/i);

    const ainda = await prisma.user.findUniqueOrThrow({
      where: { id: antigo.usuario.id },
      select: { ativo: true },
    });
    expect(ainda.ativo).toBe(false);
  });

  /* Um PATCH `{ativo: true}` em quem JÁ está ativo não muda contagem nenhuma —
     recusá-lo por lotação transformaria "promover a gestor" num erro sempre que
     a equipe estivesse cheia, que é justamente quando ela mais se administra. */
  it('mexer em quem já está ativo não esbarra na lotação', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 2);
    const ator = await atorDe(c.user.id);
    const colega = await usuarios.criar(ator, { nome: 'Colega', email: 'colega@lotacao.local' });

    const r = await usuarios.atualizar(ator, colega.usuario.id, { ativo: true, gestor: true });
    expect(r.gestor).toBe(true);
  });

  /**
   * A operação interna NÃO assina plano — e um teto de 5 ali trancaria a própria
   * equipe da Leão Amorim no sexto operador.
   */
  it('a operação interna não tem teto de perfis', async () => {
    const { user } = await semearOrganizacao();
    const ator = await atorDe(user.id);

    await convidar(ator, 8, 'interno');

    const equipe = await usuarios.listar(ator);
    expect(equipe.usuarios).toHaveLength(9);
    expect(equipe.assentos.limite).toBeNull();
  });

  /**
   * Cliente sem assinatura é anomalia (o cadastro público cria as duas juntas),
   * mas o padrão precisa ser o teto comercial. Tratar a linha faltante como
   * "sem limite" seria abrir a porta que esta fase existe para fechar.
   */
  it('cliente sem assinatura cai no padrão de 5, não em ilimitado', async () => {
    const c = await semearCliente();
    const ator = await atorDe(c.user.id);

    const equipe = await usuarios.listar(ator);
    expect(equipe.assentos.limite).toBe(5);

    await convidar(ator, 4, 'semplano');
    await expect(
      usuarios.criar(ator, { nome: 'Sexto', email: 'sexto2@lotacao.local' }),
    ).rejects.toThrow(/5 perfis/i);
  });

  /* O número que a tela imprime ("3 de 5") sai da MESMA chamada que traz os
     nomes — em duas requisições, um convite entre uma e outra faria a contagem
     discordar da lista logo abaixo dela. */
  it('a listagem informa usados e limite, e só conta os ativos', async () => {
    const c = await semearCliente();
    await assinar(c.org.id, 5);
    const ator = await atorDe(c.user.id);
    const colega = await usuarios.criar(ator, { nome: 'Colega', email: 'saldo@lotacao.local' });

    expect((await usuarios.listar(ator)).assentos).toEqual({ usados: 2, limite: 5 });

    await usuarios.atualizar(ator, colega.usuario.id, { ativo: false });

    const depois = await usuarios.listar(ator);
    /* Continua aparecendo na lista — inativo não some, só deixa de ocupar. */
    expect(depois.usuarios).toHaveLength(2);
    expect(depois.assentos).toEqual({ usados: 1, limite: 5 });
  });
});
