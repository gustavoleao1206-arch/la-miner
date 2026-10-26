-- ═══════════════════════════════════════════════════════════════════
--  CRM — funil comercial e registro de contato
--
--  Escrita à mão, como todas as outras deste repositório: `prisma migrate diff`
--  não enxerga os cinco índices trigram (criados por SQL puro) e os DERRUBA ao
--  gerar o arquivo. Ver a nota em MIGRATIONS.md.
--
--  Tudo ADITIVO: coluna com default ou anulável, e uma tabela nova. Nenhuma
--  linha existente precisa de valor.
-- ═══════════════════════════════════════════════════════════════════

-- ── O FUNIL ─────────────────────────────────────────────────────────
--
-- O ciclo comercial de um precatório: o cliente recebe o processo, liga para o
-- titular, propõe a antecipação, fecha ou perde.
--
-- Até aqui isso vivia em ANOTAÇÃO DE TEXTO LIVRE e em etiquetas — o que nenhum
-- relatório consegue somar. "Quantos dos 250 deste mês viraram proposta?" não
-- tinha resposta possível.
--
-- PERDIDO e FECHADO são ambos terminais, e a distinção é a que mais importa
-- comercialmente: um encerra com receita, o outro encerra sem — e é a razão da
-- perda que diz o que corrigir no mês seguinte.
CREATE TYPE "EstagioCrm" AS ENUM ('NOVO', 'EM_CONTATO', 'PROPOSTA', 'FECHADO', 'PERDIDO');

-- No OVERLAY por organização, e não no processo: o funil é o processo comercial
-- DO CLIENTE. O mesmo precatório pode estar em estágios diferentes para dois
-- escritórios que o receberam — não há exclusividade.
ALTER TABLE "carteira_processo" ADD COLUMN "estagio" "EstagioCrm" NOT NULL DEFAULT 'NOVO';

-- Quando o estágio mudou pela última vez. É daqui que sai "parado há 12 dias" —
-- a pergunta que separa um funil vivo de uma lista de intenções.
ALTER TABLE "carteira_processo" ADD COLUMN "estagioEm" TIMESTAMP(3);

-- Por que se perdeu. Anulável e livre porque o motivo real varia mais do que
-- qualquer enum aguentaria ("titular faleceu", "já cedeu para outro", "achou
-- pouco") — e engessá-lo faria todo mundo escolher "Outro".
ALTER TABLE "carteira_processo" ADD COLUMN "motivoPerda" TEXT;

-- Último contato registrado. DENORMALIZADO de propósito: a fila de trabalho
-- precisa filtrar "ainda sem contato" e ordenar por "quem está mais tempo sem
-- ser tocado" sobre milhares de linhas. Escrito na MESMA transação do contato,
-- então não tem como divergir sem que a gravação inteira falhe.
ALTER TABLE "carteira_processo" ADD COLUMN "ultimoContatoEm" TIMESTAMP(3);

-- A fila de trabalho varre por (org, estágio, prioridade) e por "sem contato".
CREATE INDEX "carteira_processo_organizationId_estagio_prioridade_idx"
  ON "carteira_processo"("organizationId", "estagio", "prioridade");
CREATE INDEX "carteira_processo_organizationId_ultimoContatoEm_idx"
  ON "carteira_processo"("organizationId", "ultimoContatoEm");

-- ── O REGISTRO DE CONTATO ───────────────────────────────────────────
--
-- Uma TENTATIVA de contato, com canal e resultado. Estruturado, e não texto
-- livre, porque a pergunta que ele existe para responder é de contagem: quantas
-- ligações até uma proposta, quantos números errados, quem não foi tocado.
--
-- ⚠ NÃO tem `pessoaId`, e isso é deliberado. O vínculo é com o PROCESSO, como
-- em `anotacoes_processo`. Ligar o contato ao titular criaria um ponto novo de
-- dado pessoal, e a fronteira da exclusão do titular (B9) foi desenhada e
-- documentada sem ele — quem é o titular já se responde pelas partes do
-- processo.
CREATE TYPE "CanalContato" AS ENUM ('TELEFONE', 'WHATSAPP', 'EMAIL', 'PRESENCIAL', 'OUTRO');
CREATE TYPE "ResultadoContato" AS ENUM (
  'ATENDEU',
  'NAO_ATENDEU',
  'NUMERO_ERRADO',
  'RECADO',
  'RECUSOU'
);

CREATE TABLE "contatos_processo" (
    "id" UUID NOT NULL,
    "processoId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "autorId" UUID NOT NULL,
    "canal" "CanalContato" NOT NULL DEFAULT 'TELEFONE',
    "resultado" "ResultadoContato" NOT NULL,
    "observacao" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contatos_processo_pkey" PRIMARY KEY ("id")
);

-- A timeline de contatos de um processo, do mais recente para o mais antigo.
CREATE INDEX "contatos_processo_processoId_criadoEm_idx"
  ON "contatos_processo"("processoId", "criadoEm" DESC);
-- "quantas tentativas a equipe fez neste mês", por organização.
CREATE INDEX "contatos_processo_organizationId_criadoEm_idx"
  ON "contatos_processo"("organizationId", "criadoEm" DESC);
CREATE INDEX "contatos_processo_autorId_idx" ON "contatos_processo"("autorId");

ALTER TABLE "contatos_processo"
  ADD CONSTRAINT "contatos_processo_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contatos_processo"
  ADD CONSTRAINT "contatos_processo_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- RESTRICT como em `anotacoes_processo`: o contato é registro de trabalho, e
-- sumir com o autor apagaria de quem foi a tentativa.
ALTER TABLE "contatos_processo"
  ADD CONSTRAINT "contatos_processo_autorId_fkey"
  FOREIGN KEY ("autorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
