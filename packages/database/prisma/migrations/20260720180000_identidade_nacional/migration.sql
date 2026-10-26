-- Identidade nacional: corrige a jurisdição e dá perfil de importação a todos
-- os tribunais.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. MG estava em DOIS tribunais.
--
-- A migration de identidade seeda TRF1 com 14 UFs incluindo MG, e TRF6 com MG.
-- O TRF6 foi instalado em 2022 exatamente para separar Minas Gerais do TRF1, e
-- a jurisdição não se sobrepõe: são 27 unidades federativas divididas entre as
-- seis regiões, e a soma das listas dava 28.
--
-- Não é detalhe cosmético: com a duplicata, "qual tribunal cobre MG?" tem duas
-- respostas, e um seletor de UF alimentado por esta tabela ofereceria Minas em
-- dois lugares — ou casaria com o tribunal errado.
UPDATE "tribunais"
   SET "ufsJurisdicao" = array_remove("ufsJurisdicao", 'MG'),
       "editadoEm"     = now()
 WHERE sigla = 'TRF1' AND 'MG' = ANY("ufsJurisdicao");

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Perfil de importação para todo tribunal que ainda não tem.
--
-- Sem isto, escolher qualquer tribunal que não o TRF5 na tela de importação
-- estoura "Nenhum perfil de importação ativo para {sigla}" — a abrangência
-- nacional existiria no catálogo e morreria no primeiro upload.
--
-- Os aliases são os GENÉRICOS: o do TRF5 continua com
-- "número do processo de precatório no trf5", que é o cabeçalho literal da
-- planilha dele, e não faria sentido nos outros. `situacao` entra desde já —
-- o perfil original nasceu sem ela e precisou de uma migration de correção.
INSERT INTO "perfis_importacao" ("id","tribunalId","nome","mapaColunas","colunasObrigatorias","ativo","criadoEm","editadoEm")
SELECT
  gen_random_uuid(), t.id, 'Dívida Consolidada',
  '{
     "cpf":["cpf","cpf do requerente","cpf/cnpj","documento","cpf requerente","cpf do requerente/exequente"],
     "nome":["nome","nome completo","requerente","nome do requerente","exequente","nome completo do requerente/exequente"],
     "processo":["processo","precatorio","precatório","numero do processo","nº do processo","processo precatorio","numero do precatorio","número do precatório"],
     "originario":["originario","originário","processo originario","numero do processo de execução/originário","número do processo de execução/originário"],
     "requisitorio":["requisitorio","requisitório","numero do requisitorio","número do requisitório"],
     "valor":["valor","valor individual","valor atualizado","valor atualizado individual"],
     "entidade":["entidade","entidade devedora","orgao","órgão"],
     "situacao":["situacao","situação","situacao do requisitorio","situação do requisitório","status"]
   }'::jsonb,
  ARRAY['cpf','processo']::TEXT[],
  true, now(), now()
FROM "tribunais" t
WHERE NOT EXISTS (
  SELECT 1 FROM "perfis_importacao" p WHERE p."tribunalId" = t.id
);

COMMIT;
