-- O plano comercial que a landing publica.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── POR QUE O PREÇO NASCE NUMA MIGRATION, E NÃO NO SEED ──
--
-- O seed não roda em produção — a carteira de lá veio de migração de dados, não
-- dele. Um plano que só existe no seed seria um plano que a vitrine nunca
-- mostra: a página abriria com "Plano sob consulta" e ninguém saberia por quê.
-- Preço é configuração de negócio que precisa existir no ambiente onde se
-- vende, e migration é o único caminho que atravessa para lá sozinho.
--
-- Depois disto, quem manda no preço é o painel: alterar a linha é UPDATE, não
-- deploy. Esta migration cria; ela não é a fonte da verdade para sempre.
--
-- ── IDEMPOTENTE, E POR QUE IMPORTA AQUI ──
--
-- `WHERE NOT EXISTS` pelo nome: se esta migration for reaplicada (restauração
-- de backup, ambiente novo, banco de teste), ela não duplica o plano. Plano
-- duplicado não é um registro a mais — é a vitrine mostrando o mesmo produto
-- duas vezes e o cliente escolhendo um `id` que o outro ciclo não reconhece.
--
-- `nome` já é UNIQUE no schema, então um segundo INSERT falharia de qualquer
-- forma; a diferença é falhar em silêncio previsível em vez de derrubar a
-- migração inteira e, com ela, o deploy.

BEGIN;

INSERT INTO "planos" (
  "id", "nome", "descricao", "processosPorCiclo", "preco", "intervaloMeses",
  "ativo", "criadoEm", "editadoEm"
)
SELECT
  gen_random_uuid(),
  'Miner 250',
  '250 precatórios novos por mês, com o titular identificado e o contato conferido.',
  250,
  -- 799.00 literal, não 799: a coluna é DECIMAL(12,2) e o valor entra exato.
  -- Nenhum ponto flutuante participa em nenhum momento do caminho até a tela.
  799.00,
  1,
  true,
  now(),
  now()
WHERE NOT EXISTS (SELECT 1 FROM "planos" WHERE "nome" = 'Miner 250');

COMMIT;
