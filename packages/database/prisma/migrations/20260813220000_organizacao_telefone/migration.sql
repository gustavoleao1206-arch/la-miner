-- Telefone da organização cliente.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── POR QUE NA ORGANIZAÇÃO, E NÃO NO USUÁRIO ──
--
-- É o telefone da EMPRESA que assina, não da pessoa que preencheu o formulário.
-- Quem cadastrou pode sair do escritório amanhã; a assinatura continua. E é este
-- número que vai para o Asaas junto do CNPJ, no cadastro do cliente — lá também
-- ele pertence ao sacado, não ao operador.
--
-- ── NULO, E POR QUE ISSO NÃO É DESLEIXO ──
--
-- A coluna nasce opcional porque as organizações que JÁ existem não têm telefone
-- e não há de onde tirar: a interna foi criada por script, e as oito de teste
-- também. `NOT NULL` exigiria um default inventado — e telefone inventado numa
-- coluna de contato é pior que telefone ausente, porque parece dado.
--
-- Quem exige o preenchimento é o CADASTRO PÚBLICO, no DTO, onde a informação
-- realmente existe. A obrigatoriedade mora onde há quem responda por ela.

BEGIN;

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "telefone" TEXT;

COMMIT;
