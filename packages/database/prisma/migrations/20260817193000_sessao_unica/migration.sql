-- Uma sessão por usuário: a família de refresh aberta no último login.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- ── POR QUE UMA FAMÍLIA, E NÃO OUTRO CARIMBO DE TEMPO ──
--
-- Já existe `sessoesRevogadasEm`, e o instinto é reusá-la no login: gravar
-- `agora` e deixar a JwtStrategy recusar todo token anterior. Não funciona.
--
-- O `iat` do JWT tem resolução de SEGUNDOS; `sessoesRevogadasEm` é gravada com
-- MILISSEGUNDOS. Login às 10:00:03.417 emite um token com iat = 10:00:03.000, e
-- a comparação `iat < revogadasEm` recusa o token que o próprio login acabou de
-- emitir. O usuário entra e é expulso no mesmo gesto — e insistir só repete.
--
-- Comparar IDENTIDADE de família não tem borda: ou o token é da sessão atual ou
-- não é. Sem relógio, sem arredondamento, sem janela.
--
-- ── NULL É ESTADO, NÃO AUSÊNCIA ──
--
-- `null` significa NENHUMA sessão aberta — é o que logout, troca de senha e
-- "encerrar sessões" gravam. Como o access token só é recusado quando carrega
-- um `fam` que não bate, os tokens emitidos ANTES deste deploy (que não têm
-- `fam`) continuam valendo até expirar, e ninguém é derrubado pela publicação.
--
-- ── SEM ÍNDICE, DE PROPÓSITO ──
--
-- Esta coluna nunca aparece em WHERE. Ela é LIDA junto do usuário, na consulta
-- por chave primária que a JwtStrategy já faz a cada requisição, e ESCRITA por
-- id. Um índice aqui só custaria escrita.

BEGIN;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "familiaSessaoAtual" UUID;

COMMENT ON COLUMN "users"."familiaSessaoAtual" IS
  'Familia de refresh da unica sessao valida. NULL = nenhuma sessao aberta. O access token carrega a sua em `fam`.';

-- Ninguem e derrubado pela migration: quem esta logado agora tem token SEM
-- `fam`, e a checagem so morde quem tem. A coluna passa a valer no primeiro
-- login de cada um.

COMMIT;
