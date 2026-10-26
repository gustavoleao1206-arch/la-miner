-- Assinatura, planos, lotes mensais e a carteira liberada.
--
-- O vínculo que faltava: `processos_liberados` diz QUEM pode ver cada processo,
-- separado de quem é o DONO (processos.organizationId). Um processo é liberado
-- para vários clientes; a org interna vê tudo sem passar por aqui.
--
-- Aditiva e escrita à mão (trigram). Nada aqui toca dado existente.

BEGIN;

CREATE TYPE "StatusAssinatura" AS ENUM ('PENDENTE', 'ATIVA', 'INADIMPLENTE', 'SUSPENSA', 'CANCELADA');

-- ── Planos (catálogo) ──
CREATE TABLE "planos" (
  "id"                UUID PRIMARY KEY,
  "nome"              TEXT NOT NULL,
  "descricao"         TEXT,
  "processosPorCiclo" INTEGER NOT NULL,
  "preco"             DECIMAL(12,2) NOT NULL,
  "intervaloMeses"    INTEGER NOT NULL DEFAULT 1,
  "ativo"             BOOLEAN NOT NULL DEFAULT true,
  "criadoEm"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"         TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "planos_nome_key" ON "planos"("nome");

-- ── Assinatura (uma por org CLIENTE) ──
CREATE TABLE "assinaturas" (
  "id"                 UUID PRIMARY KEY,
  "organizationId"     UUID NOT NULL,
  "planoId"            UUID NOT NULL,
  "status"             "StatusAssinatura" NOT NULL DEFAULT 'PENDENTE',
  "inicioEm"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- DATE: renovação é um DIA; não pode escorregar com o fuso do servidor.
  "proximaRenovacaoEm" DATE,
  "canceladaEm"        TIMESTAMP(3),
  "criadoEm"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"          TIMESTAMP(3) NOT NULL
);
-- @unique(organizationId): uma assinatura por cliente; o status transiciona nela.
CREATE UNIQUE INDEX "assinaturas_organizationId_key" ON "assinaturas"("organizationId");
CREATE INDEX "assinaturas_status_proximaRenovacaoEm_idx"
  ON "assinaturas"("status", "proximaRenovacaoEm");

ALTER TABLE "assinaturas"
  ADD CONSTRAINT "assinaturas_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
-- RESTRICT no plano: não se apaga um plano que ainda tem assinatura viva.
ALTER TABLE "assinaturas"
  ADD CONSTRAINT "assinaturas_planoId_fkey"
  FOREIGN KEY ("planoId") REFERENCES "planos"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── Lotes mensais ──
CREATE TABLE "lotes_assinatura" (
  "id"                 UUID PRIMARY KEY,
  "assinaturaId"       UUID NOT NULL,
  "competencia"        DATE NOT NULL,
  "quantidadeAlvo"     INTEGER NOT NULL,
  "quantidadeLiberada" INTEGER NOT NULL DEFAULT 0,
  "criadoEm"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Um lote por mês por assinatura → cron de renovação idempotente.
CREATE UNIQUE INDEX "lotes_assinatura_assinaturaId_competencia_key"
  ON "lotes_assinatura"("assinaturaId", "competencia");
CREATE INDEX "lotes_assinatura_assinaturaId_competencia_idx"
  ON "lotes_assinatura"("assinaturaId", "competencia" DESC);

ALTER TABLE "lotes_assinatura"
  ADD CONSTRAINT "lotes_assinatura_assinaturaId_fkey"
  FOREIGN KEY ("assinaturaId") REFERENCES "assinaturas"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- ── Carteira liberada (a tabela que mais cresce: clientes × processos) ──
CREATE TABLE "processos_liberados" (
  "id"             UUID PRIMARY KEY,
  "organizationId" UUID NOT NULL,
  "processoId"     UUID NOT NULL,
  "loteId"         UUID NOT NULL,
  "liberadoEm"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Nunca reenviar o mesmo processo ao mesmo cliente (regra do produto + dedup).
CREATE UNIQUE INDEX "processos_liberados_organizationId_processoId_key"
  ON "processos_liberados"("organizationId", "processoId");
-- A carteira do cliente, recém-liberados primeiro.
CREATE INDEX "processos_liberados_organizationId_liberadoEm_idx"
  ON "processos_liberados"("organizationId", "liberadoEm" DESC);
-- Reverse lookup ("quais clientes têm este processo") + cascade da exclusão.
CREATE INDEX "processos_liberados_processoId_idx" ON "processos_liberados"("processoId");
CREATE INDEX "processos_liberados_loteId_idx" ON "processos_liberados"("loteId");

ALTER TABLE "processos_liberados"
  ADD CONSTRAINT "processos_liberados_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "processos_liberados"
  ADD CONSTRAINT "processos_liberados_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "processos_liberados"
  ADD CONSTRAINT "processos_liberados_loteId_fkey"
  FOREIGN KEY ("loteId") REFERENCES "lotes_assinatura"("id") ON UPDATE CASCADE ON DELETE CASCADE;

COMMIT;
