-- ═══════════════════════════════════════════════════════════════════
--  NEGOCIAÇÃO — a primeira vez que o sistema guarda DINHEIRO DO NEGÓCIO
--
--  Escrita à mão, como todas as outras: `prisma migrate diff` não enxerga os
--  cinco índices trigram nem os índices PARCIAIS criados aqui, e os derruba ao
--  gerar o arquivo. Ver docs/MIGRATIONS.md.
--
--  Tudo ADITIVO: uma tabela nova e cinco enums. Nenhuma linha existente precisa
--  de valor, e nenhuma coluna existente muda.
--
--  ── O QUE ESTA TABELA GUARDA, E O QUE NÃO ──
--
--  `Processo.valor` é o valor de FACE do precatório: o que o ente público deve
--  ao titular. Não é receita de ninguém. O que o escritório oferece, e o que
--  ganha, nunca existiu no banco — e é isso que entra aqui.
-- ═══════════════════════════════════════════════════════════════════

-- ── COMO SE NEGOCIA UM PRECATÓRIO ───────────────────────────────────
--
-- Dois caminhos, e eles são mutuamente exclusivos:
--   CESSÃO     — o escritório COMPRA o crédito com deságio. O combinado é uma
--                quantia ("eu te pago R$ 300 mil"), e o deságio é conta.
--   HONORÁRIOS — o escritório representa e fica com um percentual do que o
--                titular receber. O combinado é o percentual; a quantia só
--                existe quando o tribunal pagar.
CREATE TYPE "ModalidadeNegociacao" AS ENUM ('CESSAO', 'HONORARIOS');

-- Quem pôs o número na mesa. Sem isto, a CONTRAPROPOSTA do titular não existe
-- como dado — vira frase perdida numa observação que nenhum relatório soma.
CREATE TYPE "OrigemProposta" AS ENUM ('ESCRITORIO', 'TITULAR');

-- ── O CICLO DE UMA RODADA ───────────────────────────────────────────
--
-- RASCUNHO  — ainda não apresentada; é a única que pode ser editada.
-- ENVIADA   — apresentada ao titular. A partir daqui é IMUTÁVEL: "ajustar" cria
--             a rodada seguinte, e esta vira SUBSTITUIDA.
-- ACEITA / RECUSADA — decisão do titular.
-- SUBSTITUIDA — veio outra por cima.
-- CANCELADA   — o escritório retirou a oferta.
CREATE TYPE "StatusProposta" AS ENUM (
  'RASCUNHO', 'ENVIADA', 'ACEITA', 'RECUSADA', 'SUBSTITUIDA', 'CANCELADA'
);

CREATE TYPE "ParteQuePaga" AS ENUM ('ESCRITORIO', 'TITULAR');

-- ── DE ONDE SAIU A BASE DE CÁLCULO ──────────────────────────────────
--
-- Sai IMPRESSO na folha da proposta, e é o que impede alguém de negociar sobre
-- o número errado sem perceber. `Processo.valor` PARECE o total do precatório,
-- mas é alimentado pela MESMA célula que alimenta `ProcessoPessoa.valorIndividual`
-- (ver a nota em timeline-processo.ts). Num processo com mais de uma parte —
-- 230 na base de hoje — usá-lo erraria a base.
CREATE TYPE "OrigemDaBase" AS ENUM ('PARTE_UNICA', 'SOMA_DAS_PARTES', 'MANUAL');

CREATE TABLE "propostas_negociacao" (
    "id"             UUID NOT NULL,
    "processoId"     UUID NOT NULL,
    -- Tenant DONO da rodada: isola a oferta do escritório A da do B sobre o
    -- MESMO precatório liberado aos dois. Não há exclusividade de processos.
    "organizationId" UUID NOT NULL,
    "autorId"        UUID NOT NULL,

    "rodada"     INTEGER                NOT NULL,
    "origem"     "OrigemProposta"       NOT NULL DEFAULT 'ESCRITORIO',
    "modalidade" "ModalidadeNegociacao" NOT NULL,
    "status"     "StatusProposta"       NOT NULL DEFAULT 'RASCUNHO',

    -- RETRATO da base no dia da rodada, com a coluna que diz de onde ela veio.
    -- Sem o retrato, uma reimportação que corrigisse o valor reescreveria o
    -- deságio de uma proposta de março — e ninguém saberia que mudou.
    "baseValor"  DECIMAL(15,2),
    "baseOrigem" "OrigemDaBase",

    -- CESSÃO: grava-se a QUANTIA; o deságio sai da conta contra `baseValor`.
    -- Gravar o percentual em vez do valor faria uma correção de planilha mudar,
    -- em silêncio, quanto o sistema diz que oferecemos.
    "valorProposto"       DECIMAL(15,2),
    -- HONORÁRIOS: o inverso. O percentual é o fato; o valor seria projeção
    -- gravada como se fosse dinheiro.
    "honorarioPercentual" DECIMAL(5,2),

    "custasEstimadas"  DECIMAL(15,2),
    "custasPorContaDe" "ParteQuePaga" NOT NULL DEFAULT 'ESCRITORIO',

    -- DATE, e não timestamp, pela mesma razão do prazo das tarefas: validade é
    -- DIA. Como timestamp, a proposta venceria em horas diferentes conforme o
    -- fuso de quem abre a tela.
    "validaAte" DATE,

    -- ÚNICA superfície de texto livre desta tabela — e é por isso que ela é
    -- apagável de verdade na exclusão do titular, nunca um EventoProcesso.
    "observacao" TEXT,

    "enviadaEm"       TIMESTAMP(3),
    "respondidaEm"    TIMESTAMP(3),
    "respondidaPorId" UUID,
    -- Encerramento que NÃO é decisão do titular (substituída, cancelada). Sem
    -- esta coluna, essas duas transições ficariam sem "quando", porque
    -- `editadoEm` é sobrescrito por qualquer escrita posterior.
    "encerradaEm"     TIMESTAMP(3),

    "criadoEm"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "propostas_negociacao_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "propostas_negociacao_org_processo_rodada_key"
  ON "propostas_negociacao"("organizationId", "processoId", "rodada");

CREATE INDEX "propostas_negociacao_processo_org_criadoEm_idx"
  ON "propostas_negociacao"("processoId", "organizationId", "criadoEm" DESC);

CREATE INDEX "propostas_negociacao_org_status_respondidaEm_idx"
  ON "propostas_negociacao"("organizationId", "status", "respondidaEm");

CREATE INDEX "propostas_negociacao_autorId_idx" ON "propostas_negociacao"("autorId");

-- ── AS DUAS ÚNICAS INVARIANTES QUE VÃO PARA O BANCO ─────────────────
--
-- Índice PARCIAL é construção NOVA neste repositório, e entra só aqui porque a
-- APLICAÇÃO não consegue garanti-las sozinha sob concorrência: dois usuários do
-- mesmo escritório criando rodada ao mesmo tempo, e o que está em jogo é
-- dinheiro contado duas vezes.
--
-- ⚠ `prisma migrate diff` NÃO ENXERGA índice parcial, como não enxerga os
-- trigram. Perder um destes é perder a trava — por isso há teste de integração
-- que grava direto no banco esperando a violação. Ver docs/MIGRATIONS.md.
CREATE UNIQUE INDEX "ux_proposta_viva"
  ON "propostas_negociacao"("organizationId", "processoId")
  WHERE "status" IN ('RASCUNHO', 'ENVIADA');

CREATE UNIQUE INDEX "ux_proposta_aceita"
  ON "propostas_negociacao"("organizationId", "processoId")
  WHERE "status" = 'ACEITA';

ALTER TABLE "propostas_negociacao" ADD CONSTRAINT "propostas_negociacao_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "propostas_negociacao" ADD CONSTRAINT "propostas_negociacao_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT como em anotacoes_processo e contatos_processo: sumir com o usuário
-- apagaria de quem foi a oferta — e oferta é palavra dada por alguém.
ALTER TABLE "propostas_negociacao" ADD CONSTRAINT "propostas_negociacao_autorId_fkey"
  FOREIGN KEY ("autorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "propostas_negociacao" ADD CONSTRAINT "propostas_negociacao_respondidaPorId_fkey"
  FOREIGN KEY ("respondidaPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
