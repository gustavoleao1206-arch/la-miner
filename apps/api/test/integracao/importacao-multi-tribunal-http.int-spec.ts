import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { criarAppDeTeste } from './app-de-teste';
import { prisma, observador, limparDados, semearOrganizacao, encerrar } from './ambiente';

/**
 * A IMPORTAÇÃO MULTI-TRIBUNAL, PELA ROTA — e não pelo serviço.
 *
 * ── O VÃO QUE ESTE ARQUIVO FECHA ──
 *
 * Em 04/09/2026 o `ImportacaoService` ganhou `perfilId`, o worker aprendeu a
 * processar carga multi-tribunal, o perfil "Pré-precatórios (multi-tribunal)"
 * foi gravado por migration e a tela de pré-precatórios foi construída. Tudo
 * coberto por testes.
 *
 * E mesmo assim era impossível importar: `POST /importacao` aceitava só
 * `tribunal` e `exercicio`, e chamava o serviço SEM `perfilId`. Um `grep` em
 * `apps/api/src` não achava um único chamador. O motor estava inteiro e não
 * havia estrada até ele.
 *
 * A suíte não pegou porque toda a cobertura chamava o serviço DIRETO, passando
 * `perfilId` na mão — ou seja, contornando exatamente o trecho que faltava. Um
 * teste que pula o transporte não prova que o transporte existe.
 *
 * Por isso todo caso aqui sobe pelo HTTP. É a única forma que teria falhado
 * antes da correção.
 */
describe('Importação multi-tribunal (HTTP)', () => {
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
  beforeEach(limparDados);

  const http = () => request(app.getHttpServer());

  /** O perfil que a migration gravou — o de tribunal NULO. */
  const perfilMulti = () =>
    prisma.perfilImportacao.findFirstOrThrow({
      where: { tribunalId: null, ativo: true },
      select: { id: true, nome: true },
    });

  /**
   * Uma planilha com DOIS tribunais diferentes, que é o ponto inteiro do modo.
   *
   * CSV e não .xlsx de propósito: o `parsear` só consulta a aba do perfil em
   * arquivo binário, então o CSV exercita o mesmo caminho sem precisar montar
   * uma pasta de trabalho só para nomear a aba.
   *
   * As duas formas da fase aparecem juntas — o código numérico numa linha, o
   * texto na outra — porque as duas chegam do arquivo real.
   */
  const CSV_DOIS_TRIBUNAIS = [
    'CPF do credor,Credor,Processo,Tribunal,Fase,Valor extraído',
    '52998224725,MARIA DE SOUZA SANTOS,1000101-11.2023.8.13.0024,TJMG,2,250000',
    '39053344705,JOAO PEREIRA SILVA,2000202-22.2022.8.26.0100,TJSP,Trânsito em julgado,180000',
  ].join('\n');

  async function comoAdmin() {
    const { user } = await semearOrganizacao();
    return tokenPara(user.id);
  }

  function enviar(token: string, query: string, csv = CSV_DOIS_TRIBUNAIS) {
    return http()
      .post(`${base}/importacao${query}`)
      .set('Authorization', `Bearer ${token}`)
      .attach('arquivo', Buffer.from(csv, 'utf-8'), 'pre-precatorios.csv');
  }

  // ────────────────────────────────────────────────────────────
  describe('GET /importacao/perfis', () => {
    it('⚠ lista os perfis — e a rota NÃO é engolida por /importacao/:id', async () => {
      /**
       * O Nest casa rotas na ordem de declaração. Com `@Get(':id')` antes, esta
       * chamada entraria no handler de estado com `id = "perfis"` e voltaria 404
       * de "importação não encontrada" — mandando procurar o defeito no lugar
       * errado. Um array aqui prova as duas coisas: a rota existe E está na
       * ordem certa.
       */
      const token = await comoAdmin();

      const r = await http()
        .get(`${base}/importacao/perfis`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBeGreaterThan(0);
    });

    it('o perfil sem tribunal se declara multi-tribunal, e os dos TRFs não', async () => {
      /* `multiTribunal` é derivado no servidor para a tela não ter de reinventar
         o teste `tribunal === null` — e divergir dele na próxima mudança. */
      const token = await comoAdmin();

      const r = await http()
        .get(`${base}/importacao/perfis`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const multi = r.body.filter((p: { multiTribunal: boolean }) => p.multiTribunal);
      expect(multi).toHaveLength(1);
      expect(multi[0].tribunal).toBeNull();
      expect(multi[0].nome).toContain('multi-tribunal');

      const doTrf5 = r.body.find((p: { tribunal: string | null }) => p.tribunal === 'TRF5');
      expect(doTrf5).toBeDefined();
      expect(doTrf5.multiTribunal).toBe(false);
    });

    it('sem token → 401, como toda a importação', async () => {
      await http().get(`${base}/importacao/perfis`).expect(401);
    });
  });

  // ────────────────────────────────────────────────────────────
  describe('POST /importacao?perfilId=…', () => {
    it('⚠ a rota REPASSA o perfilId — era exatamente isto que não existia', async () => {
      /**
       * O caso que teria falhado antes da correção, e o único formato capaz de
       * pegá-la: sem o repasse, `resolverLeitura` cairia no perfil do lote
       * padrão (TRF5, dívida consolidada), não acharia as colunas obrigatórias
       * `tribunal` e `fase`, e a resposta seria 400 em vez da simulação.
       */
      const token = await comoAdmin();
      const perfil = await perfilMulti();

      const r = await enviar(token, `?perfilId=${perfil.id}&dryRun=true`).expect(200);

      expect(r.body.perfil.nome).toBe(perfil.nome);
      /* O perfil multi-tribunal NÃO tem sigla — é o que ele declara ao não ter.
         Quem diz 'da planilha' é o destino, e a distinção importa: o perfil fala
         de COMO ler, o destino de ONDE cai. */
      expect(r.body.perfil.tribunal).toBeNull();
      expect(r.body.destino).toEqual({ tribunal: 'da planilha', exercicio: null });
      expect(r.body.totalLinhas).toBe(2);
      expect(r.body.totalProblemas).toBe(0);
    });

    it('as duas linhas resolvem tribunais DIFERENTES, que é o ponto do modo', async () => {
      const token = await comoAdmin();
      const perfil = await perfilMulti();

      const r = await enviar(token, `?perfilId=${perfil.id}&dryRun=true`).expect(200);

      expect(r.body.processos.distintos).toBe(2);
      expect(r.body.pessoas.distintas).toBe(2);
    });

    it('a importação de verdade responde 202 e GUARDA o perfil usado', async () => {
      /* 202 e não 200: o trabalho vai para a fila. E `perfilId` gravado na
         importação é o que permite, meses depois, saber por qual mapa de colunas
         aquelas linhas entraram. */
      const token = await comoAdmin();
      const perfil = await perfilMulti();

      const r = await enviar(token, `?perfilId=${perfil.id}`).expect(202);

      /* `importacaoId`, e não `id`: a resposta é um RECIBO, não o recurso. */
      const imp = await prisma.importacao.findUniqueOrThrow({
        where: { id: r.body.importacaoId },
        select: { perfilId: true, tribunalId: true },
      });
      expect(imp.perfilId).toBe(perfil.id);
    });

    it('perfil inexistente é recusado ANTES de qualquer escrita', async () => {
      /* ⚠ ESTE CASO PASSA MESMO SEM A CORREÇÃO, e o registro evita que alguém o
         leia como cobertura maior do que é: sem o repasse do `perfilId`, a
         requisição cai no perfil padrão, não acha as colunas obrigatórias e
         devolve 400 também. Conferido reintroduzindo o defeito.

         O que ele guarda de verdade é a SEGUNDA asserção: recusa qualquer que
         seja o motivo, nada foi gravado. Quem prova o repasse são os casos ⚠. */
      const token = await comoAdmin();

      await enviar(token, '?perfilId=00000000-0000-4000-8000-000000000000&dryRun=true').expect(400);

      expect(await observador.importacao.count()).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────
  describe('perfil e tribunal são excludentes', () => {
    it('⚠ mandar os dois é 400 — e não o perfil vencendo em silêncio', async () => {
      /**
       * Sem esta recusa, `resolverLeitura` daria precedência ao `perfilId` e a
       * escolha de tribunal do operador seria descartada sem aviso: ele veria
       * "TJMG" na tela e a planilha entraria por outro caminho. A única pista
       * seria uma linha do resumo da simulação.
       */
      const token = await comoAdmin();
      const perfil = await perfilMulti();

      const r = await enviar(token, `?perfilId=${perfil.id}&tribunal=TRF5&exercicio=2027`).expect(400);

      expect(String(r.body.mensagem ?? r.body.message)).toMatch(/um jeito só|um jeito so/i);
    });

    it('só o tribunal, sem o exercício, continua sendo 400', async () => {
      /* Regra que já existia; o caso fica para a recusa nova não a ter apagado. */
      const token = await comoAdmin();
      await enviar(token, '?tribunal=TRF5&dryRun=true').expect(400);
    });
  });

  // ────────────────────────────────────────────────────────────
  describe('o caminho de sempre não mudou', () => {
    it('sem perfilId, o tribunal escolhido resolve o perfil dele', async () => {
      /**
       * A metade que importa tanto quanto a correção: quem importa dívida
       * consolidada não pode ter perdido nada. Aqui a planilha é a do formato
       * antigo, e o perfil resolvido tem de ser o do tribunal pedido.
       */
      const token = await comoAdmin();
      const csvTrf = [
        'CPF,Nome,Processo,Situação',
        '52998224725,MARIA DE SOUZA SANTOS,0001234-56.2020.4.05.8300,Aguardando pagamento',
      ].join('\n');

      const r = await enviar(token, '?tribunal=TRF5&exercicio=2027&dryRun=true', csvTrf).expect(200);

      expect(r.body.perfil.tribunal).toBe('TRF5');
      expect(r.body.perfil.nome).not.toContain('multi-tribunal');
    });
  });
});
