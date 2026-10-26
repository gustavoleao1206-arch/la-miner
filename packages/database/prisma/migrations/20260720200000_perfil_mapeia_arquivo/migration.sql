-- Acrescenta a coluna do NOME DO ARQUIVO ao mapa dos perfis.
--
-- A planilha de dívida consolidada traz uma coluna com o nome do PDF de origem
-- ("TRF5_Divida_Consolidada_2027_INSS_-_..._-_ALIMENTAR.pdf"), e é dela que se
-- extraem a entidade devedora e a natureza. O seed lia essa coluna por rótulo
-- literal; para ele passar a usar o perfil como a API, o perfil precisa
-- descrevê-la.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- Idempotente: só mexe em quem ainda não tem a chave. Não é obrigatória —
-- planilha sem essa coluna simplesmente não preenche entidade por este caminho.

BEGIN;

UPDATE "perfis_importacao"
   SET "mapaColunas" = jsonb_set(
         "mapaColunas"::jsonb,
         '{arquivo}',
         '["nome do arquivo pdf","arquivo pdf","nome do arquivo","arquivo"]'::jsonb,
         true
       ),
       "editadoEm" = now()
 WHERE NOT ("mapaColunas"::jsonb ? 'arquivo');

COMMIT;
