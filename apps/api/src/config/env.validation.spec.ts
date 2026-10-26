import { validarEnv } from './env.validation';

/**
 * A trava que separa dinheiro de brincadeira.
 *
 * Subir em PRODUÇÃO com a chave de sandbox é o pior silêncio que este sistema
 * pode produzir: faturas emitidas, links gerados, tela do cliente dizendo
 * "aguardando pagamento" — e ninguém cobrado de verdade. A descoberta viria
 * pelo extrato bancário, semanas depois, com clientes usando a carteira de
 * graça.
 *
 * O aceite `ASAAS_ACEITAR_SANDBOX` abriu uma exceção deliberada (homologar o
 * ciclo completo em produção, que é o único ambiente onde o Asaas ENTREGA o
 * webhook). Este arquivo existe para garantir que a exceção não virou buraco:
 * ela precisa continuar impossível de acontecer SEM ALGUÉM TER ESCRITO.
 */

/**
 * O mínimo que passa em TODOS os refines de produção do schema.
 *
 * As três últimas linhas não são enfeite: `NODE_ENV=production` liga outras
 * travas independentes desta (provider de enriquecimento falso é proibido,
 * TRUST_PROXY_HOPS precisa ser ≥ 1 para o rate limit ver o usuário e não o
 * proxy). Sem elas, os casos que deveriam PASSAR falhavam por motivo alheio —
 * e um teste que falha pelo motivo errado é pior que teste nenhum, porque
 * ensina a ignorar vermelho.
 */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/miner?schema=public',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  JWT_REFRESH_SECRET: 'y'.repeat(32),
  ENRICHMENT_PROVIDER: 'contactra',
  CONTACTRA_BASE_URL: 'https://exemplo.invalido',
  CONTACTRA_CLIENT_ID: 'id-de-teste',
  CONTACTRA_CLIENT_SECRET: 'segredo-de-teste',
  CONTACTRA_TOKEN_URL: 'https://exemplo.invalido/oauth2/token',
  TRUST_PROXY_HOPS: '1',
};

const SANDBOX = '$aact_hmlg_chave-de-homologacao';
const PRODUCAO = '$aact_prod_chave-de-producao';
const TOKEN = 'z'.repeat(32);

const comAsaas = (extra: Record<string, unknown>) => ({
  ...BASE,
  BILLING_PROVIDER: 'asaas',
  ASAAS_WEBHOOK_TOKEN: TOKEN,
  ...extra,
});

describe('validarEnv — a trava de sandbox em produção', () => {
  it('RECUSA produção com chave de sandbox e sem aceite', () => {
    /* O caso original, e o que a trava existe para impedir. */
    expect(() =>
      validarEnv(comAsaas({ NODE_ENV: 'production', ASAAS_API_KEY: SANDBOX })),
    ).toThrow(/chave de produção/);
  });

  it('a recusa ENSINA a saída, em vez de só barrar', () => {
    /* Uma trava que diz "não" sem dizer "então faça assim" vira ticket de
       suporte — ou, pior, alguém a remove para destravar o deploy. */
    expect(() =>
      validarEnv(comAsaas({ NODE_ENV: 'production', ASAAS_API_KEY: SANDBOX })),
    ).toThrow(/ASAAS_ACEITAR_SANDBOX=true/);
  });

  it('ACEITA quando o aceite é declarado — é a homologação em produção', () => {
    const env = validarEnv(
      comAsaas({
        NODE_ENV: 'production',
        ASAAS_API_KEY: SANDBOX,
        ASAAS_ACEITAR_SANDBOX: 'true',
      }),
    );
    expect(env.ASAAS_ACEITAR_SANDBOX).toBe('true');
  });

  it('produção com chave de produção passa SEM precisar de aceite nenhum', () => {
    const env = validarEnv(comAsaas({ NODE_ENV: 'production', ASAAS_API_KEY: PRODUCAO }));
    expect(env.ASAAS_ACEITAR_SANDBOX).toBe('false');
  });

  it('o aceite é INÓCUO quando a chave já é de produção', () => {
    /* Deixar a variável para trás depois de trocar a chave não pode mudar
       comportamento nenhum — senão "esqueci de apagar" viraria um bug. */
    expect(() =>
      validarEnv(
        comAsaas({
          NODE_ENV: 'production',
          ASAAS_API_KEY: PRODUCAO,
          ASAAS_ACEITAR_SANDBOX: 'true',
        }),
      ),
    ).not.toThrow();
  });

  it('fora de produção, sandbox passa sem aceite — é o padrão do desenvolvimento', () => {
    expect(() =>
      validarEnv(comAsaas({ NODE_ENV: 'development', ASAAS_API_KEY: SANDBOX })),
    ).not.toThrow();
  });

  it('o aceite NÃO dispensa as credenciais — só trata do ambiente da chave', () => {
    /* A tentação seria um "modo de teste" que relaxa tudo. Aqui ele relaxa UMA
       regra: sem o token de webhook, o boot continua recusado, porque um
       webhook aberto é um "marque como pago" público. */
    expect(() =>
      validarEnv({
        ...BASE,
        BILLING_PROVIDER: 'asaas',
        NODE_ENV: 'production',
        ASAAS_API_KEY: SANDBOX,
        ASAAS_ACEITAR_SANDBOX: 'true',
      }),
    ).toThrow(/ASAAS_WEBHOOK_TOKEN/);
  });

  it('o aceite não afeta quem não usa o Asaas', () => {
    expect(() =>
      validarEnv({ ...BASE, NODE_ENV: 'production', ASAAS_ACEITAR_SANDBOX: 'true' }),
    ).not.toThrow();
  });

  it('sem a variável, o padrão é a proteção LIGADA', () => {
    /* O default é o que vale para todo deploy existente: ninguém precisa
       declarar nada para continuar protegido. */
    const env = validarEnv({ ...BASE, NODE_ENV: 'production' });
    expect(env.ASAAS_ACEITAR_SANDBOX).toBe('false');
  });
});
