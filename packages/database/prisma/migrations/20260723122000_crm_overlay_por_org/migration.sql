-- CRM ciente de tenant: overlay por (org, processo) e coluna de org nas tabelas
-- de CRM que hoje só conhecem o processo.
--
-- Por que agora: quando entrar o primeiro cliente, a anotação/tarefa dele NÃO
-- pode aparecer para outro cliente nem para o time interno. O isolamento é por
-- `organizationId` na linha. Backfill = a org de QUEM ESCREVEU (tudo interno hoje).
--
-- prioridade/responsável do time interno FICAM em `processos` nesta fase; só o
-- cliente usa o overlay `carteira_processo`. Mover coluna escalar de tabela viva
-- é risco que não paga agora — a unificação, se valer, vem depois.
--
-- Aditiva e escrita à mão (trigram). Depende da migration `tipo_organizacao`
-- (usa organizations.tipo = 'INTERNA' no backfill dos eventos).

BEGIN;

-- ── Overlay de prioridade/responsável por org (só clientes gravam nesta fase) ──
CREATE TABLE "carteira_processo" (
  "organizationId" UUID NOT NULL,
  "processoId"     UUID NOT NULL,
  "prioridade"     "PrioridadeProcesso" NOT NULL DEFAULT 'NORMAL',
  "responsavelId"  UUID,
  "criadoEm"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "carteira_processo_pkey" PRIMARY KEY ("organizationId", "processoId")
);
CREATE INDEX "carteira_processo_organizationId_responsavelId_prioridade_idx"
  ON "carteira_processo"("organizationId", "responsavelId", "prioridade");
CREATE INDEX "carteira_processo_processoId_idx" ON "carteira_processo"("processoId");

ALTER TABLE "carteira_processo"
  ADD CONSTRAINT "carteira_processo_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE "carteira_processo"
  ADD CONSTRAINT "carteira_processo_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;
-- SET NULL: desligar um usuário devolve o processo a "sem responsável", não apaga
-- a linha do overlay do cliente.
ALTER TABLE "carteira_processo"
  ADD CONSTRAINT "carteira_processo_responsavelId_fkey"
  FOREIGN KEY ("responsavelId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- ── organizationId nas anotações (NOT NULL, backfill pela org do autor) ──
ALTER TABLE "anotacoes_processo" ADD COLUMN "organizationId" UUID;
UPDATE "anotacoes_processo" a
  SET "organizationId" = u."organizationId"
  FROM "users" u WHERE u."id" = a."autorId";
ALTER TABLE "anotacoes_processo" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "anotacoes_processo"
  ADD CONSTRAINT "anotacoes_processo_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX "anotacoes_processo_organizationId_idx" ON "anotacoes_processo"("organizationId");

-- ── organizationId nas tarefas (NOT NULL, backfill pela org de quem criou) ──
ALTER TABLE "tarefas_processo" ADD COLUMN "organizationId" UUID;
UPDATE "tarefas_processo" t
  SET "organizationId" = u."organizationId"
  FROM "users" u WHERE u."id" = t."criadoPorId";
ALTER TABLE "tarefas_processo" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "tarefas_processo"
  ADD CONSTRAINT "tarefas_processo_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX "tarefas_processo_organizationId_concluidaEm_prazo_idx"
  ON "tarefas_processo"("organizationId", "concluidaEm", "prazo");

-- ── organizationId nos eventos (NULLABLE: NULL = fato compartilhado) ──
-- Os eventos operacionais do time interno (mudança de prioridade/responsável,
-- observação, acesso) viram PRIVADOS da org interna; os fatos do processo
-- (IMPORTADO/DADO_ATUALIZADO/ENRIQUECIDO) ficam NULL = visíveis a quem liberou.
ALTER TABLE "eventos_processo" ADD COLUMN "organizationId" UUID;
UPDATE "eventos_processo"
  SET "organizationId" = (
    SELECT "id" FROM "organizations" WHERE "tipo" = 'INTERNA' ORDER BY "criadoEm" ASC LIMIT 1
  )
  WHERE "tipo" IN ('STATUS_ALTERADO', 'OBSERVACAO', 'ACESSO_CLIENTE');
ALTER TABLE "eventos_processo"
  ADD CONSTRAINT "eventos_processo_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON UPDATE CASCADE ON DELETE CASCADE;
CREATE INDEX "eventos_processo_organizationId_idx" ON "eventos_processo"("organizationId");

COMMIT;
