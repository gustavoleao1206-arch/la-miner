import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { criarAppDeTeste, criarUsuario } from './app-de-teste';
import {
  prisma,
  limparDados,
  semearOrganizacao,
  semearProcesso,
  semearCliente,
  encerrar,
} from './ambiente';

/**
 * Testes de CONTROLLER: exercitam a cadeia HTTP inteira — guard de autenticação,
 * guard de papel, ValidationPipe, ParseUUIDPipe, filtro de exceção e a trilha de
 * auditoria. A regra de negócio já tem cobertura nos testes de service; aqui o
 * alvo é o que só o transporte impõe.
 */
describe('Controllers (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let tokenPara: (userId: string) => Promise<string>;

  beforeAll(async () => {
    ({ app, base, tokenPara } = await criarAppDeTeste());
  });
  afterAll(async () => {
    await app.close();
    await encerrar();
  });
  beforeEach(async () => {
    await limparDados();
  });

  const http = () => request(app.getHttpServer());

  // ── Autenticação (JwtAuthGuard global) ──
  describe('autenticação', () => {
    it('sem token → 401', async () => {
      await http().get(`${base}/carteira/resumo`).expect(401);
    });

    it('token com assinatura inválida → 401', async () => {
      await http()
        .get(`${base}/carteira/resumo`)
        .set('Authorization', 'Bearer nao.e.um.jwt')
        .expect(401);
    });

    /**
     * A strategy relê o usuário do banco a cada requisição. Um token válido de
     * um usuário DESATIVADO tem de ser recusado — é o que fecha a janela entre
     * a desativação e a expiração do access token de 15 min.
     */
    it('token de usuário desativado → 401', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { ativo: false } });

      await http().get(`${base}/carteira/resumo`).set('Authorization', `Bearer ${token}`).expect(401);
    });
  });

  // ── Autorização (RolesGuard global) ──
  describe('autorização por papel', () => {
    /**
     * CLIENTE não enxerga a base: são 3.974 documentos com telefone, e-mail e
     * cidade.
     *
     * A INTENÇÃO é a mesma de sempre; o que mudou foi a FORMA. Antes a proteção
     * era um 403 na porta. Agora a porta precisa estar aberta — é por ela que o
     * assinante lê a própria carteira —, e quem protege é o ESCOPO: sem
     * liberação, a carteira vem vazia.
     *
     * Repare que este CLIENTE está numa org INTERNA (configuração legada, que o
     * enum Papel ainda descreve como "apenas consulta o banco interno"). O escopo
     * fecha mesmo assim, porque `escopoProcessos` trata papel CLIENTE como
     * cliente INDEPENDENTE do tipo da org — dos dois sinais vale o mais
     * restritivo. Sem esse cuidado, este usuário herdaria a base inteira.
     */
    it('CLIENTE não enxerga a base: a carteira vem vazia sem liberação', async () => {
      const { org } = await semearOrganizacao();
      await semearProcesso({ organizationId: org.id });
      const cliente = await criarUsuario(org.id, 'CLIENTE');
      const token = await tokenPara(cliente.id);

      const r = await http()
        .get(`${base}/carteira/resumo`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(r.body.processos).toBe(0);
      expect(r.body.pessoas).toBe(0);
      /* E sem o vocabulário do enriquecimento — a projeção do cliente. */
      expect(r.body).not.toHaveProperty('enriquecidas');
      expect(r.body).not.toHaveProperty('pendentes');
    });

    /**
     * "Suspensa = sem acesso, dados preservados" precisa de dentes. Cortar só os
     * lotes novos deixaria o inadimplente usando para sempre a carteira que já
     * recebeu — a alavanca comercial não existiria.
     *
     * 402 e não 403: ele não está proibido, está devendo, e a tela precisa saber
     * a diferença para oferecer "regularizar" em vez de "sem permissão".
     */
    it('cliente com assinatura SUSPENSA recebe 402; ATIVA passa', async () => {
      const assinar = async (organizationId: string, status: 'ATIVA' | 'SUSPENSA') => {
        const plano = await prisma.plano.create({
          data: {
            nome: `Plano ${Math.random().toString(36).slice(2, 8)}`,
            processosPorCiclo: 10,
            preco: 100,
          },
          select: { id: true },
        });
        await prisma.assinatura.create({
          data: { organizationId, planoId: plano.id, status },
        });
      };

      const suspenso = await semearCliente('Cliente Suspenso');
      await assinar(suspenso.org.id, 'SUSPENSA');
      await http()
        .get(`${base}/carteira/resumo`)
        .set('Authorization', `Bearer ${await tokenPara(suspenso.user.id)}`)
        .expect(402);

      const emDia = await semearCliente('Cliente em Dia');
      await assinar(emDia.org.id, 'ATIVA');
      await http()
        .get(`${base}/carteira/resumo`)
        .set('Authorization', `Bearer ${await tokenPara(emDia.user.id)}`)
        .expect(200);
    });

    it('CLIENTE segue barrado nas superfícies administrativas', async () => {
      const { org } = await semearOrganizacao();
      const cliente = await criarUsuario(org.id, 'CLIENTE');
      const token = await tokenPara(cliente.id);

      for (const rota of ['/fila/estado', '/importacao', '/auditoria/resumo', '/distribuicao/clientes']) {
        await http().get(`${base}${rota}`).set('Authorization', `Bearer ${token}`).expect(403);
      }
    });

    it('OPERADOR e ADMIN passam', async () => {
      const { org } = await semearOrganizacao();
      for (const papel of ['OPERADOR', 'ADMIN'] as const) {
        const u = await criarUsuario(org.id, papel);
        const token = await tokenPara(u.id);
        await http()
          .get(`${base}/carteira/tribunais`)
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
    });
  });

  // ── Validação de DTO e de parâmetro ──
  describe('validação de entrada', () => {
    async function tokenAdmin() {
      const { user } = await semearOrganizacao();
      return { token: await tokenPara(user.id), user };
    }

    it('id malformado → 400 (ParseUUIDPipe), não 500', async () => {
      const { token } = await tokenAdmin();
      await http()
        .get(`${base}/carteira/processos/nao-e-uuid`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('uuid válido mas inexistente → 404', async () => {
      const { token } = await tokenAdmin();
      await http()
        .get(`${base}/carteira/processos/00000000-0000-4000-8000-000000000000`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('anotação sem texto → 400', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      await http()
        .post(`${base}/carteira/processos/${processo.id}/anotacoes`)
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    /**
     * `forbidNonWhitelisted`: campo não declarado no DTO é RECUSADO, não
     * ignorado. Sem isso, um cliente poderia mandar `{ texto, autorId }` e — se
     * um refactor futuro confiasse no corpo — sobrescrever o autor. O DTO é a
     * fronteira, e o teste garante que ela rejeita o excedente.
     */
    it('campo estranho no corpo → 400', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      await http()
        .post(`${base}/carteira/processos/${processo.id}/anotacoes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ texto: 'ok', autorId: 'tentativa-de-forjar-autor' })
        .expect(400);
    });

    it('prioridade fora do enum → 400', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      await http()
        .patch(`${base}/carteira/processos/${processo.id}/prioridade`)
        .set('Authorization', `Bearer ${token}`)
        .send({ prioridade: 'SUPER_URGENTE' })
        .expect(400);
    });

    it('prazo em formato errado → 400 (a API recusa ISO com hora)', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      await http()
        .post(`${base}/carteira/processos/${processo.id}/tarefas`)
        .set('Authorization', `Bearer ${token}`)
        .send({ titulo: 'x', prazo: '2026-07-25T00:00:00Z' })
        .expect(400);
    });

    it('tribunal sem exercício no painel → 400 (os dois andam juntos)', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);

      await http()
        .get(`${base}/carteira/resumo?tribunal=TRF5`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  // ── Caminho feliz e forma da resposta ──
  describe('respostas', () => {
    it('cria anotação → 201 com autor resolvido', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      const r = await http()
        .post(`${base}/carteira/processos/${processo.id}/anotacoes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ texto: 'primeira anotação' })
        .expect(201);

      expect(r.body).toMatchObject({
        texto: 'primeira anotação',
        fixada: false,
        autor: { id: user.id },
      });
    });

    /**
     * O autor vem SEMPRE do token, nunca do corpo. Aqui o texto passa
     * (forbidNonWhitelisted só barra campo desconhecido, e não há campo `autor`
     * no corpo), e o autor gravado tem de ser o dono do token.
     */
    it('o autor da anotação é o dono do token, não quem o corpo disser', async () => {
      const { org, user } = await semearOrganizacao();
      const outro = await criarUsuario(org.id, 'OPERADOR');
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      const r = await http()
        .post(`${base}/carteira/processos/${processo.id}/anotacoes`)
        .set('Authorization', `Bearer ${token}`)
        .send({ texto: 'x' })
        .expect(201);

      expect(r.body.autor.id).toBe(user.id);
      expect(r.body.autor.id).not.toBe(outro.id);
    });
  });

  // ── Auditoria (LGPD) ──
  describe('trilha de auditoria', () => {
    /**
     * Abrir um processo é consulta a dado pessoal e tem de deixar rastro. E o
     * `contatoExibido` é MEDIDO: um processo cuja parte não tem contato ativo
     * registra `false`, senão o indicador que a LGPD usa para dimensionar
     * exposição nasceria inflado.
     */
    it('abrir processo grava consulta com contatoExibido medido', async () => {
      const { org, user } = await semearOrganizacao();
      const token = await tokenPara(user.id);
      const processo = await semearProcesso({ organizationId: org.id });

      // Uma parte SEM contato ativo.
      const pessoa = await prisma.pessoa.create({
        data: { cpf: '52998224725', nome: 'FULANO', nomeNormalizado: 'FULANO' },
        select: { id: true },
      });
      await prisma.processoPessoa.create({
        data: { processoId: processo.id, pessoaId: pessoa.id },
      });

      await http()
        .get(`${base}/carteira/processos/${processo.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const consulta = await prisma.consultaCliente.findFirstOrThrow({
        where: { tipo: 'PROCESSO' },
      });
      expect(consulta.userId).toBe(user.id);
      expect(consulta.termo).toBe(processo.numeroPrecatorio);
      expect(consulta.contatoExibido).toBe(false); // parte sem contato ativo
    });

    it('processo inexistente NÃO gera consulta (nada foi divulgado)', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);

      await http()
        .get(`${base}/carteira/processos/00000000-0000-4000-8000-000000000000`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(await prisma.consultaCliente.count()).toBe(0);
    });

    /**
     * A trilha do titular é POST com o CPF no CORPO — nunca no caminho.
     *
     * Na URL o CPF entra no log de acesso do proxy, que não é nosso e não se
     * apaga a pedido do titular (LGPD art. 18). É a rota que mostra TUDO sobre
     * uma pessoa: é a que menos pode deixar rastro fora do nosso alcance.
     */
    it('trilha do titular responde 200 com o CPF no corpo', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);

      const r = await http()
        .post(`${base}/auditoria/trilha-cpf`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cpf: '52998224725' })
        /* 200, não 201: é consulta. 201 faria cliente e monitoração lerem
           escrita justo na rota que prova que a trilha não é escrita aqui. */
        .expect(200);

      expect(r.body).toHaveProperty('consultas');
    });

    it('a rota antiga com CPF no caminho não existe mais', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);

      await http()
        .get(`${base}/auditoria/cpf/52998224725`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('CPF inválido é recusado antes de qualquer ida ao banco', async () => {
      const { user } = await semearOrganizacao();
      const token = await tokenPara(user.id);

      await http()
        .post(`${base}/auditoria/trilha-cpf`)
        .set('Authorization', `Bearer ${token}`)
        .send({ cpf: '123' })
        .expect(400);
    });
  });
});
