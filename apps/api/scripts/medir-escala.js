#!/usr/bin/env node
/**
 * Mede as consultas quentes do SaaS com VOLUME sintético.
 *
 * Existe porque "revisão de índices" não pode ser opinião. Este script carrega
 * centenas de milhares de processos no banco de TESTE, roda EXPLAIN ANALYZE nas
 * duas consultas que dominam o custo e imprime plano, tempo e buffers — para a
 * decisão de criar (ou não criar) índice sair de número, não de intuição.
 *
 * A primeira rodada dele derrubou uma hipótese: um índice em `processos(valor)`
 * parecia óbvio para o motor de distribuição, e a medição mostrou que o
 * planejador NEM O USA — o custo está no anti-join, não na ordenação.
 *
 * ⚠ APAGA o banco de destino. Repete a trava do ambiente.ts: só roda contra um
 * banco cujo nome termina em `_test`.
 *
 * Uso:  node scripts/medir-escala.js  [N_PROC=500000]  [N_LIB=50000]
 * Depois: npm run test:int:preparar   (para devolver o banco de teste ao normal)
 *
 * ⚠ LIMITE DA SIMULAÇÃO: os dados sintéticos põem todos os processos no mesmo
 * tribunal/exercício, o que deixa as estimativas do planejador otimistas demais
 * para o filtro de lote. Serve para comparar FORMAS de consulta entre si; não
 * serve para prever o plano exato que a produção vai escolher.
 */
const { resolve } = require('node:path');

require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

const producao = process.env.DATABASE_URL?.trim();
if (!producao) {
  console.error('DATABASE_URL não definida.');
  process.exit(1);
}
const url =
  process.env.DATABASE_URL_TEST?.trim() ?? producao.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');
const nome = /\/([^/?]+)(\?|$)/.exec(url)?.[1] ?? '';
if (!nome.endsWith('_test')) {
  console.error(`RECUSANDO: este script APAGA o banco, e "${nome}" não termina em "_test".`);
  process.exit(1);
}

const { PrismaClient } = require('@miner/database');
const prisma = new PrismaClient({ datasources: { db: { url } } });

const N_PROC = Number(process.argv[2] ?? process.env.N_PROC ?? 500000);
const N_LIB = Number(process.argv[3] ?? process.env.N_LIB ?? 50000);
const br = (n) => Number(n).toLocaleString('pt-BR');

async function carregar() {
  console.log(`├─ banco: ${nome}`);
  console.log(`├─ carregando ${br(N_PROC)} processos…`);
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "processos_liberados","lotes_assinatura","assinaturas","planos",
      "carteira_processo","eventos_processo","processo_pessoas","processos",
      "users","organizations" RESTART IDENTITY CASCADE`);

  const interna = await prisma.organization.create({
    data: { nome: 'Interna (escala)', tipo: 'INTERNA', cnpj: '99999999999999' },
    select: { id: true },
  });
  const cliente = await prisma.organization.create({
    data: { nome: 'Cliente (escala)', tipo: 'CLIENTE', cnpj: '88888888888888' },
    select: { id: true },
  });
  const tribunal = await prisma.tribunal.findFirstOrThrow({ select: { id: true, sigla: true } });

  /* generate_series em vez de 500 mil round-trips. `::bigint` porque g*7919
     estoura int4 já na casa das centenas de milhares. 3% de NULL em `valor`
     para exercitar o NULLS LAST da ordenação. */
  await prisma.$executeRawUnsafe(`
    INSERT INTO "processos" (id,"numeroPrecatorio","tribunalId","organizationId",exercicio,valor,"entidadeDevedora","criadoEm","editadoEm","prioridade")
    SELECT gen_random_uuid(), 'ESC-'||g, '${tribunal.id}'::uuid, '${interna.id}'::uuid, 2027,
           CASE WHEN g % 33 = 0 THEN NULL ELSE ((g::bigint * 7919) % 900000)::numeric(15,2) END,
           'INSS', now(), now(), 'NORMAL'
    FROM generate_series(1,${N_PROC}) g`);

  const plano = await prisma.plano.create({
    data: { nome: 'Escala', processosPorCiclo: 250, preco: 0 },
    select: { id: true },
  });
  const assinatura = await prisma.assinatura.create({
    data: { organizationId: cliente.id, planoId: plano.id, status: 'ATIVA' },
    select: { id: true },
  });
  const lote = await prisma.loteAssinatura.create({
    data: { assinaturaId: assinatura.id, competencia: new Date('2026-07-01'), quantidadeAlvo: 250 },
    select: { id: true },
  });
  await prisma.$executeRawUnsafe(`
    INSERT INTO "processos_liberados" (id,"organizationId","processoId","loteId","liberadoEm")
    SELECT gen_random_uuid(), '${cliente.id}'::uuid, p.id, '${lote.id}'::uuid, now()
    FROM (SELECT id FROM "processos" ORDER BY valor DESC NULLS LAST LIMIT ${N_LIB}) p`);
  console.log(`├─ ${br(N_LIB)} liberados para o cliente`);

  await prisma.$executeRawUnsafe('ANALYZE "processos"');
  await prisma.$executeRawUnsafe('ANALYZE "processos_liberados"');
  return { cliente: cliente.id, sigla: tribunal.sigla };
}

/** EXPLAIN ANALYZE, 3 execuções, fica a melhor (a primeira paga o cache frio). */
async function medir(rotulo, sql) {
  let melhor = Infinity;
  let texto = [];
  for (let i = 0; i < 3; i++) {
    const linhas = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
    const t = linhas.map((l) => l['QUERY PLAN']);
    const ms = Number(/Execution Time: ([\d.]+)/.exec(t.join('\n'))?.[1] ?? NaN);
    if (ms < melhor) {
      melhor = ms;
      texto = t;
    }
  }
  const buffers = /shared hit=(\d+)/.exec(texto.join('\n'))?.[1] ?? '0';
  console.log(`│`);
  console.log(`├─ ${rotulo}`);
  console.log(`│    ${melhor.toFixed(1)} ms · ${br(buffers)} buffers`);
  texto
    .filter((l) => /Seq Scan|Index Scan|Index Only Scan|Bitmap Heap|Anti Join|Hash Join|Sort /.test(l))
    .slice(0, 5)
    .forEach((l) => console.log(`│      ${l.trim().slice(0, 108)}`));
  return melhor;
}

(async () => {
  console.log('┌─ Medição de escala');
  const { cliente, sigla } = await carregar();

  await medir(
    'Distribuição mensal: 250 de maior valor ainda não liberados',
    `SELECT p.id FROM "processos" p
     JOIN "organizations" o ON o.id = p."organizationId"
     WHERE o.tipo = 'INTERNA'
       AND NOT EXISTS (SELECT 1 FROM "processos_liberados" pl
                       WHERE pl."processoId" = p.id AND pl."organizationId" = '${cliente}'::uuid)
     ORDER BY p.valor DESC NULLS LAST, p.id ASC LIMIT 250`,
  );

  await medir(
    'Painel do cliente: contagem da carteira liberada',
    `SELECT count(*) FROM "processos" p
     JOIN "tribunais" t ON t.id = p."tribunalId"
     WHERE t.sigla = '${sigla}' AND p.exercicio = 2027
       AND EXISTS (SELECT 1 FROM "processos_liberados" pl
                   WHERE pl."processoId" = p.id AND pl."organizationId" = '${cliente}'::uuid)`,
  );

  const idx = await prisma.$queryRawUnsafe(`
    SELECT indexrelname AS idx, pg_size_pretty(pg_relation_size(indexrelid)) AS tam, idx_scan
    FROM pg_stat_user_indexes WHERE relname IN ('processos','processos_liberados')
    ORDER BY pg_relation_size(indexrelid) DESC LIMIT 8`);
  console.log('│\n├─ maiores índices (idx_scan = quantas vezes foram usados nesta medição)');
  idx.forEach((i) => console.log(`│    ${i.idx.padEnd(46)} ${String(i.tam).padStart(8)}  scans=${i.idx_scan}`));

  console.log('│\n└─ pronto. Rode `npm run test:int:preparar` para devolver o banco de teste ao normal.');
})()
  .catch((e) => {
    console.error('erro:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
