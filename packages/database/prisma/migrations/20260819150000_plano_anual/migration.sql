-- O catálogo comercial: um plano mensal, um anual, e nada de duplicata.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
-- Catálogo por migration é o padrão da casa (tribunais e perfis_importacao já
-- nascem assim) — versionado, chega a produção pelo preDeployCommand, e o teste
-- preserva junto com o resto do catálogo.
--
-- ── A CONTA DO ANUAL, por escrito ──
--
-- Mensal: R$ 799,00 × 12 = R$ 9.588,00.
-- Anual:  R$ 7.670,00  →  desconto de 20,004%.
-- O dono pediu "20% de desconto"; R$ 7.670,00 é o MAIOR preço que ainda cumpre
-- a promessa (7.670,40 seria exato; arredondou-se 40 centavos PARA BAIXO).
-- Anunciar 20% cobrando mais que isso numa página pública é propaganda
-- enganosa — a margem de erro fica do lado do cliente, sempre.
--
-- ── ativo = FALSE, de propósito ──
--
-- A landing de hoje mostra UM plano (o mais barato, `planos[0]` ordenado por
-- preço) e o botão principal crava "/mês" no texto. Com o anual ATIVO agora, a
-- vitrine anunciaria "Assinar por R$ 7.670/mês" — mentira na peça de conversão.
-- O plano nasce invisível e é LIGADO na fase da landing, quando a tela souber
-- mostrar os dois. Ligar é um UPDATE de uma linha, sem deploy.
--
-- ── Os dois duplicados saem de cena ──
--
-- "Essencial 250" e "Mensal 250" (ambos R$ 1.990) eram resquício de fases de
-- teste e disputavam a vitrine com o "Miner 250" real. Desativados, não
-- apagados: podem ter assinatura apontando para eles, e plano é catálogo com
-- história — some da venda, fica no banco.

BEGIN;

UPDATE "planos"
   SET "ativo" = false, "editadoEm" = now()
 WHERE "nome" IN ('Essencial 250', 'Mensal 250');

INSERT INTO "planos"
  ("id", "nome", "descricao", "processosPorCiclo", "preco", "intervaloMeses", "usuariosPorPlano", "ativo", "criadoEm", "editadoEm")
VALUES
  (gen_random_uuid(),
   'Miner 250 Anual',
   '250 processos novos todo mês, 1 ano garantido — 20% de desconto sobre o mensal',
   250,
   7670.00,
   12,
   5,
   false,
   now(),
   now())
ON CONFLICT ("nome") DO UPDATE
   SET "preco" = EXCLUDED."preco",
       "intervaloMeses" = EXCLUDED."intervaloMeses",
       "processosPorCiclo" = EXCLUDED."processosPorCiclo",
       "descricao" = EXCLUDED."descricao",
       "editadoEm" = now();

COMMIT;
