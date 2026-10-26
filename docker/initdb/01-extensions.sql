-- Extensões necessárias, criadas antes de qualquer migration.
-- pg_trgm: busca por nome tolerante a acento/erro de grafia (índice GIN em nomeNormalizado).
-- unaccent: normalização de acentos no lado do banco.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
