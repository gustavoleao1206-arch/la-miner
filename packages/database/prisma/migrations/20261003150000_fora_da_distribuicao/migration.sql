-- ═══════════════════════════════════════════════════════════════════
--  FORA DA DISTRIBUIÇÃO: PROCESSO QUE FICA NA BASE MAS NÃO VAI AO SORTEIO
--  03/10/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas as deste repositório: `prisma migrate diff`
-- propõe derrubar os índices trigram da busca por nome.
--
-- ── POR QUE ──
--
-- Em 03/10/2026 os 7.711 processos dos radares de 16 a 30/09 foram relidos no
-- DJEN com a regra nova de devedor do radar (às cegas: filtro "é Fazenda?" de
-- 78% para 97%). 1.050 NÃO são crédito contra a Fazenda — banco, empresa,
-- reclamação trabalhista contra particular, ação de família. Entraram porque a
-- regra antiga achava o ente no cabeçalho do tribunal ("Poder Judiciário do
-- Estado de Minas Gerais"), na União intimada de passagem ou na Caixa como
-- banco da conta.
--
-- Decisão do dono (opção C do relatório de reavaliação): tirar do sorteio, SEM
-- apagar. Apagar não tem volta — `POST /titular/excluir` é por pessoa e
-- irreversível — e o processo pode ter sido entregue a alguém.
--
-- ── O CAMPO ──
--
-- `foraDaDistribuicao`: nulo = distribuível (o normal). Preenchido = o MOTIVO.
-- Enum e não booleano para que a próxima razão de segurar um processo entre
-- com nome próprio, em vez de reaproveitar uma marca que dizia outra coisa.
-- Lido por `PROCESSO_DISTRIBUIVEL` e pelo gêmeo em SQL cru de `sortear()`.
--
-- NÃO é retroativo, como as outras travas do sorteio: o que já foi liberado
-- continua com quem recebeu.
--
-- ── A MARCAÇÃO DOS 1.050 ──
--
-- Nesta versão do repositório a lista abaixo é de EXEMPLO: três números
-- fictícios no lugar dos 1.050 reais. O mecanismo é o mesmo.
--
-- Só número de processo e tribunal (dado público), sem valor e sem pessoa.
-- Recortada a pré-precatório (exercício nulo, uma das quatro fases anteriores
-- ao precatório expedido): a carteira dos TRFs não é tocada mesmo que um número
-- coincida. Parte da lista não existe no banco — linhas que a importação recusou
-- pelo método do CPF — e simplesmente não casa.
--
-- Cada processo marcado ganha um evento STATUS_ALTERADO PRIVADO da org dona
-- (organizationId preenchido): a razão é da operação interna, e o cliente que já
-- recebeu o processo não precisa ler "retirado da distribuição" na linha do tempo.
--
-- ── IDEMPOTENTE ──
--
-- O UPDATE só pega quem ainda está nulo, e o evento nasce do RETURNING dele.

CREATE TYPE "MotivoForaDaDistribuicao" AS ENUM ('DEVEDOR_NAO_E_FAZENDA');

ALTER TABLE "processos" ADD COLUMN "foraDaDistribuicao" "MotivoForaDaDistribuicao";

WITH lista (sigla, numero) AS (VALUES
  -- Números FICTÍCIOS (vara de origem 9999), só para manter o mecanismo.
  ('TJAL','0000101-74.2026.8.02.9999'),
  ('TJMG','0000202-08.2026.8.13.9999'),
  ('TRT15','0000303-40.2026.5.15.9999')
),
marcados AS (
  UPDATE "processos" p
     SET "foraDaDistribuicao" = 'DEVEDOR_NAO_E_FAZENDA', "editadoEm" = now()
    FROM lista l
    JOIN "tribunais" t ON t."sigla" = l.sigla
   WHERE p."tribunalId" = t."id"
     AND p."numeroPrecatorio" = l.numero
     AND p."exercicio" IS NULL
     AND p."fase" IN ('TRANSITO_EM_JULGADO', 'CALCULOS_HOMOLOGADOS', 'REQUISITORIO_EXPEDIDO', 'PRECATORIO_AUTUADO')
     AND p."foraDaDistribuicao" IS NULL
  RETURNING p."id", p."organizationId"
)
INSERT INTO "eventos_processo" ("id", "processoId", "tipo", "descricao", "camposAlterados", "organizationId", "criadoEm")
SELECT gen_random_uuid(), m."id", 'STATUS_ALTERADO',
       'Retirado da distribuição: o devedor não é a Fazenda Pública (reavaliação do radar de 03/10/2026)',
       ARRAY[]::TEXT[], m."organizationId", now()
  FROM marcados m;
