-- Acrescenta ao perfil o alias de CPF que a planilha REAL usa.
--
-- ⚠ Este é o conserto de um defeito que estava mascarado.
--
-- O cabeçalho da planilha de dívida consolidada é "CPF do requerente/exequente".
-- O perfil listava `cpf`, `cpf do requerente`, `cpf/cnpj`, `documento` e
-- `cpf requerente` — nenhum deles normaliza para `cpfdorequerenteexequente`.
-- Resultado: a importação pela API SEMPRE recusou essa planilha com
-- "não encontrei a(s) coluna(s) cpf", e ninguém percebeu porque a carteira foi
-- carregada pelo seed, que lia os rótulos literais e contornava o perfil.
--
-- Só apareceu quando o seed passou a usar o perfil e ignorou as 4.188 linhas.
-- É o argumento a favor de uma fonte de verdade só: enquanto havia duas
-- leituras da mesma planilha, a que estava quebrada não tinha como ser notada.
--
-- Repare que `nome` já tinha o par correto ("nome completo do requerente/
-- exequente"): o alias de CPF é que ficou para trás quando o perfil foi
-- extraído da constante do código.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.

BEGIN;

UPDATE "perfis_importacao"
   SET "mapaColunas" = jsonb_set(
         "mapaColunas"::jsonb,
         '{cpf}',
         ("mapaColunas"::jsonb -> 'cpf') || '["cpf do requerente/exequente","cpf do exequente","cpf/cnpj do requerente"]'::jsonb
       ),
       "editadoEm" = now()
 WHERE NOT (("mapaColunas"::jsonb -> 'cpf') @> '["cpf do requerente/exequente"]'::jsonb);

COMMIT;
