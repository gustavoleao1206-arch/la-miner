-- ═══════════════════════════════════════════════════════════════════
--  PARCELAMENTO DA CESSÃO — o cronograma do que o ESCRITÓRIO paga ao titular.
--
--  Escrita à mão, como todas: ver docs/MIGRATIONS.md. Mas esta NÃO cria nenhum
--  objeto invisível ao Prisma — nada de índice parcial, nada de CHECK, nada de
--  trigger. É de propósito: a lista de famílias invisíveis continua com DUAS
--  (trigram e os parciais da negociação), e ninguém precisa aprender uma
--  terceira para entregar isto.
--
--  ADITIVA: uma tabela nova. Nenhuma coluna existente muda, e nenhuma linha
--  existente precisa de valor — a API e o site sobem separados na Render, e a
--  janela entre os dois deploys precisa continuar de pé.
--
--  ── O QUE ESTA TABELA NÃO TEM, E POR QUÊ ──
--
--  Leia isto ANTES de acrescentar uma coluna. Cada ausência é uma decisão, não
--  um esquecimento:
--
--  • valorPago (diferente do previsto), saldo, amortização, várias baixas por
--    parcela, estorno — uma parcela tem UMA baixa: pagou ou não pagou. No dia em
--    que "paguei 20 dos 50 mil" precisar existir no dado, o que se está
--    construindo é um RAZÃO DE PAGAMENTOS, com estorno, idempotência e modelo de
--    permissão próprio. É exatamente aqui que este CRM começaria a virar um ERP
--    financeiro pela metade — pior nas duas coisas.
--  • meio de pagamento, PIX, agência, conta, favorecido — nenhuma coluna. O
--    parcelamento puxa isso por gravidade (a primeira pessoa a dar baixa em seis
--    parcelas vai querer o PIX salvo), e a exclusão do titular não o alcançaria,
--    repetindo o erro que titular.service.ts existe para não repetir.
--  • comprovante, recibo, anexo — decisão de produto: nenhum arquivo é
--    armazenado neste sistema.
--  • status gravado — "vencida" é `vencimento < hoje` na leitura. Estado gravado
--    exigiria um cron para mantê-lo, e vencida aqui NÃO dispara nada: não
--    bloqueia cliente, não suspende assinatura, não cobra ninguém. O escritório
--    atrasar o pagamento ao titular DELE não é motivo para tirar o acesso dele.
--  • juros, multa, correção, desconto por antecipação — exigiria arbitrar uma
--    taxa, e ninguém neste sistema tem autoridade para isso. É o ponto exato em
--    que um cronograma vira produto financeiro.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE "parcelas_cessao" (
    "id" UUID NOT NULL,

    -- Pendura na PROPOSTA, e não no processo. `ux_proposta_aceita` já garante
    -- UMA aceita por (org, processo), então o pai identifica o contrato sem
    -- ambiguidade — e a unicidade dele entrega de graça "um cronograma por
    -- contrato". No processo daria o inverso: ele PODE ter uma ACEITA e uma
    -- ENVIADA nova ao lado (criar() só procura a anterior entre as VIVAS), e aí
    -- "estas parcelas são de qual?" não teria resposta no dado.
    "propostaId" UUID NOT NULL,

    -- DESNORMALIZADOS de propósito. Toda escrita deste repositório filtra por
    -- id + processoId + organizationId — o buraco fechado na Etapa 0. Como NÃO
    -- há exclusividade de processo, o escritório B enxerga o mesmo precatório:
    -- uma parcela alcançável só pelo UUID reabriria o buraco um nível abaixo.
    "processoId"     UUID NOT NULL,
    "organizationId" UUID NOT NULL,

    -- 0 é a ENTRADA; 1..N são as parcelas. Um ordinal só — uma coluna de entrada
    -- à parte daria DOIS caminhos de baixa, cada um com sua corrida e sua soma.
    "numero" INTEGER NOT NULL,
    "valor"  DECIMAL(15,2) NOT NULL,

    -- DATE, como `validaAte` e o vencimento da Fatura: vencimento é DIA. Como
    -- timestamp, a parcela venceria em horas diferentes conforme o fuso de quem
    -- abre a tela, e "atrasada" mudaria de resposta sem nada ter mudado.
    "vencimento" DATE NOT NULL,

    -- A BAIXA. Timestamp no instante — a mesma divisão da Fatura: DATE no
    -- vencimento, timestamp no pagamento.
    "pagoEm"    TIMESTAMP(3),
    "pagoPorId" UUID,

    "criadoEm"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parcelas_cessao_pkey" PRIMARY KEY ("id")
);

-- A CHAVE NATURAL — e o Prisma A ENXERGA (vira @@unique no schema), ao
-- contrário das duas travas de propostas_negociacao. É ela que faz "gerar o
-- cronograma duas vezes" virar violação de unicidade e sair como 409 legível,
-- em vez de catorze parcelas.
CREATE UNIQUE INDEX "parcelas_cessao_proposta_numero_key"
  ON "parcelas_cessao"("propostaId", "numero");

-- "o que este escritório tem para pagar, e quando" — já escopado à org.
CREATE INDEX "parcelas_cessao_org_vencimento_idx"
  ON "parcelas_cessao"("organizationId", "vencimento");

-- A varredura da exclusão do titular é por processoId.
CREATE INDEX "parcelas_cessao_processoId_idx" ON "parcelas_cessao"("processoId");
CREATE INDEX "parcelas_cessao_pagoPorId_idx"  ON "parcelas_cessao"("pagoPorId");

-- CASCADE, e NÃO o RESTRICT que o instinto pede quando é dinheiro. Propostas SÃO
-- apagadas em três lugares: rascunho abandonado ao criar a rodada seguinte,
-- descarte explícito, e a exclusão LGPD do titular. Com RESTRICT, "criei outro
-- rascunho" — o fluxo mais banal do sistema — viraria erro de chave estrangeira.
ALTER TABLE "parcelas_cessao" ADD CONSTRAINT "parcelas_cessao_propostaId_fkey"
  FOREIGN KEY ("propostaId") REFERENCES "propostas_negociacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "parcelas_cessao" ADD CONSTRAINT "parcelas_cessao_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "parcelas_cessao" ADD CONSTRAINT "parcelas_cessao_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, e não RESTRICT como o `autorId` da proposta: o FATO da baixa
-- (quando) sobrevive à saída do usuário; some só o "quem". Oferta é palavra dada
-- por alguém; baixa é lançamento sobre uma linha que já existe por outro motivo.
ALTER TABLE "parcelas_cessao" ADD CONSTRAINT "parcelas_cessao_pagoPorId_fkey"
  FOREIGN KEY ("pagoPorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
