-- Snapshot diário dos indicadores da carteira, por lote.
--
-- Escrita à mão (como todas aqui): `prisma migrate diff` proporia derrubar os
-- 5 índices trigram, que vêm de SQL bruto e não existem no schema Prisma. Esta
-- é ADITIVA (só CREATE TABLE + índice novo), então não encosta em nada
-- existente.

BEGIN;

CREATE TABLE "snapshots_carteira" (
    "id"              UUID NOT NULL,
    "organizationId"  UUID NOT NULL,
    "tribunalId"      UUID NOT NULL,
    "exercicio"       INTEGER NOT NULL,
    "data"            DATE NOT NULL,
    "processos"       INTEGER NOT NULL,
    "pessoas"         INTEGER NOT NULL,
    "comAlgumContato" INTEGER NOT NULL,
    "valorTotal"      DECIMAL(18,2) NOT NULL,
    "valorAlcancavel" DECIMAL(18,2) NOT NULL,
    "criadoEm"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshots_carteira_pkey" PRIMARY KEY ("id")
);

-- Um snapshot por (organização, lote, dia). Também é o índice de leitura da
-- série: WHERE org+tribunal+exercicio ORDER BY data usa esta ordem de colunas.
CREATE UNIQUE INDEX "snapshots_carteira_organizationId_tribunalId_exercicio_data_key"
    ON "snapshots_carteira" ("organizationId", "tribunalId", "exercicio", "data");

COMMIT;
