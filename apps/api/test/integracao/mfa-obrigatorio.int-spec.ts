/**
 * ⚠ ISTO PRECISA VIR ANTES DE QUALQUER IMPORT QUE ALCANCE O `AppModule`.
 *
 * `ConfigModule.forRoot` lê e valida o `process.env` SINCRONAMENTE, no instante
 * em que o decorator do `AppModule` é avaliado — ou seja, no `require` do
 * módulo. Definir a variável depois do import não muda nada. Por isso a
 * atribuição fica aqui em cima, e o `app-de-teste` (que importa o AppModule)
 * entra por `import()` dinâmico dentro do `beforeAll`.
 *
 * E como o jest roda `--runInBand` num processo só, `process.env` é
 * COMPARTILHADO entre os arquivos de teste: o `afterAll` restaura o valor
 * anterior, senão todo spec que rodasse depois deste subiria com a política
 * ligada e veria 403 onde espera 200.
 */
const POLITICA_ANTERIOR = process.env.MFA_OBRIGATORIO;
process.env.MFA_OBRIGATORIO = 'todos';

import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthService } from '../../src/modules/auth/application/auth.service';
import { MfaService } from '../../src/modules/auth/application/mfa.service';
import { gerarCodigo } from '../../src/modules/auth/application/totp';
import { prisma, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * MFA obrigatório para TODOS — o ciclo que impede a tranca.
 *
 * O `render.yaml` segurou a política em `nenhum` por um medo concreto: "exigir
 * MFA antes de haver cadastro tranca todo mundo na tela de cadastro, inclusive
 * o dono". O guard foi desenhado para desfazer esse medo — quem está em falta
 * ENTRA e resolve sozinho — mas com `nenhum` esse desenho nunca rodou. Este
 * arquivo é a prova de que ele funciona, feita ANTES de virar a chave.
 *
 * O que se afere é o caminho do usuário, pela API real com todos os guards
 * globais na ordem de produção: entra, toma 403, cadastra, confirma, e a mesma
 * rota passa — com o MESMO token, sem novo login.
 */
describe('MFA obrigatório para todos', () => {
  let app: INestApplication;
  let base: string;

  const SENHA = 'SenhaForte#2026';

  beforeAll(async () => {
    const { criarAppDeTeste } = await import('./app-de-teste');
    ({ app, base } = await criarAppDeTeste());
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

  /** ADMIN de uma organização interna: alcança /fila/estado, que não é isenta. */
  async function usuarioSemMfa() {
    const { org } = await semearOrganizacao();
    return prisma.user.create({
      data: {
        organizationId: org.id,
        email: `politica${Date.now()}${Math.floor(Math.random() * 1000)}@teste.local`,
        nome: 'Sem segundo fator',
        papel: 'ADMIN',
        senhaHash: await AuthService.gerarHash(SENHA),
        emailConfirmadoEm: new Date(),
      },
      select: { id: true, email: true },
    });
  }

  async function entrar(email: string) {
    const r = await http().post(`${base}/auth/login`).send({ email, senha: SENHA }).expect(200);
    return r.body as { accessToken?: string; mfaRequerido?: boolean; desafio?: string };
  }

  const com = (token: string) => (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

  it('a política está ligada NESTE app — senão o resto do arquivo passa por engano', () => {
    expect(app.get(ConfigService).get('MFA_OBRIGATORIO')).toBe('todos');
  });

  it('quem não tem MFA ENTRA: a senha continua valendo e o token sai', async () => {
    /* A alternativa — o login recusar — deixaria a pessoa sem sessão nenhuma, e
       sem sessão ela não alcança a tela de cadastro. */
    const u = await usuarioSemMfa();
    const login = await entrar(u.email);
    expect(login.accessToken).toBeTruthy();
    expect(login.mfaRequerido).toBeFalsy();
  });

  it('…mas não alcança rota comum: 403 com o código que o front lê para redirecionar', async () => {
    const u = await usuarioSemMfa();
    const { accessToken } = await entrar(u.email);

    const r = await com(accessToken!)(http().get(`${base}/fila/estado`)).expect(403);

    /* `erro`, em português, é o que `lib/api.ts` inspeciona — e o guard lança
       `error`. Este caso prova que o filtro de exceção traduz um no outro; sem
       isso o redirecionamento nunca dispararia e o usuário veria "acesso
       negado" sem saber que a saída é cadastrar o segundo fator. */
    expect(r.body.erro).toBe('MFA_OBRIGATORIO');
  });

  it('as rotas da tela de cadastro passam para quem está em falta', async () => {
    const u = await usuarioSemMfa();
    const { accessToken } = await entrar(u.email);
    const auth = com(accessToken!);

    await auth(http().get(`${base}/auth/eu`)).expect(200);
    const situacao = await auth(http().get(`${base}/auth/mfa`)).expect(200);
    expect(situacao.body.obrigatorio).toBe(true);
    expect(situacao.body.habilitado).toBe(false);
    const inicio = await auth(http().post(`${base}/auth/mfa/cadastrar`)).expect(200);
    expect(inicio.body.segredo).toBeTruthy();
    expect(inicio.body.uri).toBeTruthy();
  });

  it('O CICLO: 403 → cadastra → confirma → a MESMA rota passa, com o MESMO token', async () => {
    const u = await usuarioSemMfa();
    const { accessToken } = await entrar(u.email);
    const auth = com(accessToken!);

    await auth(http().get(`${base}/fila/estado`)).expect(403);

    const { body } = await auth(http().post(`${base}/auth/mfa/cadastrar`)).expect(200);
    /* O código do período ANTERIOR: confirmar gasta o contador daquele período,
       e o anti-replay recusa qualquer código igual ou mais antigo. */
    await auth(http().post(`${base}/auth/mfa/confirmar`))
      .send({ codigo: gerarCodigo(body.segredo, agora() - 30) })
      .expect(200);

    /* Sem novo login. `mfaHabilitado` é relido do banco pela JwtStrategy a cada
       requisição — cadastrou, a próxima passa. Se viesse assado no token, a
       pessoa ficaria trancada até ele expirar, com o MFA já cadastrado. */
    await auth(http().get(`${base}/fila/estado`)).expect(200);
  });

  it('quem já tem MFA passa pelo desafio e chega às rotas comuns', async () => {
    const u = await usuarioSemMfa();
    const mfa = app.get(MfaService);
    const { segredo } = await mfa.iniciarCadastro(u.id);
    await mfa.confirmarCadastro(u.id, gerarCodigo(segredo, agora() - 30));

    const login = await entrar(u.email);
    expect(login.mfaRequerido).toBe(true);
    expect(login.accessToken).toBeUndefined();

    const v = await http()
      .post(`${base}/auth/mfa/verificar`)
      .send({ desafio: login.desafio, codigo: gerarCodigo(segredo, agora()) })
      .expect(200);

    await com(v.body.accessToken)(http().get(`${base}/fila/estado`)).expect(200);
  });
});
