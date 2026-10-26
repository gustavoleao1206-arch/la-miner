import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { conferirSombraEnv } from './conferir-sombra-env';

/**
 * A trava que recusa subir quando o `.env` da raiz não é o que a aplicação está
 * usando. Nasceu de um incidente real: `packages/database/.env` guardava uma
 * cópia dos segredos, o client do Prisma a carregava antes do `@nestjs/config`,
 * e o dotenv não sobrescreve o que já existe — então rotacionar o segredo na
 * raiz não mudava nada, e o arquivo rotacionado dava a impressão contrária.
 */
describe('conferirSombraEnv', () => {
  let dir: string;
  let arquivo: string;

  const SEGREDO_DO_ARQUIVO = 'segredo-que-o-arquivo-declara-aaaaaaaaaaaaaaaaaaaa';
  const SEGREDO_EM_USO = 'segredo-que-a-aplicacao-usa-bbbbbbbbbbbbbbbbbbbbbbbb';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sombra-env-'));
    arquivo = join(dir, '.env');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const escrever = (conteudo: string) => writeFileSync(arquivo, conteudo, 'utf8');

  it('passa quando o valor em uso é o que o arquivo declara', () => {
    escrever(`JWT_ACCESS_SECRET=${SEGREDO_DO_ARQUIVO}\n`);
    expect(() =>
      conferirSombraEnv(arquivo, { JWT_ACCESS_SECRET: SEGREDO_DO_ARQUIVO }),
    ).not.toThrow();
  });

  it('recusa quando a aplicação usa valor diferente do declarado', () => {
    escrever(`JWT_ACCESS_SECRET=${SEGREDO_DO_ARQUIVO}\n`);
    expect(() => conferirSombraEnv(arquivo, { JWT_ACCESS_SECRET: SEGREDO_EM_USO })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  /**
   * A mensagem vai para o log. Vazar ali o segredo que a trava existe para
   * proteger transformaria a proteção no próprio incidente — e num arquivo de
   * log, que costuma ser menos vigiado que o .env.
   */
  it('NUNCA imprime os valores na mensagem — só impressões digitais', () => {
    escrever(`JWT_REFRESH_SECRET=${SEGREDO_DO_ARQUIVO}\n`);
    try {
      conferirSombraEnv(arquivo, { JWT_REFRESH_SECRET: SEGREDO_EM_USO });
      fail('deveria ter lançado');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(SEGREDO_DO_ARQUIVO);
      expect(msg).not.toContain(SEGREDO_EM_USO);
      expect(msg).toMatch(/JWT_REFRESH_SECRET/);
    }
  });

  it('aponta TODAS as chaves divergentes, não só a primeira', () => {
    escrever(`JWT_ACCESS_SECRET=${SEGREDO_DO_ARQUIVO}\nCONTACTRA_CLIENT_SECRET=${SEGREDO_DO_ARQUIVO}\n`);
    try {
      conferirSombraEnv(arquivo, {
        JWT_ACCESS_SECRET: SEGREDO_EM_USO,
        CONTACTRA_CLIENT_SECRET: SEGREDO_EM_USO,
      });
      fail('deveria ter lançado');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/JWT_ACCESS_SECRET/);
      expect(msg).toMatch(/CONTACTRA_CLIENT_SECRET/);
    }
  });

  /**
   * Quem sobe sem `.env`, com variáveis de ambiente de verdade (o normal em
   * produção), não pode ser barrado — não há nada com que comparar.
   */
  it('sem arquivo, não opina', () => {
    expect(() =>
      conferirSombraEnv(join(dir, 'nao-existe.env'), { JWT_ACCESS_SECRET: SEGREDO_EM_USO }),
    ).not.toThrow();
  });

  it('chave ausente do arquivo não é sombra', () => {
    escrever('OUTRA_COISA=1\n');
    expect(() => conferirSombraEnv(arquivo, { JWT_ACCESS_SECRET: SEGREDO_EM_USO })).not.toThrow();
  });

  it('chave do arquivo ausente do ambiente é configuração faltando, não sombra', () => {
    escrever(`JWT_ACCESS_SECRET=${SEGREDO_DO_ARQUIVO}\n`);
    expect(() => conferirSombraEnv(arquivo, {})).not.toThrow();
  });

  /**
   * Divergir a porta é ruído de desenvolvimento; divergir o segredo de
   * assinatura derruba a garantia inteira. A trava só olha credencial para
   * poder ser fatal sem virar estorvo.
   */
  it('ignora divergência em chave que não é credencial', () => {
    escrever('API_PORT=3333\nSWAGGER_ENABLED=true\n');
    expect(() =>
      conferirSombraEnv(arquivo, { API_PORT: '9999', SWAGGER_ENABLED: 'false' }),
    ).not.toThrow();
  });
});
