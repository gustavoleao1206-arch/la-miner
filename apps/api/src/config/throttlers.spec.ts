import { CobrancaController } from '../modules/cobranca/cobranca.controller';
import { CadastroController } from '../modules/cadastro/cadastro.controller';
import { TitularController } from '../modules/titular/titular.controller';
import { MinhaContaController } from '../modules/minha-conta/minha-conta.controller';
import { AuthController } from '../modules/auth/presentation/auth.controller';
import { NOMES_DE_THROTTLER, THROTTLERS } from './throttlers';

/**
 * Cruza o que os controllers PEDEM com os baldes que existem.
 *
 * A auditoria achou um `@Throttle({ default: ... })` num app cujos baldes se
 * chamam `curto` e `medio`. O nome inexistente não dá erro: o decorator grava o
 * metadado, o guard procura por um balde com esse nome, não acha, e a rota fica
 * com o limite GLOBAL. O comentário prometia 5/min e a realidade eram 120.
 *
 * Nenhum teste podia pegar isso porque os nomes registrados viviam dentro do
 * `app.module.ts`. Com `THROTTLERS` exportado, dá para conferir os dois lados.
 *
 * ── COMO SE LÊ O QUE O DECORATOR GRAVOU ──
 *
 * `@Throttle` faz `Reflect.defineMetadata('THROTTLER:LIMIT' + nome, ...)` na
 * FUNÇÃO do método (não na classe). O nome fica GRUDADO na chave, então
 * `getMetadataKeys` é o que permite descobrir quais baldes uma rota citou —
 * inclusive um que não existe.
 */

const PREFIXO_LIMITE = 'THROTTLER:LIMIT';
const PREFIXO_TTL = 'THROTTLER:TTL';

/** Os baldes citados por um método, lidos do metadado, com limite e janela. */
function baldesDe(metodo: unknown): Record<string, { limit: unknown; ttl: unknown }> {
  const alvo = metodo as object;
  const nomes = Reflect.getMetadataKeys(alvo)
    .filter((chave): chave is string => typeof chave === 'string')
    .filter((chave) => chave.startsWith(PREFIXO_LIMITE))
    .map((chave) => chave.slice(PREFIXO_LIMITE.length));

  return Object.fromEntries(
    nomes.map((nome) => [
      nome,
      {
        limit: Reflect.getMetadata(PREFIXO_LIMITE + nome, alvo),
        ttl: Reflect.getMetadata(PREFIXO_TTL + nome, alvo),
      },
    ]),
  );
}

describe('registro de throttlers', () => {
  it('os nomes são únicos — dois baldes com o mesmo nome se anulariam', () => {
    expect(new Set(NOMES_DE_THROTTLER).size).toBe(THROTTLERS.length);
  });

  it('são exatamente `curto` e `medio`', () => {
    /* Crava o contrato que os `@Throttle` do app inteiro assumem. Renomear um
       balde sem reescrever os decorators é o mesmo defeito de antes, ao contrário. */
    expect([...NOMES_DE_THROTTLER].sort()).toEqual(['curto', 'medio']);
  });
});

describe('@Throttle — todo nome citado precisa EXISTIR', () => {
  /* O teste que faltava quando `default` passou despercebido. */
  it.each([
    ['webhook do gateway', CobrancaController.prototype.webhook],
    ['cadastro público', CadastroController.prototype.criar],
    /* Acesso do titular (LGPD art. 18): a rota é nova e o balde dela precisa
       entrar aqui no mesmo commit. Um `@Throttle` que nomeia balde inexistente
       não falha em lugar nenhum — vira metadado morto, e a proteção passa a
       existir só no comentário. */
    ['acesso do titular', TitularController.prototype.dados],
    ['exportacao da propria conta', MinhaContaController.prototype.exportar],
    /* As duas reconferências de senha: verificam a senha e por isso ganharam
       teto próprio. Um `@Throttle` que nomeie balde inexistente aqui deixaria a
       rota com o global de 120/min — de novo o defeito do `default`. */
    ['trocar a própria senha', AuthController.prototype.trocarSenha],
    ['desativar o segundo fator', AuthController.prototype.desativarMfa],
  ])('%s só cita baldes registrados', (_rotulo, metodo) => {
    const citados = Object.keys(baldesDe(metodo));

    expect(citados.length).toBeGreaterThan(0);
    for (const nome of citados) {
      expect(NOMES_DE_THROTTLER).toContain(nome);
    }
  });
});

describe('webhook do gateway — os DOIS baldes têm teto próprio', () => {
  const baldes = () => baldesDe(CobrancaController.prototype.webhook);

  it('sobrescreve `curto` E `medio`, não só um', () => {
    /* O defeito corrigido: sobrescrever apenas `medio` deixava `curto` valendo
       com o global de 10/s. O gateway manda em rajada e tomava 429 — e evento
       recusado vira reenvio, penalização e, no fim, pagamento sem baixa. */
    expect(Object.keys(baldes()).sort()).toEqual(['curto', 'medio']);
  });

  it('o teto é FOLGADO o bastante para uma rajada de vencimentos', () => {
    /* Números com razão de ser: ~30 faturas vencendo no mesmo minuto é o cenário
       realista que o teto antigo (30/min) cortava. Se alguém baixar isso de
       volta para perto de 30, este teste reprova e obriga a pensar de novo. */
    const { medio } = baldes();
    expect(medio.ttl).toBe(60_000);
    expect(medio.limit).toBeGreaterThanOrEqual(300);
  });

  it('continua sendo teto DE VERDADE — a rota é pública e escreve', () => {
    /* O throttle roda ANTES da autenticação, então é a única barreira contra
       quem nem tem o token. "Afrouxar" não pode virar "abrir". */
    const { curto, medio } = baldes();
    expect(curto.limit).toBeLessThanOrEqual(60);
    expect(medio.limit).toBeLessThanOrEqual(1_000);
  });

  it('a janela de `curto` continua sendo de 1 segundo', () => {
    /* Sobrescrever o limite e esquecer o ttl transformaria o balde de rajada
       em outra coisa, sem ninguém perceber. */
    expect(baldes().curto.ttl).toBe(1_000);
  });
});

describe('reconferências de senha — teto apertado por conta do que fazem', () => {
  /* `trocar-senha` e `mfa/desativar` conferem a senha, mas a reconferência NÃO
     alimenta o `tentativasFalhas` (o bloqueio por conta). Sem teto próprio, o
     global de 120/min por IP seria a única barreira à força bruta — e num caso
     (desativar) ela remove justamente o fator que quem tomou a sessão não tem.
     O pentest de 22/09/2026 achou a lacuna; estes números são a trava. */
  it.each([
    ['trocar-senha', AuthController.prototype.trocarSenha],
    ['mfa/desativar', AuthController.prototype.desativarMfa],
  ])('%s tem teto de no máximo 5/min no balde `medio`', (_rotulo, metodo) => {
    const { medio } = baldesDe(metodo);
    expect(medio).toBeDefined();
    expect(medio.ttl).toBe(60_000);
    expect(medio.limit).toBeLessThanOrEqual(5);
  });
});
