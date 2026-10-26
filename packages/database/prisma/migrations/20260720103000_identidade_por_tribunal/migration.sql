-- Identidade do processo por tribunal + tenancy da carteira.
--
-- Escrita à mão: `prisma migrate diff` propõe derrubar os 5 índices trigram,
-- que vêm de migration SQL bruta e não existem no schema Prisma.
--
-- Ordem importa: as colunas nascem anuláveis, recebem backfill e só então
-- viram NOT NULL. Criá-las já obrigatórias falharia com 4.188 linhas existentes.

CREATE TYPE "EsferaTribunal" AS ENUM ('FEDERAL', 'ESTADUAL', 'TRABALHISTA', 'SUPERIOR');

CREATE TABLE "tribunais" (
  "id"            UUID PRIMARY KEY,
  "sigla"         VARCHAR(12) NOT NULL,
  "nome"          TEXT NOT NULL,
  "esfera"        "EsferaTribunal" NOT NULL DEFAULT 'FEDERAL',
  "ufsJurisdicao" VARCHAR(2)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(2)[],
  "ativo"         BOOLEAN NOT NULL DEFAULT true,
  "criadoEm"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"     TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "tribunais_sigla_key" ON "tribunais"("sigla");

-- Os seis TRFs. Jurisdições conforme a organização da Justiça Federal.
INSERT INTO "tribunais" ("id","sigla","nome","ufsJurisdicao","editadoEm") VALUES
 (gen_random_uuid(),'TRF1','Tribunal Regional Federal da 1ª Região',
   ARRAY['AC','AM','AP','BA','DF','GO','MA','MG','MT','PA','PI','RO','RR','TO']::VARCHAR(2)[], now()),
 (gen_random_uuid(),'TRF2','Tribunal Regional Federal da 2ª Região',
   ARRAY['ES','RJ']::VARCHAR(2)[], now()),
 (gen_random_uuid(),'TRF3','Tribunal Regional Federal da 3ª Região',
   ARRAY['MS','SP']::VARCHAR(2)[], now()),
 (gen_random_uuid(),'TRF4','Tribunal Regional Federal da 4ª Região',
   ARRAY['PR','RS','SC']::VARCHAR(2)[], now()),
 (gen_random_uuid(),'TRF5','Tribunal Regional Federal da 5ª Região',
   ARRAY['AL','CE','PB','PE','RN','SE']::VARCHAR(2)[], now()),
 (gen_random_uuid(),'TRF6','Tribunal Regional Federal da 6ª Região',
   ARRAY['MG']::VARCHAR(2)[], now());

-- Colunas anuláveis primeiro.
ALTER TABLE "processos" ADD COLUMN "tribunalId"     UUID;
ALTER TABLE "processos" ADD COLUMN "organizationId" UUID;

-- Backfill. Toda a base atual é TRF5 (verificado: SELECT DISTINCT tribunal).
UPDATE "processos" p
   SET "tribunalId" = (SELECT id FROM "tribunais" WHERE sigla = upper(replace(coalesce(p.tribunal,'TRF5'),'-','')))
 WHERE p."tribunalId" IS NULL;

-- Só existe uma organização; se houvesse mais, este passo exigiria decisão humana.
UPDATE "processos"
   SET "organizationId" = (SELECT id FROM "organizations" ORDER BY "criadoEm" LIMIT 1)
 WHERE "organizationId" IS NULL;

-- Trava de segurança: aborta se algum processo ficou sem tribunal ou organização.
DO $$
DECLARE orfaos INT;
BEGIN
  SELECT count(*) INTO orfaos FROM "processos"
   WHERE "tribunalId" IS NULL OR "organizationId" IS NULL;
  IF orfaos > 0 THEN
    RAISE EXCEPTION 'Backfill incompleto: % processo(s) sem tribunal ou organização', orfaos;
  END IF;
END $$;

ALTER TABLE "processos" ALTER COLUMN "tribunalId"     SET NOT NULL;
ALTER TABLE "processos" ALTER COLUMN "organizationId" SET NOT NULL;

ALTER TABLE "processos"
  ADD CONSTRAINT "processos_tribunalId_fkey"
  FOREIGN KEY ("tribunalId") REFERENCES "tribunais"("id") ON UPDATE CASCADE ON DELETE RESTRICT;
ALTER TABLE "processos"
  ADD CONSTRAINT "processos_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- A identidade muda: número é único DENTRO do tribunal, não globalmente.
DROP INDEX IF EXISTS "processos_numeroPrecatorio_key";
CREATE UNIQUE INDEX "processos_tribunalId_numeroPrecatorio_key"
  ON "processos"("tribunalId","numeroPrecatorio");
CREATE INDEX "processos_organizationId_tribunalId_exercicio_idx"
  ON "processos"("organizationId","tribunalId","exercicio");

-- A coluna texto sai só depois de tudo migrado.
ALTER TABLE "processos" DROP COLUMN "tribunal";
