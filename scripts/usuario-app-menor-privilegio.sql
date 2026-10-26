-- Usuário de MENOR PRIVILÉGIO para a aplicação.
--
-- ── O PROBLEMA ──
--
-- Hoje a API conecta com o DONO do banco. Esse papel pode DROP TABLE, TRUNCATE,
-- ALTER — tudo. Não é hipótese distante: uma falha de injeção, um script rodado
-- na URL errada, ou um bug num `$queryRawUnsafe` apagam a carteira inteira.
-- Com 12.425 processos e 12.358 pessoas, a diferença entre "perdemos dados" e
-- "não foi possível" é este arquivo.
--
-- ── A DIVISÃO ──
--
-- Dois papéis, porque os dois momentos são diferentes:
--   • o DONO continua rodando as MIGRATIONS (precisa de DDL) — é o
--     `preDeployCommand` do render.yaml, que roda uma vez por deploy;
--   • a APLICAÇÃO passa a rodar com `miner_app`, que só lê e escreve LINHA.
--     Sem DROP, sem TRUNCATE, sem ALTER.
--
-- ⚠ ESTE ARQUIVO NÃO RODA SOZINHO. Precisa ser executado À MÃO, uma vez, pelo
-- dono do banco — e a senha precisa ser trocada abaixo antes. Depois disso, o
-- `DATABASE_URL` da API passa a apontar para `miner_app`, e o do preDeploy
-- continua com o dono.
--
-- ⚠⚠ NÃO FOI POSSÍVEL TESTAR ESTES GRANTS, e isso precisa ser dito.
--
-- O usuário `miner` do ambiente local não tem CREATEROLE, então o papel de
-- prova não pôde ser criado aqui. O que FOI verificado, contra o banco de
-- teste, é a PREMISSA — e ela se confirmou inteira:
--
--   current_user = miner  ·  superuser=false, createrole=false
--   dono da tabela `processos` = miner
--   CREATE TABLE  : PERMITIDO
--   ALTER TABLE   : PERMITIDO
--   DROP TABLE    : PERMITIDO
--   TRUNCATE em processos / pessoas / consultas_cliente : PERMITIDO
--
-- Ou seja: hoje a aplicação pode destruir a base inteira. O risco é real.
--
-- Ao executar em produção, RODE A CONFERÊNCIA do fim do arquivo — inclusive o
-- `DROP TABLE processos` conectado como `miner_app`, que TEM de falhar. É a
-- única prova de que isto funcionou.
--
-- ⚠ RODE DE NOVO DEPOIS DE CADA MIGRATION QUE CRIE TABELA. O GRANT vale para o
-- que existe HOJE; a linha `ALTER DEFAULT PRIVILEGES` cobre o futuro, mas só
-- para objetos criados pelo papel que a executou. Se uma tabela nova aparecer
-- inacessível, é isto.

-- ── 1. O papel ──
-- Troque a senha ANTES de executar. Não use a mesma do dono.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miner_app') THEN
    CREATE ROLE miner_app LOGIN PASSWORD 'TROQUE_ESTA_SENHA';
  END IF;
END
$$;

-- ── 2. Conectar e enxergar o schema ──
GRANT CONNECT ON DATABASE miner TO miner_app;
GRANT USAGE ON SCHEMA public TO miner_app;

-- ── 3. Ler e escrever LINHA, e nada além disso ──
-- Repare no que NÃO está aqui: TRUNCATE, REFERENCES, TRIGGER, CREATE.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO miner_app;

-- As sequências são necessárias para o INSERT em tabelas com coluna serial.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO miner_app;

-- ── 4. O que for criado no futuro ──
-- Sem isto, toda migration nova produziria uma tabela invisível para a
-- aplicação — e o erro apareceria em produção, não no deploy.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO miner_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO miner_app;

-- ── 5. Fechar a porta que vem aberta por padrão ──
-- No PostgreSQL, QUALQUER usuário pode criar objeto no schema `public` a menos
-- que se retire. Sem esta linha, `miner_app` não derruba tabela mas ainda cria
-- as dele — inclusive uma que sombreie uma existente.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ── Conferência ──
-- Deve listar SELECT/INSERT/UPDATE/DELETE e NENHUM 'TRUNCATE'.
--
--   SELECT DISTINCT privilege_type
--     FROM information_schema.role_table_grants
--    WHERE grantee = 'miner_app'
--    ORDER BY 1;
--
-- E o teste que importa, conectado COMO miner_app — tem de FALHAR:
--
--   DROP TABLE processos;
