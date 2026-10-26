-- Cobrança: faturas, eventos do gateway e os ids externos na assinatura.
--
-- Aditiva e escrita à mão (trigram). Nada aqui LIGA cobrança de verdade: o
-- provedor padrão é o MANUAL, e um gateway só entra por configuração explícita —
-- mesma disciplina do enriquecimento, que nasce em `fake`.

BEGIN;

CREATE TYPE "StatusFatura" AS ENUM ('ABERTA', 'PAGA', 'VENCIDA', 'CANCELADA', 'ESTORNADA');

-- ── Ids do gateway na assinatura ──
-- `provedorCobranca` fica na LINHA, e não é lido do env na hora de interpretar:
-- trocar de gateway não pode reinterpretar retroativamente os ids que o anterior
-- gerou. `inadimplenteDesde` é de onde sai a carência antes de suspender.
ALTER TABLE "assinaturas"
  ADD COLUMN "provedorCobranca"    TEXT,
  ADD COLUMN "clienteExternoId"    TEXT,
  ADD COLUMN "assinaturaExternaId" TEXT,
  ADD COLUMN "inadimplenteDesde"   TIMESTAMP(3);

-- ── Faturas ──
CREATE TABLE "faturas" (
  "id"           UUID PRIMARY KEY,
  "assinaturaId" UUID NOT NULL,
  "competencia"  DATE NOT NULL,
  "valor"        DECIMAL(12,2) NOT NULL,
  "status"       "StatusFatura" NOT NULL DEFAULT 'ABERTA',
  -- DATE, não TIMESTAMP: vencimento é DIA. Guardar instante faria a fatura vencer
  -- em horas diferentes conforme o fuso de quem olha — e vencimento adiantado
  -- suspende cliente adimplente.
  "vencimentoEm" DATE NOT NULL,
  "pagoEm"       TIMESTAMP(3),
  "idExterno"    TEXT,
  "urlPagamento" TEXT,
  "criadoEm"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"    TIMESTAMP(3) NOT NULL
);
-- Uma fatura por ciclo → emissão idempotente, como o lote de distribuição.
CREATE UNIQUE INDEX "faturas_assinaturaId_competencia_key"
  ON "faturas"("assinaturaId", "competencia");
-- É por este id que o webhook encontra a fatura. Duplicado daria baixa na errada.
-- (Nulo é permitido e repetível em índice único do Postgres — o provedor manual
--  não gera id externo, e várias faturas manuais convivem sem conflito.)
CREATE UNIQUE INDEX "faturas_idExterno_key" ON "faturas"("idExterno");
CREATE INDEX "faturas_status_vencimentoEm_idx" ON "faturas"("status", "vencimentoEm");

ALTER TABLE "faturas"
  ADD CONSTRAINT "faturas_assinaturaId_fkey"
  FOREIGN KEY ("assinaturaId") REFERENCES "assinaturas"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- ── Eventos do gateway ──
CREATE TABLE "eventos_cobranca" (
  "id"           UUID PRIMARY KEY,
  "provedor"     TEXT NOT NULL,
  "idExterno"    TEXT NOT NULL,
  "tipo"         TEXT NOT NULL,
  "payload"      JSONB NOT NULL,
  "processadoEm" TIMESTAMP(3),
  "erro"         TEXT,
  "criadoEm"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- A idempotência do webhook. Gateway REENVIA o evento quando não recebe 200 a
-- tempo, e aplicar "pagamento confirmado" duas vezes reativaria uma assinatura
-- que o cliente cancelou no meio.
CREATE UNIQUE INDEX "eventos_cobranca_idExterno_key" ON "eventos_cobranca"("idExterno");
CREATE INDEX "eventos_cobranca_tipo_criadoEm_idx"
  ON "eventos_cobranca"("tipo", "criadoEm" DESC);

COMMIT;
