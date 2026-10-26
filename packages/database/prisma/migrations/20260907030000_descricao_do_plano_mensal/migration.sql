-- ═══════════════════════════════════════════════════════════════════
--  A DESCRIÇÃO DO PLANO MENSAL DEIXA DE PROMETER "250 PRECATÓRIOS"
--  07/09/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, como todas: o `migrate diff` derruba os índices trigram da
-- busca por nome.
--
-- ── ONDE ESTE TEXTO APARECE ──
--
-- Não é metadado interno. `Plano.descricao` é renderizado em DOIS lugares que o
-- comprador lê antes e depois de pagar:
--
--   1. o CARTÃO DE PREÇO da landing, logo acima do botão Assinar;
--   2. a tela "Minha assinatura", dentro do painel do cliente pagante.
--
-- A correção de 07/09/2026 na landing (a2035ac) alcançou o herói, a FAQ, o
-- rodapé, os metadados, os Termos e a Privacidade — e não podia alcançar esta,
-- porque ela não está no código. Está aqui.
--
-- ── POR QUE A FRASE ERA FALSA ──
--
-- Desde 06/09/2026 o sorteio dos 250 entrega as CINCO fases
-- (`FASES_DISTRIBUIVEIS`), e 1.169 pré-precatórios entraram na base. Um lote de
-- 250 traz precatórios expedidos E créditos em estágio anterior, sem
-- exigibilidade formada. Prometer "250 precatórios" no lugar onde a promessa
-- vira contrato é o terreno do art. 37, §1º do CDC — e o comprador é advogado.
--
-- ── A PALAVRA JÁ ESTAVA ESCOLHIDA ──
--
-- O plano ANUAL, criado depois (20260819150000_plano_anual), já diz "250
-- processos novos todo mês". O mensal ficou para trás. Esta migration alinha os
-- dois, em vez de inventar um terceiro vocabulário: o banco tinha duas frases
-- descrevendo a mesma entrega, e uma delas afirmava a mais.
--
-- ── IDEMPOTENTE E ESTREITA ──
--
-- Casa pelo NOME e pelo texto antigo. Rodar duas vezes não faz nada na segunda,
-- e um plano que alguém já tenha editado à mão no painel não é sobrescrito —
-- o `WHERE` da descrição existe para isso.

UPDATE "planos"
   SET "descricao" = '250 processos novos por mês, com o titular identificado e o contato conferido.',
       "editadoEm" = now()
 WHERE "nome" = 'Miner 250'
   AND "descricao" = '250 precatórios novos por mês, com o titular identificado e o contato conferido.';
