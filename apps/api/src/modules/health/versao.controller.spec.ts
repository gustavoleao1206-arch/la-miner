import { VersaoController } from './versao.controller';
import type { ConfigService } from '@nestjs/config';

/**
 * O caso que o teste de integração NÃO alcança: a Render fora do ar da conta —
 * ou seja, `RENDER_GIT_COMMIT` ausente.
 *
 * Lá a app é montada UMA vez, com a variável definida, então o ramo do "não
 * sei" nunca roda. Uma mutação trocando `?? null` por `?? 'desconhecido'`
 * passou verde por causa disso — e é justamente a troca que quebra quem
 * consome: `'desconhecido'` é uma string, e uma comparação desatenta com o SHA
 * esperado a trataria como um valor.
 */
const configDe = (valores: Record<string, string | undefined>) =>
  ({ get: (chave: string) => valores[chave] }) as unknown as ConfigService;

describe('VersaoController', () => {
  it('sem RENDER_GIT_COMMIT, o commit é NULO — e não uma string', () => {
    const r = new VersaoController(configDe({ NODE_ENV: 'test' })).versao();

    expect(r.commit).toBeNull();
    /* O curto acompanha: um `''` aqui seria outro valor disfarçado de resposta. */
    expect(r.curto).toBeNull();
    expect(r.ambiente).toBe('test');
  });

  it('com o commit, devolve o SHA inteiro e os 7 primeiros', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const r = new VersaoController(configDe({ RENDER_GIT_COMMIT: sha })).versao();

    expect(r.commit).toBe(sha);
    expect(r.curto).toBe('0123456');
    /* Ambiente ausente também é nulo — nada de inventar 'development'. */
    expect(r.ambiente).toBeNull();
  });

  it('noArDesde é um instante no passado, não no futuro', () => {
    const r = new VersaoController(configDe({})).versao();
    const quando = new Date(r.noArDesde).getTime();

    expect(Number.isNaN(quando)).toBe(false);
    expect(quando).toBeLessThanOrEqual(Date.now());
  });
});
