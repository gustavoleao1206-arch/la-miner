#!/usr/bin/env node
/**
 * Quanto tempo a importação leva, de verdade?
 *
 * O item B5 ("mover a importação para a fila") partia de uma premissa que nunca
 * tinha sido medida: a de que a carga estoura o timeout do proxy dentro da
 * requisição HTTP. Arquitetura decidida por suposição costuma resolver o
 * problema errado — este script trocou a suposição por 8,5 ms por linha, e foi
 * esse número que justificou a mudança.
 *
 * DEPOIS do B5 ele continua servindo, e melhor: agora mede as duas metades
 * separadamente. O que interessa é
 *
 *   (a) a REQUISIÇÃO ficar rápida e estável, independente do tamanho — é ela
 *       que o operador espera com a tela travada; e
 *   (b) o processamento não ter ficado mais CARO por linha na mudança. Se o
 *       custo por linha subiu, a divisão custou throughput, e isso precisa
 *       aparecer aqui em vez de virar lentidão silenciosa em produção.
 *
 * Roda contra o banco de TESTE, com planilha sintética, e limpa o que criou.
 *
 *   node apps/api/scripts/medir-importacao.js [linhas]
 */
const path = require('node:path');
const { resolve } = require('node:path');

const RAIZ = resolve(__dirname, '../../..');
require('dotenv').config({ path: resolve(RAIZ, '.env') });

const LINHAS = Number(process.argv[2] ?? 2000);

/* Banco de TESTE, sempre. Medir contra produção sujaria a carteira real. */
const urlTeste = (process.env.DATABASE_URL ?? '').replace(/\/([^/?]+)(\?|$)/, '/miner_test$2');
if (!urlTeste.includes('_test')) {
  console.error('ABORTANDO: não consegui apontar para um banco _test.');
  process.exit(1);
}

const { PrismaClient } = require(path.join(RAIZ, 'packages/database/generated/client'));
const prisma = new PrismaClient({ datasources: { db: { url: urlTeste } } });

const { ImportacaoService } = require(path.join(RAIZ, 'apps/api/dist/modules/importacao/importacao.service.js'));
const { montarXlsx } = require(path.join(RAIZ, 'apps/api/dist/modules/importacao/zip-de-teste.js'));

/** CPF sintético com dígito verificador válido — o importador valida. */
function cpfValido(seq) {
  const base = String(seq).padStart(9, '0').slice(-9).split('').map(Number);
  const dv = (nums, peso) => {
    const s = nums.reduce((a, n, i) => a + n * (peso - i), 0);
    const r = ((s * 10) % 11) % 10;
    return r;
  };
  const d1 = dv(base, 10);
  const d2 = dv([...base, d1], 11);
  return [...base, d1, d2].join('');
}

(async () => {
  console.log(`Medindo a importação de ${LINHAS.toLocaleString('pt-BR')} linhas.\n`);

  const tribunal = await prisma.tribunal.findUnique({ where: { sigla: 'TRF5' }, select: { id: true } });
  if (!tribunal) {
    console.error('Banco de teste sem catálogo de tribunais. Rode as migrations.');
    process.exit(1);
  }

  /* O banco de teste é limpo entre execuções da suíte: só o catálogo
     (tribunais, perfis) sobrevive. Org e usuário são criados aqui e removidos
     no fim — assim o script não depende de estado deixado por outra coisa. */
  const org = await prisma.organization.create({
    data: { nome: `Medição ${Date.now()}`, tipo: 'INTERNA', cnpj: `${Date.now()}`.slice(-14) },
    select: { id: true },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `medicao${Date.now()}@teste.local`,
      nome: 'Medição',
      papel: 'ADMIN',
      senhaHash: 'nao-e-um-hash-valido',
    },
    select: { id: true },
  });

  /* Planilha com os cabeçalhos que o perfil do TRF5 espera. */
  const linhas = [['CPF', 'Nome', 'Processo', 'Valor', 'Entidade']];
  for (let i = 0; i < LINHAS; i++) {
    linhas.push([
      cpfValido(100000 + i),
      `TITULAR SINTETICO ${i}`,
      `9${String(i).padStart(6, '0')}-11.2020.4.05.8300`,
      1000 + i,
      'INSS',
    ]);
  }
  const buffer = montarXlsx([{ nome: 'Planilha1', linhas }]);
  console.log(`  planilha gerada: ${(buffer.length / 1024).toFixed(0)} KB\n`);

  const filaFalsa = {
    enfileirarLote: async () => ({ enfileirados: 0 }),
    /* Não enfileira de verdade: o script chama `processarImportacao` logo
       abaixo, que é exatamente o que o processor chamaria. */
    enfileirarImportacao: async (id) => ({ id }),
  };
  const servico = new ImportacaoService(prisma, filaFalsa);
  const arquivo = { originalname: `medicao-${Date.now()}.xlsx`, buffer };

  /* ── Metade 1: a requisição ── */
  const t0 = Date.now();
  const recibo = await servico.importar({
    arquivo,
    organizationId: org.id,
    userId: user.id,
    lote: { tribunal: 'TRF5', exercicio: 2027 },
  });
  const naRequisicao = Date.now() - t0;

  /* ── Metade 2: o worker ── */
  const t1 = Date.now();
  await servico.processarImportacao(recibo.importacaoId);
  const noWorker = Date.now() - t1;

  const r = await prisma.importacao.findUniqueOrThrow({ where: { id: recibo.importacaoId } });

  console.log('RESULTADO');
  console.log(`  na REQUISIÇÃO ......: ${(naRequisicao / 1000).toFixed(1)}s  (${(naRequisicao / LINHAS).toFixed(2)}ms/linha)`);
  console.log(`  no WORKER ..........: ${(noWorker / 1000).toFixed(1)}s  (${(noWorker / LINHAS).toFixed(1)}ms/linha)`);
  console.log(`  linhas gravadas ....: ${r.sucesso} sucesso · ${r.falhas} falhas · ${r.ignoradas} ignoradas`);
  console.log(`  processos criados ..: ${r.processosCriados}`);
  console.log('');
  console.log('EXTRAPOLAÇÃO (linear)');
  console.log('                    requisição      worker');
  for (const n of [8479, 20000, 100000]) {
    const req = ((naRequisicao / LINHAS) * n) / 1000;
    const wrk = ((noWorker / LINHAS) * n) / 1000;
    /* O aviso mudou de lado: o que importa agora é o tempo da REQUISIÇÃO, que é
       o único que um proxy corta. O do worker pode ser longo à vontade. */
    const marca = req > 30 ? '  <- requisição passa de 30s' : '';
    console.log(
      `  ${n.toLocaleString('pt-BR').padStart(7)} linhas: ${`${req.toFixed(1)}s`.padStart(10)}  ${`${wrk.toFixed(0)}s`.padStart(8)}${marca}`,
    );
  }

  /* Limpa TUDO o que esta medição criou. Ordem importa: as linhas e os
     processos referenciam o que vem depois. */
  await prisma.importacao.deleteMany({ where: { organizationId: org.id } });
  await prisma.processoPessoa.deleteMany({ where: { processo: { organizationId: org.id } } });
  await prisma.eventoProcesso.deleteMany({ where: { processo: { organizationId: org.id } } });
  await prisma.processo.deleteMany({ where: { organizationId: org.id } });
  await prisma.pessoa.deleteMany({ where: { nomeNormalizado: { startsWith: 'TITULAR SINTETICO' } } });
  await prisma.user.deleteMany({ where: { organizationId: org.id } });
  await prisma.organization.delete({ where: { id: org.id } });
  console.log('\n(dados da medição removidos do banco de teste)');
})()
  .catch((e) => { console.error('FALHOU:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
