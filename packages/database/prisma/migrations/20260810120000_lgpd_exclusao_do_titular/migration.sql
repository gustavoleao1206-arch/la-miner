-- Exclusão a pedido do titular (LGPD art. 18, VI) e marca de retenção.
--
-- ── POR QUE UM ESTADO NOVO, E NÃO SÓ APAGAR AS LINHAS ──
--
-- Apagar telefone, e-mail e endereço não resolve nada sozinho: a pessoa volta
-- para a fila de enriquecimento no ciclo seguinte (o cron pega PENDENTE, ERRO e
-- SINCRONIZADO vencido) e o provedor repõe tudo. A exclusão precisa ser um
-- ESTADO, não um evento.
--
-- `EXCLUIDO` entra no enum de propósito: a fila seleciona por
-- `statusEnriquecimento IN (...)`, e um valor que não está nessa lista fica de
-- fora automaticamente. Falha FECHADA — quem escrever uma consulta nova amanhã
-- precisa incluir `EXCLUIDO` explicitamente para voltar a consultá-lo, em vez de
-- precisar lembrar de excluí-lo.
--
-- `exclusaoEm` e `exclusaoMotivo` guardam a prova de que o pedido foi atendido,
-- e quando. É isso que se mostra à ANPD.

BEGIN;

ALTER TYPE "StatusEnriquecimento" ADD VALUE IF NOT EXISTS 'EXCLUIDO';

COMMIT;

-- Em bloco separado: no PostgreSQL um valor novo de enum não pode ser USADO na
-- mesma transação que o criou.
BEGIN;

ALTER TABLE "pessoas"
  ADD COLUMN IF NOT EXISTS "exclusaoEm" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "exclusaoMotivo" TEXT;

COMMENT ON COLUMN "pessoas"."exclusaoEm" IS
  'Quando o titular pediu exclusão dos dados de contato (LGPD art. 18). Preenchido = nunca mais enriquecer.';

-- Índice parcial: as excluídas são poucas e o que se pergunta é "quem pediu
-- exclusão", nunca "quem não pediu". Índice cheio custaria escrita em 12 mil
-- linhas para responder uma consulta rara.
CREATE INDEX IF NOT EXISTS "pessoas_exclusaoEm_idx"
  ON "pessoas" ("exclusaoEm")
  WHERE "exclusaoEm" IS NOT NULL;

COMMIT;
