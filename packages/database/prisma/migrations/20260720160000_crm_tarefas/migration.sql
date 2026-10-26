-- Tarefas e follow-ups do processo.
--
-- Escrita à mão pelo motivo de sempre: `migrate dev` não roda (sem permissão de
-- shadow database) e `migrate diff` proporia derrubar os 5 índices trigram.
--
-- Uma tabela para os dois tipos: o ciclo de vida é idêntico (alguém, até uma
-- data, feito ou não) e só a intenção muda. Editável e removível como a
-- anotação, e pelo mesmo motivo — `titulo` é texto livre de escritório e pode
-- conter dado pessoal, que um log append-only não conseguiria apagar.

BEGIN;

CREATE TYPE "TipoTarefa" AS ENUM ('TAREFA', 'FOLLOW_UP');

CREATE TABLE "tarefas_processo" (
  "id"            UUID PRIMARY KEY,
  "processoId"    UUID NOT NULL,
  "tipo"          "TipoTarefa" NOT NULL DEFAULT 'TAREFA',
  "titulo"        TEXT NOT NULL,

  -- ⚠ DATE, não TIMESTAMP. Prazo é DIA: "até 25/07" não pode mudar de valor
  -- conforme o fuso de quem abre a tela. Guardar como timestamp reintroduziria
  -- o bug que fazia data de nascimento aparecer um dia antes em Brasília — e
  -- aqui o estrago seria pior, porque prazo exibido errado é prazo perdido.
  "prazo"         DATE,

  "responsavelId" UUID,
  "criadoPorId"   UUID NOT NULL,

  -- Instante da conclusão, não booleano: "quando" responde o que "se" não responde.
  "concluidaEm"   TIMESTAMP(3),

  "criadoEm"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editadoEm"     TIMESTAMP(3) NOT NULL
);

ALTER TABLE "tarefas_processo"
  ADD CONSTRAINT "tarefas_processo_processoId_fkey"
  FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON UPDATE CASCADE ON DELETE CASCADE;

-- SET NULL: desligar um usuário devolve as tarefas dele para "sem responsável",
-- em vez de apagá-las. O trabalho continua existindo depois que a pessoa sai.
ALTER TABLE "tarefas_processo"
  ADD CONSTRAINT "tarefas_processo_responsavelId_fkey"
  FOREIGN KEY ("responsavelId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- RESTRICT no criador, como na anotação: apagar um usuário não pode evaporar o
-- que o escritório combinou. Quem apagar decide antes o que fazer com as tarefas.
ALTER TABLE "tarefas_processo"
  ADD CONSTRAINT "tarefas_processo_criadoPorId_fkey"
  FOREIGN KEY ("criadoPorId") REFERENCES "users"("id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- A tela do processo: pendentes primeiro, na ordem do prazo.
CREATE INDEX "tarefas_processo_processoId_concluidaEm_prazo_idx"
  ON "tarefas_processo"("processoId", "concluidaEm", "prazo");

-- "O que eu tenho para hoje" — a consulta que abre o dia do operador e a que
-- mais escala num SaaS multi-tenant. `responsavelId` já é específico do tenant
-- (usuário pertence a uma organização), então este índice resolve sozinho, sem
-- precisar desnormalizar organizationId para esta tabela.
CREATE INDEX "tarefas_processo_responsavelId_concluidaEm_prazo_idx"
  ON "tarefas_processo"("responsavelId", "concluidaEm", "prazo");

COMMIT;
