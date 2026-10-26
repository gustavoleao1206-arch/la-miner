/**
 * ⚠ ANTES DE QUALQUER IMPORT QUE ALCANCE O `AppModule` — ver a nota longa em
 * `mfa-obrigatorio.int-spec.ts`: o `ConfigModule` lê o `process.env` no
 * `require` do módulo, e `--runInBand` compartilha o ambiente entre arquivos.
 *
 * Aqui a política LIGADA não é cenário extra: é O ÚNICO ambiente em que esta
 * rota existe. Com `nenhum` (o default), o `MfaObrigatorioGuard` sai na primeira
 * linha e os casos abaixo passariam sem exercitar guard nenhum — e o admin do
 * cenário, que não teria segundo fator, é um ator IMPOSSÍVEL sob `todos`.
 */
const POLITICA_ANTERIOR = process.env.MFA_OBRIGATORIO;
process.env.MFA_OBRIGATORIO = 'todos';

import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthService } from '../../src/modules/auth/application/auth.service';
import { MfaService } from '../../src/modules/auth/application/mfa.service';
import { gerarCodigo } from '../../src/modules/auth/application/totp';
import { prisma, observador, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * A SAÍDA DE EMERGÊNCIA do MFA obrigatório.
 *
 * Ligar `MFA_OBRIGATORIO=todos` fechou um vão e abriu outro: quem perde o
 * telefone usa um dos dez códigos de recuperação, mas quem perde o telefone E os
 * códigos não tinha saída nenhuma pelo sistema. O que restava era `UPDATE` à mão
 * na shell do banco — sem reconfirmar quem executa, sem recorte de organização e
 * sem deixar rastro de que um fator de autenticação foi removido.
 *
 * O que os casos defendem NÃO é o caminho feliz (esse é uma linha): é cada uma
 * das travas, porque é delas que depende a rota não virar escalonamento de
 * privilégio — inclusive contra o próprio admin que a opera.
 */
describe('ADMIN zera o MFA de outro usuário', () => {
  let app: INestApplication;
  let base: string;
  let tokenPara: (userId: string) => Promise<string>;
  let mfa: MfaService;

  const SENHA_ADMIN = 'SenhaDoAdmin#2026';

  beforeAll(async () => {
    const { criarAppDeTeste } = await import('./app-de-teste');
    ({ app, base, tokenPara } = await criarAppDeTeste());
    mfa = app.get(MfaService);
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
    if (POLITICA_ANTERIOR === undefined) delete process.env.MFA_OBRIGATORIO;
    else process.env.MFA_OBRIGATORIO = POLITICA_ANTERIOR;
  });
  beforeEach(limparDados);

  const http = () => request(app.getHttpServer());
  const agora = () => Math.floor(Date.now() / 1000);
  let n = 0;
  const email = (p: string) => `${p}${Date.now()}${n++}@teste.local`;

  async function criar(organizationId: string, papel: 'ADMIN' | 'OPERADOR', senha?: string) {
    return prisma.user.create({
      data: {
        organizationId,
        email: email(papel.toLowerCase()),
        nome: `Usuário ${papel}`,
        papel,
        senhaHash: senha ? await AuthService.gerarHash(senha) : 'nao-e-um-hash-valido',
        emailConfirmadoEm: new Date(),
      },
      select: { id: true, email: true },
    });
  }

  /** Cadastra e confirma o MFA de alguém, deixando os dez códigos. */
  async function comMfa(userId: string) {
    const { segredo } = await mfa.iniciarCadastro(userId);
    await mfa.confirmarCadastro(userId, gerarCodigo(segredo, agora() - 30));
  }

  /**
   * ADMIN da organização INTERNA, COM segundo fator, e um alvo também com MFA.
   *
   * O admin ter MFA não é detalhe de cenário: sem ele, a rota responde 403 antes
   * do handler sob `todos`, e nenhum destes casos exercitaria a rota.
   */
  async function cenario() {
    const { org } = await semearOrganizacao();
    const admin = await criar(org.id, 'ADMIN', SENHA_ADMIN);
    await comMfa(admin.id);
    const alvo = await criar(org.id, 'OPERADOR');
    await comMfa(alvo.id);
    return { org, admin, alvo, token: await tokenPara(admin.id) };
  }

  const zerar = (token: string, corpo: Record<string, unknown>) =>
    http().post(`${base}/auth/mfa/zerar`).set('Authorization', `Bearer ${token}`).send(corpo);

  async function estadoMfa(userId: string) {
    const u = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSegredo: true, mfaConfirmadoEm: true, mfaUltimoContador: true },
    });
    const codigos = await prisma.mfaCodigoRecuperacao.count({ where: { userId } });
    return { ...u, codigos };
  }

  it('a política está LIGADA neste app — senão o arquivo inteiro passa por engano', () => {
    expect(app.get(ConfigService).get('MFA_OBRIGATORIO')).toBe('todos');
  });

  it('zera o segundo fator do alvo e apaga os códigos de recuperação dele', async () => {
    const { admin, alvo, token } = await cenario();
    expect((await estadoMfa(alvo.id)).codigos).toBe(10);

    const r = await zerar(token, { usuarioId: alvo.id, senha: SENHA_ADMIN }).expect(200);

    expect(r.body).toEqual({ alvo: alvo.email, tinhaMfa: true });
    const depois = await estadoMfa(alvo.id);
    expect(depois.mfaSegredo).toBeNull();
    expect(depois.mfaConfirmadoEm).toBeNull();
    expect(depois.mfaUltimoContador).toBeNull();
    /* Os códigos velhos morrem junto: sobreviver ao reset os deixaria valendo
       para um segredo que não existe mais. */
    expect(depois.codigos).toBe(0);
    /* E o admin sai INTACTO — com o cenário dando MFA a ele, esta asserção pode
       falhar de verdade. Antes ela conferia que um campo já nulo seguia nulo. */
    expect((await estadoMfa(admin.id)).mfaConfirmadoEm).not.toBeNull();
  });

  /**
   * ⚠ A REGRESSÃO MAIS IMPORTANTE DESTE ARQUIVO.
   *
   * A trava do próprio id comparava `ator.id === alvoId`, com o id CRU do corpo.
   * `@IsUUID('4')` aceita maiúsculas, a coluna é `@db.Uuid` e o Postgres compara
   * uuid por VALOR — então o `findUnique` achava a linha e só a comparação de
   * string em JavaScript falhava. O ADMIN mandava o próprio id em caixa alta,
   * zerava o próprio segundo fator, e seguia para `/auth/mfa/cadastrar` para
   * registrar o autenticador DELE: posse permanente da conta.
   */
  it('o próprio id em MAIÚSCULAS não escapa da trava — pela porta HTTP', async () => {
    const { admin, token } = await cenario();

    await zerar(token, { usuarioId: admin.id.toUpperCase(), senha: SENHA_ADMIN }).expect(400);

    expect((await estadoMfa(admin.id)).mfaConfirmadoEm).not.toBeNull();
    expect(await observador.auditLog.count({ where: { acao: 'MFA_ZERADO_POR_ADMIN' } })).toBe(0);
  });

  /**
   * ⚠ E O MESMO ATAQUE DIRETO NO SERVIÇO, SEM PASSAR PELO DTO.
   *
   * O caso acima, sozinho, é VAZIO — e eu comprovei isso: reintroduzi o defeito
   * (`ator.id === alvoId`, o id cru do corpo) e ele continuou verde, porque o
   * `@Transform` do DTO abaixa a caixa antes de o serviço ver qualquer coisa.
   * Ele prova a segunda camada e chama isso de primeira.
   *
   * A defesa que importa é comparar o id que o BANCO devolve, e só se alcança
   * ela chamando o método direto. Com o defeito reintroduzido, ESTE caso falha —
   * foi assim que ele foi conferido.
   */
  it('…e no SERVIÇO, onde a defesa de verdade mora', async () => {
    const { org, admin } = await cenario();

    await expect(
      mfa.zerarDeOutroUsuario(
        { id: admin.id, organizationId: org.id },
        admin.id.toUpperCase(),
        SENHA_ADMIN,
      ),
    ).rejects.toThrow(/desbloquear OUTRA pessoa/);

    expect((await estadoMfa(admin.id)).mfaConfirmadoEm).not.toBeNull();
    expect(await observador.auditLog.count({ where: { acao: 'MFA_ZERADO_POR_ADMIN' } })).toBe(0);
  });

  it('id do alvo em MAIÚSCULAS funciona, e a trilha guarda o id CANÔNICO', async () => {
    /* O outro lado da mesma moeda: caixa alta não pode quebrar o uso legítimo, e
       `AuditLog.entidadeId` é String sem `@db.Uuid` — gravaria a caixa que veio
       no corpo, e um relatório filtrando pelo id canônico não acharia o evento. */
    const { alvo, token } = await cenario();

    await zerar(token, { usuarioId: alvo.id.toUpperCase(), senha: SENHA_ADMIN }).expect(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { acao: 'MFA_ZERADO_POR_ADMIN' },
    });
    expect(log.entidadeId).toBe(alvo.id);
  });

  it('DEIXA RASTRO: quem zerou o de quem', async () => {
    const { admin, alvo, token } = await cenario();

    await zerar(token, { usuarioId: alvo.id, senha: SENHA_ADMIN }).expect(200);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { acao: 'MFA_ZERADO_POR_ADMIN' },
    });
    expect(log.userId).toBe(admin.id); // o ATOR responde pela ação
    expect(log.entidadeId).toBe(alvo.id); // o ALVO é a entidade tocada
    expect(log.dadosAntes).toEqual({ mfaHabilitado: true });
    expect(log.dadosDepois).toEqual({ mfaHabilitado: false });
    expect(JSON.stringify(log)).not.toContain(SENHA_ADMIN);
  });

  it('ADMIN SEM segundo fator não alcança a rota — ela não é porta de fuga da política', async () => {
    /* A rota não é @SemMfa de propósito: seria absurdo que a rota que restaura o
       MFA alheio fosse a brecha para contornar a exigência. Hoje isso estava
       afirmado só em comentário; aqui vira asserção. */
    const { org } = await semearOrganizacao();
    const semMfa = await criar(org.id, 'ADMIN', SENHA_ADMIN);
    const alvo = await criar(org.id, 'OPERADOR');
    await comMfa(alvo.id);

    const r = await zerar(await tokenPara(semMfa.id), {
      usuarioId: alvo.id,
      senha: SENHA_ADMIN,
    }).expect(403);

    expect(r.body.erro).toBe('MFA_OBRIGATORIO');
    expect((await estadoMfa(alvo.id)).mfaConfirmadoEm).not.toBeNull();
  });

  it('senha errada do admin NÃO zera nada', async () => {
    const { alvo, token } = await cenario();

    await zerar(token, { usuarioId: alvo.id, senha: 'senha-errada' }).expect(401);

    expect((await estadoMfa(alvo.id)).mfaConfirmadoEm).not.toBeNull();
    expect(await observador.auditLog.count({ where: { acao: 'MFA_ZERADO_POR_ADMIN' } })).toBe(0);
  });

  it('não alcança usuário de OUTRA organização', async () => {
    const { token } = await cenario();
    const outra = await prisma.organization.create({
      data: { nome: 'Escritório Alheio', tipo: 'CLIENTE', cnpj: `${Date.now()}`.slice(-14) },
      select: { id: true },
    });
    const alheio = await criar(outra.id, 'OPERADOR');
    await comMfa(alheio.id);

    const r = await zerar(token, { usuarioId: alheio.id, senha: SENHA_ADMIN }).expect(400);

    /* Mesma mensagem de "não existe": distinguir os dois casos transformaria a
       rota num oráculo de existência de usuário na plataforma. */
    expect(r.body.mensagem ?? r.body.message).toMatch(/não encontrado nesta organização/i);
    expect((await estadoMfa(alheio.id)).mfaConfirmadoEm).not.toBeNull();
  });

  it('usuário inexistente responde igual a usuário de outra organização', async () => {
    const { token } = await cenario();
    const r = await zerar(token, {
      usuarioId: '00000000-0000-4000-8000-000000000000',
      senha: SENHA_ADMIN,
    }).expect(400);
    expect(r.body.mensagem ?? r.body.message).toMatch(/não encontrado nesta organização/i);
  });

  it('OPERADOR não alcança a rota', async () => {
    const { org, alvo } = await cenario();
    const operador = await criar(org.id, 'OPERADOR', SENHA_ADMIN);
    await comMfa(operador.id);

    await zerar(await tokenPara(operador.id), {
      usuarioId: alvo.id,
      senha: SENHA_ADMIN,
    }).expect(403);

    expect((await estadoMfa(alvo.id)).mfaConfirmadoEm).not.toBeNull();
  });

  it('ADMIN de organização CLIENTE é barrado pelo guard de operação interna', async () => {
    /* Mesma classe do R-13: ADMIN é coluna de User, não papel de operação. */
    const cliente = await prisma.organization.create({
      data: { nome: 'Escritório Cliente', tipo: 'CLIENTE', cnpj: `${Date.now()}`.slice(-14) },
      select: { id: true },
    });
    const adminCliente = await criar(cliente.id, 'ADMIN', SENHA_ADMIN);
    await comMfa(adminCliente.id);
    const colega = await criar(cliente.id, 'OPERADOR');
    await comMfa(colega.id);

    await zerar(await tokenPara(adminCliente.id), {
      usuarioId: colega.id,
      senha: SENHA_ADMIN,
    }).expect(403);

    expect((await estadoMfa(colega.id)).mfaConfirmadoEm).not.toBeNull();
  });

  it('id malformado é 400 do validador, sem chegar ao serviço', async () => {
    const { token } = await cenario();
    await zerar(token, { usuarioId: 'nao-e-uuid', senha: SENHA_ADMIN }).expect(400);
  });

  it('zerar quem NÃO tinha MFA é aceito, e o retorno diz isso', async () => {
    /* Desbloqueio precisa ser idempotente na prática: quem opera não sabe de cor
       se o alvo chegou a confirmar o cadastro. */
    const { org, token } = await cenario();
    const semMfa = await criar(org.id, 'OPERADOR');

    const r = await zerar(token, { usuarioId: semMfa.id, senha: SENHA_ADMIN }).expect(200);

    expect(r.body.tinhaMfa).toBe(false);
  });
});
