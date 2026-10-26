-- ═══════════════════════════════════════════════════════════════════
--  IMPORTAÇÃO MULTI-TRIBUNAL, E O VALOR QUE É PALPITE
--  04/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO. Além dos índices trigram que o `migrate diff` derruba, ele
-- também não sabe expressar o índice PARCIAL do fim deste arquivo.
--
-- Três mudanças, todas ADITIVAS — nenhuma linha existente muda de valor, e o
-- modo de importação de hoje continua idêntico.
--
-- ── 1. PERFIL SEM TRIBUNAL ──
--
-- Até aqui toda planilha vinha de UM tribunal, escolhido na tela antes de o
-- arquivo ser aberto. A de pré-precatórios traz 42 num arquivo só, com o
-- tribunal numa COLUNA. Um perfil preso a um tribunal não tem como ler isso.
--
-- `tribunalId` nulo passa a significar "o tribunal vem da linha". É a única
-- diferença entre os dois modos, e ela fica declarada no perfil.

ALTER TABLE "perfis_importacao" ALTER COLUMN "tribunalId" DROP NOT NULL;

-- A FK precisa deixar de cascatear a partir de um tribunal que pode não existir.
-- `ON DELETE CASCADE` continua correto para o perfil DE um tribunal: apagar o
-- tribunal apaga o perfil dele. Para o perfil multi-tribunal a coluna é nula e a
-- regra simplesmente não se aplica.
--
-- (A constraint é recriada porque o Postgres não permite alterar a nulidade da
--  coluna referenciada sem recriá-la; o nome é o mesmo que o Prisma espera.)
ALTER TABLE "perfis_importacao" DROP CONSTRAINT "perfis_importacao_tribunalId_fkey";
ALTER TABLE "perfis_importacao"
  ADD CONSTRAINT "perfis_importacao_tribunalId_fkey"
  FOREIGN KEY ("tribunalId") REFERENCES "tribunais"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- ⚠ O ÚNICO EXISTENTE NÃO ALCANÇA OS PERFIS SEM TRIBUNAL.
--
-- `perfis_importacao_tribunalId_nome_key` é `UNIQUE (tribunalId, nome)`, e no
-- Postgres índice único trata cada NULO como DISTINTO de todos os outros. Dois
-- perfis multi-tribunal com o mesmo nome não colidiriam — e a escolha entre eles
-- seria arbitrária, exatamente o que o `orderBy` explícito da seleção de perfil
-- existe para evitar.
--
-- O índice PARCIAL abaixo é a trava que falta. O Prisma não sabe declará-lo no
-- schema; por isso ele vive aqui, e por isso esta migration é à mão.
CREATE UNIQUE INDEX "perfis_importacao_nome_sem_tribunal_key"
  ON "perfis_importacao"("nome")
  WHERE "tribunalId" IS NULL;

-- ── 2. A CARGA GUARDA O PERFIL COM QUE FOI LIDA ──
--
-- O worker relê o destino da importação, e até agora descobria o perfil pelo
-- tribunal: dado o tribunal, o perfil ativo mais antigo. Isso quebra em dois
-- casos, e os dois chegaram juntos: carga multi-tribunal não tem tribunal para
-- consultar, e um tribunal com dois perfis ativos resolveria sempre para o mais
-- antigo — o operador não teria como pedir o outro.
--
-- Guardando o perfil, a requisição decide UMA vez e o worker obedece. De quebra,
-- a carga passa a dizer, meses depois, com que mapa de colunas ela foi lida.
--
-- `SetNull` como o tribunal: apagar um perfil não pode apagar o histórico.
ALTER TABLE "importacoes" ADD COLUMN "perfilId" UUID;
ALTER TABLE "importacoes"
  ADD CONSTRAINT "importacoes_perfilId_fkey"
  FOREIGN KEY ("perfilId") REFERENCES "perfis_importacao"("id")
  ON UPDATE CASCADE ON DELETE SET NULL;

-- ── 3. O VALOR QUE É PALPITE ──
--
-- A planilha de pré-precatórios documenta a propria procedência: "NENHUMA fonte
-- pública tem campo de valor. Todo número foi extraído do texto (…) é palpite —
-- pode ser honorário, custas ou valor da causa."
--
-- `valor` é somado no ranking por entidade devedora, no dashboard e na
-- calculadora de negociação. Misturar palpite com valor apurado ali contamina
-- agregado que o cliente usa para decidir, e depois não há como separar.
--
-- Coluna própria mantém o dado (ele ordena por magnitude, que é útil) e mantém a
-- dúvida junto dele.
ALTER TABLE "processos" ADD COLUMN "valorIndicativo" DECIMAL(15,2);
