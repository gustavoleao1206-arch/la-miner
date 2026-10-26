-- Liga o Miner 250 Anual na vitrine.
--
-- A migration 20260819150000_plano_anual criou o plano com `ativo = false` de
-- propósito: a landing daquele dia mostrava UM plano e não havia tela capaz de
-- exibir dois. Essa tela subiu no commit 4f50717 (dois cartões, selo de
-- desconto calculado, ?plano= levando o escolhido até o formulário). A condição
-- que segurava o plano deixou de existir, então ele entra em cena.
--
-- ── POR QUE MIGRATION, E NÃO UM UPDATE À MÃO ──
--
-- O comentário da 20260819150000 dizia "ligar é um UPDATE de uma linha, sem
-- deploy" — e é, tecnicamente. Mas um UPDATE cru em produção deixa o banco
-- divergente das migrations: qualquer ambiente reconstruído a partir delas (o
-- banco de teste, uma futura réplica, um staging) nasceria com o anual
-- desligado, e ninguém saberia por quê. Catálogo é o padrão da casa por
-- migration justamente por isso — tribunais e perfis_importacao já nascem
-- assim. O preço de esperar um deploy é pequeno perto de um catálogo que só
-- existe na memória de quem digitou o comando.
--
-- Idempotente: reaplicar não faz nada além de mexer no editadoEm. O WHERE não
-- casa com nome nenhum se o plano não existir — 0 linhas, sem erro.

BEGIN;

UPDATE "planos"
   SET "ativo" = true, "editadoEm" = now()
 WHERE "nome" = 'Miner 250 Anual';

COMMIT;
