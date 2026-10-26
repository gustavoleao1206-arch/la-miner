-- Perfil de importação por tribunal.
--
-- Escrita à mão: `prisma migrate diff` propõe derrubar os índices trigram.
--
-- O perfil do TRF5 nasce com exatamente os aliases que estavam na constante
-- COLUNAS do importacao.service.ts, para que a importação existente continue
-- se comportando igual. A diferença é que agora eles são dado, não código.
CREATE TABLE "perfis_importacao" (
  "id"                  UUID PRIMARY KEY,
  "tribunalId"          UUID NOT NULL,
  "nome"                TEXT NOT NULL,
  "mapaColunas"         JSONB NOT NULL,
  "colunasObrigatorias" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "aba"                 TEXT,
  "ativo"               BOOLEAN NOT NULL DEFAULT true,
  "criadoEm"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"           TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "perfis_importacao_tribunalId_nome_key" ON "perfis_importacao"("tribunalId","nome");
CREATE INDEX "perfis_importacao_tribunalId_ativo_idx" ON "perfis_importacao"("tribunalId","ativo");
ALTER TABLE "perfis_importacao"
  ADD CONSTRAINT "perfis_importacao_tribunalId_fkey"
  FOREIGN KEY ("tribunalId") REFERENCES "tribunais"("id") ON UPDATE CASCADE ON DELETE CASCADE;

INSERT INTO "perfis_importacao" ("id","tribunalId","nome","mapaColunas","colunasObrigatorias","editadoEm")
SELECT gen_random_uuid(), t.id, 'Dívida Consolidada',
  '{
    "cpf":["cpf","cpf do requerente","cpf/cnpj","documento","cpf requerente"],
    "nome":["nome","nome completo","requerente","nome do requerente","exequente","nome completo do requerente/exequente"],
    "processo":["processo","precatorio","precatório","numero do processo","nº do processo","processo precatorio","número do processo de precatório no trf5"],
    "originario":["originario","originário","processo originario","numero do processo de execução/originário","número do processo de execução/originário"],
    "requisitorio":["requisitorio","requisitório","numero do requisitorio","número do requisitório"],
    "valor":["valor","valor individual","valor atualizado","valor atualizado individual"],
    "entidade":["entidade","entidade devedora","orgao","órgão"]
  }'::jsonb,
  ARRAY['cpf','processo']::TEXT[], now()
  FROM "tribunais" t WHERE t.sigla = 'TRF5';
