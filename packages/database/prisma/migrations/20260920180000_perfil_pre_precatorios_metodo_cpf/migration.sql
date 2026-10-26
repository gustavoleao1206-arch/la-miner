-- O perfil multi-tribunal passa a LER a coluna "Como o CPF foi obtido".
--
-- Por que: medido em 20/09/2026, o método "rotulado CPF, credor unico" do radar
-- acerta 21% das vezes, contra ~90% do resto. A importação passou a ignorar
-- essas linhas (ver apps/api/src/modules/importacao/metodo-do-cpf.ts), e para
-- isso o perfil precisa saber onde a coluna está. A regra mora no código; aqui
-- só entra o alias, como qualquer outro campo do mapa.
--
-- `||` em jsonb acrescenta a chave sem tocar nas outras, e reaplicar é inócuo:
-- a mesma chave é sobrescrita com o mesmo valor. Só alcança o perfil sem
-- tribunal com este nome — os perfis dos TRFs não têm a coluna e não mudam.
UPDATE "perfis_importacao"
SET "mapaColunas" = "mapaColunas"::jsonb
      || '{"metodoCpf":["como o cpf foi obtido","metodo do cpf","método do cpf"]}'::jsonb,
    "editadoEm" = now()
WHERE "tribunalId" IS NULL
  AND "nome" = 'Pré-precatórios (multi-tribunal)';
