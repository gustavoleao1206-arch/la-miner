import { config as carregarEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaClient, type FaseProcesso } from '@miner/database';

import { modoDoAmbiente, registrarSentinela } from '../../src/prisma/sentinela-escopo';

/**
 * Ambiente dos testes de integração.
 *
 * ⚠ A TRAVA ABAIXO É O CORAÇÃO DESTE ARQUIVO.
 *
 * Estes testes apagam tabelas inteiras entre um caso e outro. Apontados para o
 * banco de produção, eles destruiriam a carteira de 4.188 processos e os dados
 * pessoais de 3.974 pessoas reais — e um `TRUNCATE` não tem desfazer.
 *
 * Por isso o nome do banco é verificado ANTES de qualquer conexão: só roda
 * contra um banco cujo nome termina em `_test`. Um `.env` mal configurado, uma
 * variável exportada por engano no terminal, um merge que troque a URL — em
 * todos esses casos a suíte se recusa a subir, em vez de rodar no lugar errado.
 */

/* O jest não carrega .env sozinho. Sem isto, DATABASE_URL viria vazia e a trava
   dispararia por motivo errado ("banco não é de teste" em vez de "faltou env"). */
process.env.NODE_ENV = 'test'; // silencia o pino nos testes
carregarEnv({ path: resolve(__dirname, '../../../../.env') });

function urlDeTeste(): string {
  const explicita = process.env.DATABASE_URL_TEST?.trim();
  if (explicita) return explicita;

  /* Deriva da URL de produção trocando só o nome do banco. Evita ter de manter
     duas URLs em sincronia — usuário, senha, host e porta são os mesmos. */
  const producao = process.env.DATABASE_URL?.trim();
  if (!producao) {
    throw new Error(
      'DATABASE_URL não definida. Os testes de integração precisam dela para derivar o banco de teste.',
    );
  }
  return producao.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
}

/* Exportada para que NENHUM teste monte um cliente próprio a partir de
   `process.env.DATABASE_URL`: aquele é o banco de desenvolvimento, com dado
   real dentro. Quem precisar de um cliente à parte usa esta constante, que já
   passou pela trava do `_test` logo abaixo. */
export const URL_DE_TESTE = urlDeTeste();
const URL = URL_DE_TESTE;

/** Nome do banco extraído da URL — é sobre ele que a trava decide. */
const nomeDoBanco = /\/([^/?]+)(\?|$)/.exec(URL)?.[1] ?? '';

if (!nomeDoBanco.endsWith('_test')) {
  throw new Error(
    `RECUSANDO RODAR: os testes de integração apagam tabelas, e o banco "${nomeDoBanco}" ` +
      'não termina em "_test".\n' +
      'Aponte DATABASE_URL_TEST para um banco descartável antes de rodar a suíte.',
  );
}

export const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

/* O SENTINELA DE ESCOPO vale aqui também — e é aqui que ele mais vale.
   A suíte de integração monta um cliente próprio, então um sentinela preso ao
   `PrismaService` nunca reprovaria ninguém antes do deploy: passaria a vida
   avisando em produção, que é tarde. Em `NODE_ENV=test` o modo padrão é
   BLOQUEAR, então uma consulta em massa nova sobre tabela com dono, sem
   `organizationId` no filtro, reprova no primeiro `npm run test:int`.

   `prisma` é o cliente que os SERVIÇOS recebem — é o código da aplicação que o
   sentinela vigia. Fixtures passam por ele sem atrito: criar, atualizar por id e
   o TRUNCATE cru não são varredura. */
registrarSentinela(prisma as never, modoDoAmbiente(), (m) => console.warn(m));

/**
 * O OBSERVADOR — o cliente das asserções, SEM sentinela.
 *
 * Um teste enxerga o banco inteiro por definição: "a importação recusada não
 * criou processo NENHUM" é um `count()` sem filtro, e é exatamente a pergunta
 * certa. Ele não é código da aplicação, e não tem inquilino.
 *
 * Por que um cliente à parte, e não `escopoGlobal` em cada asserção: a marca
 * existe para dizer ao próximo leitor que a ausência de escopo foi DECIDIDA num
 * código que atende clientes. Espalhada por cinquenta asserções, ela viraria
 * ruído — e a marca que é ruído deixa de ser lida.
 *
 * O desenho falha ALTO: uma asserção global escrita com `prisma` em vez de
 * `observador` reprova na hora, e quem escreveu troca. O inverso — serviços num
 * cliente guardado à parte — falharia em SILÊNCIO sempre que alguém montasse um
 * serviço com o cliente errado, e a rede abriria sem ninguém ver.
 *
 * ⚠ Nunca passe o `observador` a um serviço. Aí sim o sentinela ficaria cego.
 */
export const observador = new PrismaClient({ datasources: { db: { url: URL } } });

/**
 * Zera os dados entre testes, preservando o CATÁLOGO.
 *
 * `tribunais` e `perfis_importacao` ficam de fora porque vêm das migrations,
 * não de fixture: apagá-los quebraria a importação de todos os testes seguintes
 * e o erro apareceria longe da causa.
 *
 * ⚠ `solicitacoes_titular` precisa estar na lista À MÃO: ela não tem chave
 * estrangeira nenhuma, então o CASCADE não a alcança. Fora daqui, as linhas se
 * acumulariam entre execuções até o protocolo (que é @unique) colidir, e a
 * suíte falharia de forma intermitente — o pior tipo de falha, e o motivo de
 * este arquivo já rodar com um worker só.
 *
 * A ordem não importa — `CASCADE` cuida das chaves estrangeiras —, mas o
 * `RESTART IDENTITY` importa: sem ele, ids de sequência continuariam crescendo
 * entre testes e um caso que dependesse do primeiro id falharia só na segunda
 * execução da suíte.
 */
export async function limparDados() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "eventos_cobranca", "faturas",
      "processos_liberados", "lotes_assinatura", "assinaturas", "planos",
      "carteira_processo", "snapshots_carteira",
      "eventos_processo", "anotacoes_processo", "tarefas_processo",
      "processo_etiquetas", "etiquetas", "processo_pessoas", "processos",
      "telefones", "emails", "enderecos", "enriquecimentos", "pessoas",
      "consultas_cliente", "importacao_linhas", "importacoes",
      "solicitacoes_titular",
      "refresh_tokens", "mfa_codigos_recuperacao", "audit_logs", "users", "organizations"
    RESTART IDENTITY CASCADE;
  `);
}

/** Organização + usuário mínimos para exercitar qualquer rota autenticada. */
export async function semearOrganizacao(nome = 'Escritório de Teste') {
  const org = await prisma.organization.create({
    /* INTERNA: o fixture representa a operação Leão Amorim (usuário ADMIN, dono da
       base). Testes de cliente criam a própria org CLIENTE explicitamente. */
    data: { nome, tipo: 'INTERNA', cnpj: `${Date.now()}`.slice(-14) },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `admin+${org.id.slice(0, 8)}@teste.local`,
      nome: 'Admin de Teste',
      papel: 'ADMIN',
      /* Hash fixo e inválido: nenhum teste faz login, e gerar argon2 de verdade
         custaria ~100ms por caso sem provar nada. */
      senhaHash: 'nao-e-um-hash-valido',
    },
    select: { id: true, organizationId: true },
  });
  return {
    org,
    user,
    autor: {
      id: user.id,
      papel: 'ADMIN' as const,
      organizationId: org.id,
      tipo: 'INTERNA' as const,
    },
  };
}

/**
 * Organização CLIENTE (assinante) + usuário de papel CLIENTE.
 *
 * Devolve também o `escopo` pronto, que é o que os serviços de leitura pedem —
 * assim o teste declara "quem está olhando" em vez de montar o objeto à mão em
 * todo caso.
 */
export async function semearCliente(nome = 'Cliente de Teste') {
  const org = await prisma.organization.create({
    /* CNPJ com sufixo aleatório: `semearCliente` e `semearOrganizacao` podem cair
       no mesmo milissegundo, e o CNPJ é @unique. */
    data: {
      nome,
      tipo: 'CLIENTE',
      cnpj: `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-14),
    },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `cliente+${org.id.slice(0, 8)}@teste.local`,
      nome: 'Usuário Cliente',
      papel: 'CLIENTE',
      /* Como em produção: o primeiro usuário do cliente é o gestor da empresa. */
      gestor: true,
      senhaHash: 'nao-e-um-hash-valido',
    },
    select: { id: true, organizationId: true },
  });
  return {
    org,
    user,
    escopo: { tipo: 'CLIENTE' as const, organizationId: org.id, papel: 'CLIENTE' as const },
    /* O mesmo usuário na forma que a ESCRITA do CRM pede. */
    autor: {
      id: user.id,
      papel: 'CLIENTE' as const,
      organizationId: org.id,
      tipo: 'CLIENTE' as const,
    },
  };
}

/**
 * Libera um processo para uma org CLIENTE, montando a cadeia mínima
 * (plano → assinatura → lote → liberação).
 *
 * Feito à mão de propósito: o MOTOR de distribuição é a Fase C. O que se exercita
 * aqui é o ESCOPO DE LEITURA, e ele só depende da linha em `processos_liberados`.
 * Os upserts deixam a função repetível dentro do mesmo teste.
 */
export async function liberarProcesso(
  organizationId: string,
  processoId: string,
  /* A COMPETÊNCIA do ciclo, e não a data de liberação: é por ela que a safra
     agrupa, e regerar um mês passado faz as duas divergirem de propósito. */
  competenciaISO = '2026-07-01T00:00:00.000Z',
) {
  const plano = await prisma.plano.upsert({
    where: { nome: 'Plano de Teste' },
    update: {},
    create: { nome: 'Plano de Teste', processosPorCiclo: 250, preco: 0 },
    select: { id: true },
  });
  const assinatura = await prisma.assinatura.upsert({
    where: { organizationId },
    update: {},
    create: { organizationId, planoId: plano.id, status: 'ATIVA' },
    select: { id: true },
  });
  const competencia = new Date(competenciaISO);
  const lote = await prisma.loteAssinatura.upsert({
    where: { assinaturaId_competencia: { assinaturaId: assinatura.id, competencia } },
    update: {},
    create: { assinaturaId: assinatura.id, competencia, quantidadeAlvo: 250 },
    select: { id: true },
  });
  return prisma.processoLiberado.create({
    data: { organizationId, processoId, loteId: lote.id },
    select: { id: true },
  });
}

/** Um processo pronto, no tribunal e exercício pedidos. */
export async function semearProcesso(params: {
  organizationId: string;
  sigla?: string;
  /**
   * `null` explícito é aceito — e é o que DEFINE o pré-precatório.
   *
   * Lote é (tribunal + exercício), então exercício nulo não casa com lote
   * nenhum: é exatamente por isso que o time interno não os enxerga e o cliente,
   * que não tem recorte de lote, enxerga. Sem poder semear o nulo, nenhum caso
   * consegue exercitar essa diferença.
   */
  exercicio?: number | null;
  numeroPrecatorio?: string;
  /** `null` explícito é aceito — é o caso do precatório sem valor lançado. */
  valor?: number | null;
  /**
   * O estágio. Padrão `PRECATORIO_EXPEDIDO` porque é o que a base inteira é, e
   * porque assim os casos escritos antes desta coluna continuam valendo o que
   * valiam — eles falam de precatório expedido sem nunca ter precisado dizer.
   *
   * Passar outra fase é como se testa a trava de distribuição.
   */
  fase?: FaseProcesso;
}) {
  const tribunal = await prisma.tribunal.findUniqueOrThrow({
    where: { sigla: params.sigla ?? 'TRF5' },
    select: { id: true },
  });
  return prisma.processo.create({
    data: {
      numeroPrecatorio: params.numeroPrecatorio ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      tribunalId: tribunal.id,
      organizationId: params.organizationId,
      fase: params.fase ?? 'PRECATORIO_EXPEDIDO',
      /* `=== undefined` e não `??`, pela MESMA razão já escrita abaixo para
         `valor`: `exercicio: null` é um caso legítimo (pré-precatório) e o `??`
         o trocaria pelo default, apagando o que o caso queria testar. */
      exercicio: params.exercicio === undefined ? 2027 : params.exercicio,
      entidadeDevedora: 'INSS',
      /* `=== undefined` e não `??`: `valor: null` é um caso de teste legítimo
         (precatório sem valor lançado) e `??` o trocaria pelo default. */
      valor: params.valor === undefined ? 1000 : params.valor,
    },
    select: { id: true, numeroPrecatorio: true },
  });
}

export async function encerrar() {
  await Promise.all([prisma.$disconnect(), observador.$disconnect()]);
}
