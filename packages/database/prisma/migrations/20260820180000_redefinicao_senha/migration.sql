-- Redefinição de senha: as duas colunas do token do link.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── SÓ O HASH, NUNCA O TOKEN ──
--
-- Mesmo desenho da confirmação de e-mail: o link carrega 32 bytes em claro e o
-- banco guarda apenas o SHA-256. Quem obtiver um dump não redefine a senha de
-- ninguém — teria que inverter o hash primeiro.
--
-- ── POR QUE COLUNAS PRÓPRIAS ──
--
-- Reaproveitar `emailConfirmacao*` misturaria dois links com poderes muito
-- diferentes: um ATIVA a conta, o outro TROCA A SENHA. E a validade de 48h que
-- faz sentido para a confirmação é longa demais para um reset, que é o mais
-- perigoso dos dois e vale por 1 hora.
--
-- O @unique é funcional, não decorativo: a redefinição encontra o usuário
-- BUSCANDO pelo hash, e sem a unicidade o índice não existiria.

ALTER TABLE "users"
  ADD COLUMN "senhaResetTokenHash" TEXT,
  ADD COLUMN "senhaResetExpiraEm"  TIMESTAMP(3);

CREATE UNIQUE INDEX "users_senhaResetTokenHash_key" ON "users"("senhaResetTokenHash");
