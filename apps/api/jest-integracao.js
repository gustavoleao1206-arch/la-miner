/**
 * Configuração dos testes de INTEGRAÇÃO (tocam banco de verdade).
 *
 * Separada da suíte de unidade de propósito: `npm test` continua rápido e sem
 * dependência de infraestrutura, e quem não tem Postostgres na máquina ainda
 * consegue rodar a maior parte da cobertura.
 */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  /* `.int-spec.ts` não casa com o `.spec.ts` da suíte de unidade — o ponto
     antes de "spec" é literal no regex de lá. As duas convivem sem se ver. */
  testRegex: '.*\.int-spec\.ts$',
  transform: { '^.+\.ts$': 'ts-jest' },
  testEnvironment: 'node',

  /* Um worker só. Todos os casos compartilham o MESMO banco e cada um limpa as
     tabelas antes de rodar; em paralelo, o TRUNCATE de um apagaria as fixtures
     de outro no meio da execução — falha intermitente, o pior tipo de falha. */
  maxWorkers: 1,

  /* TRUNCATE em 25 tabelas é mais lento que um teste de unidade; os 5s padrão
     do jest estouram já no primeiro caso. */
  testTimeout: 30000,
};
