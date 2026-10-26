-- Revogação de sessão que vale IMEDIATAMENTE.
--
-- ── O BURACO QUE ISTO FECHA ──
--
-- Revogar os refresh tokens não derruba o ACCESS token: ele é auto-contido e
-- vale até expirar. Com 15 minutos de validade, "encerrei as sessões" era uma
-- promessa que só se cumpria um quarto de hora depois — e o mesmo valia para
-- `trocarSenha`, que é justamente o que alguém faz ao suspeitar de invasão.
--
-- ── POR QUE UM MARCO NO USUÁRIO, E NÃO UMA LISTA NEGRA ──
--
-- Lista negra de tokens exigiria consultar uma tabela nova a cada requisição.
-- A JwtStrategy JÁ relê o usuário do banco em toda requisição (é assim que
-- desativar alguém tem efeito imediato). Guardando o marco NESSA linha, a
-- verificação sai da consulta que já existe: custo zero.
--
-- A regra passa a ser: token emitido ANTES do marco não vale mais. O `iat` do
-- JWT dá o instante da emissão, e a comparação é aritmética.
--
-- ⚠ `iat` tem resolução de SEGUNDOS. Um login no MESMO segundo da revogação é
-- recusado junto — o usuário loga de novo e resolve. É o lado seguro do erro:
-- a alternativa seria deixar passar o token que se quis derrubar.

BEGIN;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sessoesRevogadasEm" TIMESTAMP(3);

COMMENT ON COLUMN "users"."sessoesRevogadasEm" IS
  'Marco de revogação: access token com iat anterior a esta data é recusado. Fecha a janela de 15 min do JWT.';

COMMIT;
