-- Gestor da própria organização.
--
-- Eixo SEPARADO de `papel`, de propósito. `papel` decide quais superfícies da
-- PLATAFORMA o usuário alcança (é o que o @Papeis('ADMIN') dos controllers de
-- distribuição e cobrança consulta); `gestor` decide quem manda DENTRO da
-- própria empresa. Se "administrador do cliente" fosse papel = ADMIN, o gestor
-- de um escritório assinante enxergaria todos os clientes da plataforma.
--
-- Aditiva e escrita à mão (trigram).

BEGIN;

ALTER TABLE "users" ADD COLUMN "gestor" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: em cada org CLIENTE, o usuário MAIS ANTIGO vira gestor.
--
-- Sem isto, os clientes que já existem ficam sem ninguém capaz de convidar
-- colegas — e como só um gestor pode promover outro, a empresa nasceria trancada
-- para sempre, exigindo intervenção no banco. O mais antigo é o que foi criado
-- junto com a assinatura, ou seja, o dono do contrato.
UPDATE "users" u
SET "gestor" = true
WHERE u."id" IN (
  SELECT DISTINCT ON (x."organizationId") x."id"
  FROM "users" x
  JOIN "organizations" o ON o."id" = x."organizationId"
  WHERE o."tipo" = 'CLIENTE'
  ORDER BY x."organizationId", x."criadoEm" ASC, x."id" ASC
);

-- A org INTERNA NÃO recebe backfill: lá quem gerencia equipe é o papel ADMIN,
-- que já existe e já tem esse poder. Marcar `gestor` nela só criaria um segundo
-- caminho para a mesma autoridade.

COMMIT;
