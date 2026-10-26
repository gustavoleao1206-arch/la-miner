-- ═══════════════════════════════════════════════════════════════════
--  B5 — a importação sai da requisição e vai para a fila
--
--  Escrita à mão, como todas as outras deste repositório: `prisma migrate diff`
--  não enxerga os cinco índices trigram (criados por SQL puro) e os DERRUBA ao
--  gerar o arquivo. Ver a nota em MIGRATIONS.md.
--
--  Tudo aqui é ADITIVO: colunas anuláveis ou com default. Nenhuma linha
--  existente precisa de valor, e a API antiga continuaria funcionando sobre
--  este banco.
-- ═══════════════════════════════════════════════════════════════════

-- ── O DESTINO DA CARGA ──────────────────────────────────────────────
--
-- Até aqui o destino existia SÓ como argumento em memória do serviço: nem o
-- banco nem o histórico sabiam para qual tribunal uma importação passada tinha
-- ido. Enquanto o trabalho acontecia dentro da requisição isso passava; com o
-- processamento na fila, é o worker quem precisa saber — ele recebe apenas o
-- id da importação e reconstrói tudo daqui.
--
-- Anuláveis porque as importações já gravadas não têm como descobrir o próprio
-- destino retroativamente. Inventar um (o TRF5, que é o histórico) seria
-- gravar um palpite como se fosse fato.
ALTER TABLE "importacoes" ADD COLUMN "tribunalId" UUID;
ALTER TABLE "importacoes" ADD COLUMN "exercicio" INTEGER;

ALTER TABLE "importacoes"
  ADD CONSTRAINT "importacoes_tribunalId_fkey"
  FOREIGN KEY ("tribunalId") REFERENCES "tribunais"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ── O RESUMO DO RESULTADO ───────────────────────────────────────────
--
-- Estes números viviam apenas na RESPOSTA síncrona do POST. Com a resposta
-- passando a ser "recebi, id tal", eles morreriam junto — e com eles a frase
-- "nenhum processo mudou", que é como o operador reconhece de relance que
-- reimportar a planilha foi inofensivo. Sem ela, a alternativa é conferir
-- processo a processo, que é exatamente o trabalho que o diff existe para
-- poupar.
--
-- `eventos` NÃO entra: hoje ele é sempre criados + atualizados (um evento por
-- processo tocado), e coluna para valor derivado é convite a divergirem.
ALTER TABLE "importacoes" ADD COLUMN "ignoradas" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "importacoes" ADD COLUMN "processosCriados" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "importacoes" ADD COLUMN "processosAtualizados" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "importacoes" ADD COLUMN "processosInalterados" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "importacoes" ADD COLUMN "enfileirados" INTEGER NOT NULL DEFAULT 0;
