import { urlComLimites } from './prisma.service';

/**
 * A montagem da URL de conexão.
 *
 * Parece trivial e não é: a URL da Render vem SEM query, a de desenvolvimento
 * vem COM `?schema=public`, e concatenar sem olhar produz duas interrogações e
 * uma URL que o Prisma recusa — no boot, em produção, depois do deploy.
 */
describe('urlComLimites', () => {
  const limites = { conexoes: 10, poolSegundos: 10, consultaMs: 30_000 };

  it('acrescenta os três limites a uma URL sem query', () => {
    const url = urlComLimites('postgresql://u:s@host:5432/miner', limites);
    const q = new URL(url).searchParams;

    expect(q.get('connection_limit')).toBe('10');
    expect(q.get('pool_timeout')).toBe('10');
    expect(q.get('options')).toBe('-c statement_timeout=30000');
  });

  it('PRESERVA a query que já existe, em vez de sobrescrever', () => {
    /* O `?schema=public` do ambiente de desenvolvimento. Perdê-lo mandaria a
       aplicação para o schema errado — e sem erro, porque `public` também
       existe: as tabelas é que estariam vazias. */
    const url = urlComLimites('postgresql://u:s@host:5432/miner?schema=public', limites);

    expect(url).toContain('schema=public');
    expect(new URL(url).searchParams.get('connection_limit')).toBe('10');
    // Uma interrogação só — duas produzem URL inválida.
    expect(url.split('?')).toHaveLength(2);
  });

  it('o statement_timeout vai codificado, senão o espaço quebra a URL', () => {
    /* `-c statement_timeout=30000` tem ESPAÇO. Sem codificar, a URL é inválida
       e o erro aparece só na conexão, sem dizer que a culpa é daqui. */
    const url = urlComLimites('postgresql://u:s@host:5432/miner', limites);
    expect(url).toContain('options=-c+statement_timeout%3D30000');
    // E o parser desfaz a codificação de volta ao valor certo.
    expect(new URL(url).searchParams.get('options')).toBe('-c statement_timeout=30000');
  });

  it('respeita valores diferentes dos padrões', () => {
    const url = urlComLimites('postgresql://u:s@h/db', {
      conexoes: 3,
      poolSegundos: 20,
      consultaMs: 5_000,
    });
    const q = new URL(url).searchParams;

    expect(q.get('connection_limit')).toBe('3');
    expect(q.get('pool_timeout')).toBe('20');
    expect(q.get('options')).toBe('-c statement_timeout=5000');
  });

  it('não altera usuário, senha, host nem banco', () => {
    /* A URL carrega credencial. Uma montagem que a corrompesse falharia na
       autenticação, e o erro apontaria para a senha — não para este código. */
    const base = 'postgresql://miner:s3nh%40@db.interno:5432/miner';
    const url = urlComLimites(base, limites);
    const u = new URL(url);

    expect(u.username).toBe('miner');
    expect(u.password).toBe('s3nh%40');
    expect(u.host).toBe('db.interno:5432');
    expect(u.pathname).toBe('/miner');
  });
});
