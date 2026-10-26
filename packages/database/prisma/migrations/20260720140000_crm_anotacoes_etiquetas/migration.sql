-- Camada de escrita do CRM: anotações, etiquetas, prioridade e responsável.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram, que
-- vêm de SQL bruto e não existem no schema Prisma.
--
-- ⚠ A diferença de desenho que sustenta este arquivo: nada aqui é append-only.
-- `anotacoes_processo` guarda texto livre escrito por advogado, que contém dado
-- pessoal ("ligar para a filha no 81 9xxxx"). Por isso a anotação NÃO virou um
-- EventoProcesso: aquela tabela é imutável por desenho e um pedido de exclusão
-- do titular não teria como apagá-la. Aqui a linha é editável e removível.

BEGIN;

CREATE TYPE "PrioridadeProcesso" AS ENUM ('BAIXA', 'NORMAL', 'ALTA', 'URGENTE');

-- Coluna NOT NULL com default não reescreve a tabela no Postgres 11+; os 4.188
-- processos existentes passam a NORMAL sem downtime e sem UPDATE em massa.
ALTER TABLE "processos"
  ADD COLUMN "prioridade" "PrioridadeProcesso" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "responsavelId" UUID;

-- SET NULL e não CASCADE: desligar um usuário não pode apagar o processo dele.
ALTER TABLE "processos"
  ADD CONSTRAINT "processos_responsavelId_fkey"
  FOREIGN KEY ("responsavelId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- "meus processos urgentes primeiro" é a leitura que abre o dia do operador.
CREATE INDEX "processos_organizationId_responsavelId_prioridade_idx"
  ON "processos"("organizationId", "responsavelId", "prioridade");

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "anotacoes_processo" (
  "id"         UUID PRIMARY KEY,
  "processoId" UUID NOT NULL,
  "autorId"    UUID NOT NULL,
  "texto"      TEXT NOT NULL,
  "fixada"     BOOLEAN NOT NULL DEFAULT false,
  "criadoEm"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"  TIMESTAMP(3) NOT NULL
);

ALTER TABLE "anotacoes_processo"
  ADD CONSTRAINT "anotacoes_processo_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- RESTRICT: apagar um usuário não pode evaporar as anotações do caso, que são
-- registro de trabalho do escritório. Quem apagar terá de decidir o que fazer
-- com elas antes — falhar alto é melhor que perder em silêncio.
ALTER TABLE "anotacoes_processo"
  ADD CONSTRAINT "anotacoes_processo_autorId_fkey"
  FOREIGN KEY ("autorId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE INDEX "anotacoes_processo_processoId_criadoEm_idx"
  ON "anotacoes_processo"("processoId", "criadoEm" DESC);
CREATE INDEX "anotacoes_processo_autorId_idx" ON "anotacoes_processo"("autorId");

-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "etiquetas" (
  "id"             UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL,
  "nome"           TEXT NOT NULL,
  -- Nome de um token do tema (marca-ciano, ok, alerta...), nunca hexadecimal:
  -- assim a paleta muda num lugar só.
  "cor"            TEXT NOT NULL DEFAULT 'marca-ciano',
  "criadoEm"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "etiquetas"
  ADD CONSTRAINT "etiquetas_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Sem isto, "Acordo" e "acordo" viram duas etiquetas e o filtro deixa de fechar.
CREATE UNIQUE INDEX "etiquetas_organizationId_nome_key" ON "etiquetas"("organizationId", "nome");

CREATE TABLE "processo_etiquetas" (
  "processoId" UUID NOT NULL,
  "etiquetaId" UUID NOT NULL,
  "criadoEm"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processo_etiquetas_pkey" PRIMARY KEY ("processoId", "etiquetaId")
);

ALTER TABLE "processo_etiquetas"
  ADD CONSTRAINT "processo_etiquetas_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "processo_etiquetas"
  ADD CONSTRAINT "processo_etiquetas_etiquetaId_fkey"
  FOREIGN KEY ("etiquetaId") REFERENCES "etiquetas"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- Para "quais processos têm a etiqueta X" — o lado que a PK não cobre.
CREATE INDEX "processo_etiquetas_etiquetaId_idx" ON "processo_etiquetas"("etiquetaId");

COMMIT;
