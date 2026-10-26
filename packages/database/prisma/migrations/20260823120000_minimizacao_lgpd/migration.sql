-- ═══════════════════════════════════════════════════════════════════
--  MINIMIZAÇÃO DE DADOS — LGPD art. 6º, III (necessidade)
--  23/08/2026
-- ═══════════════════════════════════════════════════════════════════
--
-- ⚠ ESCRITA À MÃO, e precisa continuar assim. `prisma migrate diff` propõe
-- derrubar os índices trigram da busca por nome, que são o coração da consulta.
--
-- Os três objetos abaixo saíram de uma investigação que varreu o repositório
-- inteiro atrás de quem lê cada um. Nenhum tinha leitor. Dez candidatos foram
-- examinados; SETE ficaram, porque estavam vivos — vários deles dentro das
-- próprias rotinas de LGPD (o relatório de acesso do titular e a rotina de
-- exclusão). Estes três são o que sobrou depois de um segundo time tentar
-- provar, sem sucesso, que estavam em uso.
--
-- Nenhuma tela muda. Nenhuma rota muda. Nenhum teste muda.

-- ── 1. O índice de busca reversa por telefone ──
--
-- Um índice existe para responder UMA pergunta rápido. A pergunta deste era
-- "de quem é este número?", sobre a base inteira, sem recorte de organização.
-- Nenhuma tela, rota ou relatório faz essa pergunta — quem digita número na
-- busca está procurando CPF. Era capacidade pronta para finalidade que o
-- produto não tem.
--
-- A deduplicação de telefone no enriquecimento NÃO depende dele: usa a
-- constraint única (pessoaId, ddd, numero), que continua de pé.
DROP INDEX IF EXISTS "telefones_numero_idx";

-- ── 2. A fila em banco que nunca foi ligada ──
--
-- A fila real sempre foi o BullMQ, no Redis. Esta tabela nasceu na migration
-- inicial e nenhuma linha de código de produção jamais a leu ou escreveu.
--
-- Medido em produção antes de apagar: count(*) = 0 e count(referencia) = 0.
-- Nenhum CPF chegou a passar por aqui. A checagem não era zelo: `referencia`
-- era INDEXADO e documentado como "cpf, importacaoId, etc.", e a rotina de
-- exclusão do titular não enumerava esta tabela. Se houvesse linha, apagar
-- deixaria de ser limpeza e passaria a ser destruição de evidência.
--
-- A ordem importa: a tabela usa o tipo, então o tipo só pode cair depois dela.
DROP TABLE IF EXISTS "jobs_sincronizacao";
DROP TYPE IF EXISTS "StatusJob";

-- ── 3. A coluna que previa um S3 que nunca existiu ──
--
-- Zero referências em código, teste, seed ou SQL cru: nenhuma linha jamais a
-- preencheu, em nenhum momento da vida do sistema. O risco não é o dado que
-- ela guarda (não guarda nenhum) — é uma coluna vazia de nome sugestivo
-- convidando alguém a começar a usá-la sem passar por análise.
ALTER TABLE "importacoes" DROP COLUMN IF EXISTS "storageKey";
