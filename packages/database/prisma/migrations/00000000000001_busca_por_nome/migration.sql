-- Busca por nome tolerante a acento e erro de grafia.
-- O Prisma não gera índices GIN/trigram, então vão aqui explicitamente.
--
-- Sem isso, "SELECT ... WHERE nomeNormalizado ILIKE '%silva%'" faz sequential scan
-- na tabela inteira de pessoas. Com o índice, vira busca indexada.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Busca por trecho do nome: ILIKE '%termo%' e similaridade (%)
CREATE INDEX IF NOT EXISTS "pessoas_nome_normalizado_trgm_idx"
  ON "pessoas" USING GIN ("nomeNormalizado" gin_trgm_ops);

-- Busca por trecho do CPF (ex.: últimos dígitos)
CREATE INDEX IF NOT EXISTS "pessoas_cpf_trgm_idx"
  ON "pessoas" USING GIN ("cpf" gin_trgm_ops);

-- Busca por número de processo parcial
CREATE INDEX IF NOT EXISTS "processos_numero_precatorio_trgm_idx"
  ON "processos" USING GIN ("numeroPrecatorio" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "processos_numero_originario_trgm_idx"
  ON "processos" USING GIN ("numeroOriginario" gin_trgm_ops);

-- Cidade costuma ser digitada parcialmente e com acento inconsistente
CREATE INDEX IF NOT EXISTS "enderecos_cidade_trgm_idx"
  ON "enderecos" USING GIN ("cidade" gin_trgm_ops);
