#!/usr/bin/env node
/**
 * `prisma migrate reset --force` com trava de ambiente.
 *
 * O comando cru lê `DATABASE_URL` do ambiente e APAGA o banco inteiro, sem
 * confirmação, sem checar onde está apontando. O `.env` desta máquina aponta
 * para o banco com 4.188 processos e os dados pessoais de 3.974 pessoas reais —
 * um gatilho de 16 caracteres com consequência irreversível e sem restauração
 * jamais exercitada.
 *
 * Aqui ele só roda quando as três condições valem:
 *   1. NODE_ENV != production
 *   2. o host é local (localhost/127.0.0.1/::1) OU o nome do banco termina em _test
 *   3. quem chamou passou --sim (confirmação explícita)
 *
 * Sem isso o comando falha alto, que é o comportamento certo para uma operação
 * destrutiva: erro é barato, restaurar um dump de duas semanas atrás não é.
 */
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL não definida.');
  process.exit(1);
}

const recusar = (motivo) => {
  console.error(`\n  RECUSANDO apagar o banco.\n  ${motivo}\n`);
  process.exit(1);
};

if (process.env.NODE_ENV === 'production') {
  recusar('NODE_ENV=production. Este comando não existe em produção.');
}

/* Host e nome do banco, sem imprimir usuário nem senha. */
let host;
let banco;
try {
  const u = new URL(url);
  host = u.hostname;
  banco = u.pathname.replace(/^\//, '');
} catch {
  recusar('DATABASE_URL não é uma URL válida.');
}

const local = ['localhost', '127.0.0.1', '::1', 'postgres'].includes(host);
if (!local && !banco.endsWith('_test')) {
  recusar(
    `O destino é "${banco}" em "${host}" — nem local, nem um banco de teste.\n` +
      '  Se é mesmo o que você quer, faça pelo psql, com backup na mão.',
  );
}

if (!process.argv.includes('--sim')) {
  console.error(
    `\n  Isto vai APAGAR o banco "${banco}" em "${host}", incluindo todos os dados.\n` +
      '  Se tem certeza, repita com --sim:\n\n' +
      '      npm run reset -w @miner/database -- --sim\n',
  );
  process.exit(1);
}

console.log(`├─ apagando e recriando "${banco}" em "${host}"…`);
execFileSync('npx', ['prisma', 'migrate', 'reset', '--force'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
