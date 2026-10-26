-- Tipo de organização: INTERNA (Leão Amorim, dona da base) vs CLIENTE (assinante).
--
-- A primeira pedra do SaaS. Até aqui toda org era a operação interna; agora o
-- produto vende acesso a orgs CLIENTE, cada uma com sua carteira liberada. O
-- código ainda NÃO lê `tipo` nesta fase — a coluna nasce agora para o backfill
-- acontecer enquanto só existe a org interna, sem risco de marcar cliente algum
-- por engano.
--
-- Escrita à mão, como todas: `migrate dev` não roda (sem shadow database) e
-- `migrate diff` proporia derrubar os 5 índices trigram, que vêm de SQL bruto e
-- ele não conhece.

BEGIN;

CREATE TYPE "TipoOrganizacao" AS ENUM ('INTERNA', 'CLIENTE');

-- Default CLIENTE: daqui pra frente, org nova nasce de uma venda. A(s) que já
-- existe(m) são a operação interna e viram INTERNA no UPDATE abaixo.
ALTER TABLE "organizations"
  ADD COLUMN "tipo" "TipoOrganizacao" NOT NULL DEFAULT 'CLIENTE';

-- Toda org existente HOJE é a interna (não há clientes ainda). Marcar todas é
-- mais robusto que casar por CNPJ e correto porque a única linha é a Leão Amorim.
UPDATE "organizations" SET "tipo" = 'INTERNA';

COMMIT;
