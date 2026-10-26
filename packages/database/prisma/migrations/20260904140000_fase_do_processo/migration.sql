-- ═══════════════════════════════════════════════════════════════════
--  A FASE DO PROCESSO — e a trava que decide o que é distribuído
--  04/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO. O `prisma migrate diff` propõe derrubar os índices trigram
-- da busca por nome, e aqui ele também erraria o passo do backfill: geraria um
-- `ADD COLUMN ... NOT NULL` sem valor para as linhas existentes, que falha numa
-- tabela com 12.425 registros.
--
-- ── O QUE ESTA COLUNA RESOLVE ──
--
-- Até aqui a base era só de precatórios já expedidos e na fila orçamentária. Com
-- os pré-precatórios, a MESMA tabela passa a guardar oportunidades que ainda não
-- viraram precatório — e o sorteio mensal não tinha como distinguir um valor
-- exigível de um que talvez nunca venha a ser.
--
-- ── A ORDEM DOS PASSOS É O QUE TORNA ISTO SEGURO ──
--
-- A coluna precisa terminar NOT NULL e SEM default (ver a nota no schema: com
-- default, a fase vira palpite silencioso em todo `create` que a esquecer, e
-- como a fase decide o que é vendido, o palpite viraria venda).
--
-- Mas `ADD COLUMN NOT NULL` sem default falha se já houver linha. Então:
--   1. nasce com default, para as 12.425 linhas existentes serem preenchidas
--      pelo próprio Postgres, sem UPDATE e sem reescrever a tabela;
--   2. o default é REMOVIDO, e a partir daí quem inserir é obrigado a declarar;
--   3. NOT NULL entra por último, quando já não há nulo possível.
--
-- O valor do backfill é `PRECATORIO_EXPEDIDO` e não é escolha estética: é o que
-- a base inteira É. Ela veio das planilhas de dívida consolidada dos TRFs, que
-- só listam precatório já autuado e aguardando exercício orçamentário. Marcar
-- outra coisa mentiria sobre 12.425 processos de clientes pagantes.

CREATE TYPE "FaseProcesso" AS ENUM (
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
  'PRECATORIO_EXPEDIDO'
);

-- 1. Nasce com default: o Postgres preenche o que já existe sem varrer a tabela.
ALTER TABLE "processos"
  ADD COLUMN "fase" "FaseProcesso" NOT NULL DEFAULT 'PRECATORIO_EXPEDIDO';

-- 2. O default sai. Daqui em diante, INSERT sem fase é erro — que é o objetivo.
ALTER TABLE "processos" ALTER COLUMN "fase" DROP DEFAULT;

-- 3. (O NOT NULL já entrou no passo 1; fica explícito aqui o que se garantiu.)
--    Nenhuma linha pode ter fase nula, nem agora nem depois.

-- ── O ÍNDICE ──
--
-- O sorteio passa a filtrar por fase, e ele roda sobre a base inteira com
-- ORDER BY random(). O índice composto com `organizationId` serve à consulta do
-- jeito que ela é escrita: primeiro o recorte por organização interna, depois a
-- fase. Sozinho, um índice só de fase teria seletividade baixa demais para valer
-- (hoje 100% das linhas estão na mesma fase) e o planejador o ignoraria.
CREATE INDEX "processos_organizationId_fase_idx" ON "processos"("organizationId", "fase");
