-- ═══════════════════════════════════════════════════════════════════
--  C4 — segundo fator (TOTP)
--
--  Escrita à mão, como todas as outras deste repositório: `prisma migrate diff`
--  não enxerga os cinco índices trigram (criados por SQL puro) e os DERRUBA ao
--  gerar o arquivo. Ver a nota em MIGRATIONS.md.
--
--  Tudo aqui é ADITIVO e anulável: nenhuma linha existente precisa de valor, e
--  quem não cadastrar MFA continua entrando exatamente como antes.
-- ═══════════════════════════════════════════════════════════════════

-- Segredo TOTP CIFRADO (AES-256-GCM). A chave mora no ambiente, não no banco:
-- é o que faz um dump não entregar o segundo fator junto com o primeiro.
ALTER TABLE "users" ADD COLUMN "mfaSegredo" TEXT;

-- Quando o cadastro foi CONFIRMADO com um código válido. Segredo presente e
-- esta coluna nula = cadastro pela metade, que não vale como segundo fator.
ALTER TABLE "users" ADD COLUMN "mfaConfirmadoEm" TIMESTAMP(3);

-- Último contador TOTP aceito, para o mesmo código não servir duas vezes dentro
-- da janela de 90s. BIGINT porque o contador é o Unix time / 30 e estouraria
-- INT em 2038.
ALTER TABLE "users" ADD COLUMN "mfaUltimoContador" BIGINT;

-- Códigos de recuperação: a saída de quem perdeu o telefone. Guardados em
-- SHA-256 (uso único, 80 bits de entropia — não são senha humana).
CREATE TABLE "mfa_codigos_recuperacao" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codigoHash" TEXT NOT NULL,
    "usadoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_codigos_recuperacao_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mfa_codigos_recuperacao_codigoHash_key" ON "mfa_codigos_recuperacao"("codigoHash");
CREATE INDEX "mfa_codigos_recuperacao_userId_idx" ON "mfa_codigos_recuperacao"("userId");

-- CASCADE: apagar o usuário leva os códigos junto. Códigos órfãos não teriam
-- dono para conferir e ficariam de resíduo no banco.
ALTER TABLE "mfa_codigos_recuperacao"
  ADD CONSTRAINT "mfa_codigos_recuperacao_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
