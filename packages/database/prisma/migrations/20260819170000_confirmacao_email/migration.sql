-- Confirmação de e-mail no cadastro público.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── O PROBLEMA QUE ISTO RESOLVE ──
--
-- O cadastro do site aceitava qualquer e-mail sem prova de posse. Quem digitava
-- o próprio e-mail ERRADO criava uma conta inalcançável, pagava, e virava um
-- chamado de suporte; quem digitava o e-mail DE OUTRA PESSOA criava uma conta
-- em nome dela. A confirmação obrigatória fecha os dois: sem clicar no link,
-- não há acesso e não há cobrança.
--
-- ── O TRIO DE COLUNAS, no molde do MFA ──
--
-- `emailConfirmadoEm` nulo = nunca confirmado. O token viaja no link e o banco
-- guarda só o SHA-256 (como o refresh token) — um dump do banco não confirma
-- conta nenhuma. O vencimento faz o link morrer E faz o cadastro abandonado
-- virar reciclável, que é o que impede um typo de trancar o CNPJ para sempre.
--
-- ── O BACKFILL É A LINHA MAIS IMPORTANTE ──
--
-- Todo usuário EXISTENTE é confirmado por antiguidade. Sem isto, ligar a
-- exigência trancaria do lado de fora quem já paga e usa — inclusive o admin
-- da operação. Deploy não tranca ninguém; a regra vale para quem chega.

BEGIN;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "emailConfirmadoEm" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "emailConfirmacaoTokenHash" TEXT,
  ADD COLUMN IF NOT EXISTS "emailConfirmacaoExpiraEm" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_emailConfirmacaoTokenHash_key"
  ON "users"("emailConfirmacaoTokenHash");

UPDATE "users" SET "emailConfirmadoEm" = now() WHERE "emailConfirmadoEm" IS NULL;

COMMIT;
