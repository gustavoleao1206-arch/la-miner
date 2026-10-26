-- Timeline do processo (EventoProcesso) — append-only.
--
-- Escrita à mão: `prisma migrate dev` não roda (o usuário do banco não pode criar
-- shadow database) e `prisma migrate diff` propõe derrubar os 5 índices trigram,
-- que vêm de SQL bruto e não existem no schema Prisma. Este arquivo contém
-- APENAS o pretendido.

-- Tudo ou nada. Sem isto, aplicado via `psql -f` (autocommit por statement), uma
-- falha no INSERT final deixaria tipo, tabela, FK e índices commitados — e a
-- reexecução abortaria em "type already exists", exigindo limpeza à mão.
BEGIN;

CREATE TYPE "TipoEventoProcesso" AS ENUM (
  'IMPORTADO',
  'DADO_ATUALIZADO',
  'ENRIQUECIDO',
  'STATUS_ALTERADO',
  'OBSERVACAO',
  'ACESSO_CLIENTE'
);

-- ⚠ LGPD: "camposAlterados" e "detalhe" carregam SÓ campos não pessoais do
-- processo (valor, situação, entidade devedora, natureza, vara, exercício, datas,
-- números). A tabela é append-only e um pedido de EXCLUSÃO do titular não teria
-- como apagá-la — nome, CPF, telefone, e-mail e endereço nunca podem entrar aqui.
-- A trava fica na aplicação (timeline-processo.ts), verificada em runtime.
CREATE TABLE "eventos_processo" (
  "id"              UUID PRIMARY KEY,
  "processoId"      UUID NOT NULL,
  "tipo"            "TipoEventoProcesso" NOT NULL,
  "descricao"       TEXT NOT NULL,
  "camposAlterados" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "detalhe"         JSONB,
  -- Sem FK de propósito: o log tem de sobreviver à remoção da Importacao ou do
  -- User que o originou. Um CASCADE aqui apagaria trilha de auditoria em silêncio.
  "importacaoId"    UUID,
  "userId"          UUID,
  "criadoEm"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Único CASCADE justificado: evento sem processo não significa nada.
ALTER TABLE "eventos_processo"
  ADD CONSTRAINT "eventos_processo_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- A leitura dominante é "a timeline deste processo, mais recente primeiro".
CREATE INDEX "eventos_processo_processoId_criadoEm_idx"
  ON "eventos_processo"("processoId", "criadoEm" DESC);
CREATE INDEX "eventos_processo_tipo_criadoEm_idx"
  ON "eventos_processo"("tipo", "criadoEm" DESC);
-- "o que esta importação mexeu" — a pergunta depois de reimportar uma planilha.
CREATE INDEX "eventos_processo_importacaoId_idx"
  ON "eventos_processo"("importacaoId");

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill do marco IMPORTADO para a carteira que já está no banco.
--
-- Sem isto, os 4.188 processos existentes ficariam com timeline vazia: o CRM
-- abriria cada processo real da carteira mostrando "nenhum evento", e o primeiro
-- evento só apareceria numa reimportação futura. O evento recebe o "criadoEm" do
-- próprio processo, não now(), para a linha do tempo não mentir a data.
--
-- Não altera processo, pessoa nem valor — só acrescenta o marco histórico.
-- Idempotente: rodar de novo não duplica (NOT EXISTS por processo).
--
-- Se o time preferir a timeline começando do zero, apagar SÓ este bloco.
INSERT INTO "eventos_processo" ("id","processoId","tipo","descricao","camposAlterados","criadoEm")
SELECT gen_random_uuid(), p."id", 'IMPORTADO',
       'Processo importado para a carteira', ARRAY[]::TEXT[], p."criadoEm"
  FROM "processos" p
 WHERE NOT EXISTS (SELECT 1 FROM "eventos_processo" e WHERE e."processoId" = p."id");

COMMIT;
