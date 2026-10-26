-- Acrescenta "situação do requisitório" ao mapa de colunas dos perfis.
--
-- Sem isto, a planilha traz a coluna, o Processo tem o campo e o diff sabe
-- compará-lo, mas a API nunca o preenchia: só o seed. Na prática, o campo que
-- mais muda ao longo da vida de um precatório era o único que a importação do
-- operador não conseguia atualizar — e a timeline do CRM ficaria sem o evento
-- que ela existe para mostrar.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
-- Só toca em perfis_importacao; nenhum processo, pessoa ou valor é alterado.

BEGIN;

UPDATE "perfis_importacao"
   SET "mapaColunas" = jsonb_set(
         "mapaColunas"::jsonb,
         '{situacao}',
         '["situacao","situação","situacao do requisitorio","situação do requisitório","status"]'::jsonb,
         true
       )
 WHERE NOT ("mapaColunas"::jsonb ? 'situacao');

COMMIT;
