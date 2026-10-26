-- Quantos perfis de colaborador cabem num plano.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── POR QUE NO PLANO, E NÃO CONSTANTE NO CÓDIGO ──
--
-- "Até 5 perfis" é regra COMERCIAL, e regra comercial muda por decisão de venda,
-- não por deploy. No plano, criar um "Miner 500" com 10 assentos amanhã é inserir
-- uma linha; numa constante, é mexer em código, testar e publicar — e alguém
-- acabaria criando a exceção com um `if` do nome do cliente.
--
-- É o mesmo lugar onde `processosPorCiclo` já mora, pela mesma razão: as duas são
-- "o que este plano entrega".
--
-- ── DEFAULT 5, E NÃO NULO ──
--
-- Ao contrário do telefone da organização, aqui existe resposta certa para as
-- linhas que já existem: o plano comercial vendido é o de 5. Nulo obrigaria todo
-- ponto de leitura a decidir o que fazer com a ausência, e a decisão mais provável
-- seria "sem limite" — exatamente o oposto do pedido.
--
-- ── O QUE ESTA COLUNA NÃO FAZ ──
--
-- Ela não conta ninguém. A contagem viva é `SELECT count(*) FROM users WHERE
-- organizationId = ...`, feita no momento do convite. Guardar um contador aqui
-- criaria duas fontes para o mesmo número, e elas divergiriam no primeiro usuário
-- removido fora do fluxo normal.

BEGIN;

ALTER TABLE "planos"
  ADD COLUMN IF NOT EXISTS "usuariosPorPlano" INTEGER NOT NULL DEFAULT 5;

COMMENT ON COLUMN "planos"."usuariosPorPlano" IS
  'Quantos usuarios a organizacao assinante pode ter, contando o titular. Regra comercial: mora no plano para mudar sem deploy.';

COMMIT;
