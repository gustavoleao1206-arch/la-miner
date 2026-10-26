-- Até quando o ciclo já está pago.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── O BURACO QUE ESTA COLUNA TAPA ──
--
-- O módulo de cobrança NUNCA leu `Plano.intervaloMeses` — a palavra não aparece
-- uma única vez lá dentro. `competenciaDe()` sempre trunca para o 1º do mês
-- corrente e o valor sai de `plano.preco` cru. A régua de cobrança é mensal por
-- construção.
--
-- Consequência, medida antes de escrever isto: um plano anual (12 meses, preço
-- do ano) geraria uma cobrança NOVA A CADA MÊS pelo valor anual inteiro. O
-- cliente que pagou um ano receberia doze cobranças de um ano. Só não aconteceu
-- ainda porque `COBRANCA_AGENDADA_ATIVA` está "false" no render.yaml — no dia em
-- que o cron ligar, quebra o mensal e o anual ao mesmo tempo.
--
-- ── POR QUE UMA COLUNA, E NÃO UMA CONTA NA HORA ──
--
-- Dava para derivar o período coberto somando `intervaloMeses` à competência da
-- última fatura paga. Não serve: o intervalo do PLANO pode mudar (é editável
-- pelo painel), e aí o período que o cliente comprou seria recalculado com a
-- régua nova, retroativamente. O que ele pagou é fato consumado e precisa ficar
-- gravado no instante do pagamento.
--
-- ── @db.Date, E NÃO timestamp ──
--
-- "Até quando está pago" é um DIA, não um instante — mesma razão de
-- `proximaRenovacaoEm`, a coluna vizinha. Com timestamp, o fuso do servidor
-- decidiria se o último dia do ciclo ainda conta.
--
-- ── NULO É ESTADO ──
--
-- Nulo = nunca houve pagamento, e a cobrança emite normalmente. Não confundir
-- com vencido: quem nunca pagou não tem período coberto para expirar. As
-- assinaturas que já existem nascem nulas de propósito — a próxima baixa carimba
-- a coluna, e até lá o comportamento é o de hoje.

BEGIN;

ALTER TABLE "assinaturas"
  ADD COLUMN IF NOT EXISTS "pagoAte" DATE;

COMMENT ON COLUMN "assinaturas"."pagoAte" IS
  'Fim EXCLUSIVO do periodo pago (competencia + intervaloMeses do plano). So sobre DINHEIRO: quem manda na entrega e proximaRenovacaoEm.';

COMMIT;
