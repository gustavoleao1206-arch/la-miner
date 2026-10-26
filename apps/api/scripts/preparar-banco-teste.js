#!/usr/bin/env node
/**
 * Cria (ou recria) o banco de testes de integração e aplica as migrations.
 *
 * Existe para que a suíte não dependa de alguém lembrar de uma sequência de
 * comandos: `npm run test:int:preparar` numa máquina nova e pronto.
 *
 * ⚠ Ele DERRUBA o banco de destino. Por isso repete a mesma trava do
 * `ambiente.ts`: só aceita nome terminado em `_test`. Um DROP disparado contra
 * a base de produção apagaria a carteira inteira, e não há desfazer.
 */
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');

require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

const producao = process.env.DATABASE_URL?.trim();
if (!producao) {
  console.error('DATABASE_URL não definida — não dá para derivar a URL de teste.');
  process.exit(1);
}

const urlTeste =
  process.env.DATABASE_URL_TEST?.trim() ?? producao.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2');

const nome = /\/([^/?]+)(\?|$)/.exec(urlTeste)?.[1] ?? '';
if (!nome.endsWith('_test')) {
  console.error(
    `RECUSANDO: este script APAGA o banco de destino, e "${nome}" não termina em "_test".`,
  );
  process.exit(1);
}

/* Conecta no `postgres` para poder derrubar e recriar o banco alvo — não dá
   para dropar o banco ao qual se está conectado. */
const urlAdmin = urlTeste.replace(/\/([^/?]+)(\?|$)/, '/postgres$2');

const psql = (url, sql) =>
  execFileSync('npx', ['prisma', 'db', 'execute', '--url', url, '--stdin'], {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });

console.log(`├─ recriando o banco "${nome}"`);
psql(urlAdmin, `DROP DATABASE IF EXISTS "${nome}";`);
psql(urlAdmin, `CREATE DATABASE "${nome}";`);

console.log('├─ aplicando migrations');
execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: resolve(__dirname, '../../../packages/database'),
  env: { ...process.env, DATABASE_URL: urlTeste },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

console.log('└─ pronto. Rode: npm run test:int');
