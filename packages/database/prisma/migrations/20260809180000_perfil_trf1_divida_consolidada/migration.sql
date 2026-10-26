-- Amplia o perfil de importação do TRF1 para o layout real das planilhas da
-- Dívida Consolidada.
--
-- Os cabeçalhos que o TRF1 publica não são os do TRF5, e nenhuma das DUAS
-- colunas obrigatórias casava: "Nº do Precatório (TRF1)" e "CPF/CNPJ do Credor".
-- A importação recusaria a planilha inteira — corretamente, mas por um motivo
-- que se resolve aqui, com dado de configuração, e não com código.
--
-- Ordem dos aliases IMPORTA: o leitor devolve o PRIMEIRO que existir na linha e
-- tiver conteúdo. Os novos entram na frente por serem mais específicos —
-- notadamente `valor`, onde a planilha traz "Valor CMO (R$)" e
-- "Valor TRF1 (R$)" lado a lado, com centavos diferentes. O do TRF1 é o do
-- tribunal que emitiu o precatório, e é ele que deve vencer.
--
-- `natureza` e `vara` são chaves NOVAS. O importador genérico ainda não as lê
-- (no TRF5 a natureza era deduzida do nome do arquivo PDF), mas aqui elas vêm em
-- coluna própria e o modelo Processo tem os dois campos — deixar de fora seria
-- descartar dado bom. O carregador do TRF1 as consome.
--
-- Aditiva: só mexe na linha do perfil do TRF1, e é idempotente.

BEGIN;

UPDATE "perfis_importacao" p
SET "mapaColunas" = jsonb_build_object(
  'cpf', jsonb_build_array(
    'cpf/cnpj do credor', 'cpf do credor',
    'cpf', 'cpf do requerente', 'cpf/cnpj', 'documento', 'cpf requerente',
    'cpf do requerente/exequente'
  ),
  'nome', jsonb_build_array(
    'credor',
    'nome', 'nome completo', 'requerente', 'nome do requerente', 'exequente',
    'nome completo do requerente/exequente'
  ),
  'processo', jsonb_build_array(
    'nº do precatório (trf1)', 'n do precatorio (trf1)', 'nº do precatório',
    'processo', 'precatorio', 'precatório', 'numero do processo', 'nº do processo',
    'processo precatorio', 'numero do precatorio', 'número do precatório'
  ),
  'valor', jsonb_build_array(
    'valor trf1 (r$)', 'valor trf1', 'valor cmo (r$)', 'valor cmo',
    'valor', 'valor individual', 'valor atualizado', 'valor atualizado individual'
  ),
  'entidade', jsonb_build_array(
    'devedor (na ficha do precatório)', 'devedor',
    'entidade', 'entidade devedora', 'orgao', 'órgão'
  ),
  'originario', jsonb_build_array(
    'processo originário', 'processo originario', 'originario', 'originário',
    'numero do processo de execução/originário',
    'número do processo de execução/originário'
  ),
  'requisitorio', jsonb_build_array(
    'requisitorio', 'requisitório', 'numero do requisitorio', 'número do requisitório'
  ),
  'situacao', jsonb_build_array(
    'situacao', 'situação', 'situacao do requisitorio', 'situação do requisitório', 'status'
  ),
  'arquivo', jsonb_build_array(
    'nome do arquivo pdf', 'arquivo pdf', 'nome do arquivo', 'arquivo'
  ),
  -- Chaves novas: vêm em coluna própria nas planilhas do TRF1.
  'natureza', jsonb_build_array('natureza'),
  'vara', jsonb_build_array('juízo de origem', 'juizo de origem', 'vara')
)
FROM "tribunais" t
WHERE t."id" = p."tribunalId"
  AND t."sigla" = 'TRF1'
  AND p."nome" = 'Dívida Consolidada';

COMMIT;
