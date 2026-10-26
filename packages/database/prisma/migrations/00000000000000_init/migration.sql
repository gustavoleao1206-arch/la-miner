-- CreateEnum
CREATE TYPE "Papel" AS ENUM ('ADMIN', 'OPERADOR', 'CLIENTE');

-- CreateEnum
CREATE TYPE "StatusEnriquecimento" AS ENUM ('PENDENTE', 'SINCRONIZADO', 'SEM_DADOS', 'ERRO');

-- CreateEnum
CREATE TYPE "TipoTelefone" AS ENUM ('MOVEL', 'FIXO', 'DESCONHECIDO');

-- CreateEnum
CREATE TYPE "PapelProcessual" AS ENUM ('REQUERENTE', 'EXEQUENTE', 'CESSIONARIO', 'ESPOLIO', 'OUTRO');

-- CreateEnum
CREATE TYPE "StatusConsulta" AS ENUM ('SUCESSO', 'SEM_DADOS', 'ERRO');

-- CreateEnum
CREATE TYPE "StatusImportacao" AS ENUM ('RECEBIDA', 'PROCESSANDO', 'CONCLUIDA', 'CONCLUIDA_COM_ERROS', 'FALHOU');

-- CreateEnum
CREATE TYPE "StatusLinha" AS ENUM ('PENDENTE', 'OK', 'ERRO', 'IGNORADA');

-- CreateEnum
CREATE TYPE "StatusJob" AS ENUM ('AGUARDANDO', 'ATIVO', 'CONCLUIDO', 'FALHOU', 'CANCELADO');

-- CreateEnum
CREATE TYPE "TipoSolicitacaoTitular" AS ENUM ('ACESSO', 'CORRECAO', 'EXCLUSAO', 'OPOSICAO', 'PORTABILIDADE', 'REVISAO_AUTOMATIZADA');

-- CreateEnum
CREATE TYPE "StatusSolicitacaoTitular" AS ENUM ('RECEBIDA', 'EM_ANALISE', 'ATENDIDA', 'RECUSADA');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "papel" "Papel" NOT NULL DEFAULT 'CLIENTE',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "ultimoLoginEm" TIMESTAMP(3),
    "tentativasFalhas" INTEGER NOT NULL DEFAULT 0,
    "bloqueadoAte" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familiaId" UUID NOT NULL,
    "expiraEm" TIMESTAMP(3) NOT NULL,
    "revogadoEm" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pessoas" (
    "id" UUID NOT NULL,
    "cpf" VARCHAR(11) NOT NULL,
    "nome" TEXT NOT NULL,
    "nomeNormalizado" TEXT NOT NULL,
    "dataNascimento" TIMESTAMP(3),
    "nomeMae" TEXT,
    "situacaoCadastral" TEXT,
    "obito" BOOLEAN NOT NULL DEFAULT false,
    "statusEnriquecimento" "StatusEnriquecimento" NOT NULL DEFAULT 'PENDENTE',
    "ultimaSincronizacao" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pessoas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telefones" (
    "id" UUID NOT NULL,
    "pessoaId" UUID NOT NULL,
    "ddd" VARCHAR(3),
    "numero" VARCHAR(15) NOT NULL,
    "tipo" "TipoTelefone" NOT NULL DEFAULT 'DESCONHECIDO',
    "whatsapp" BOOLEAN,
    "score" INTEGER,
    "origem" TEXT NOT NULL DEFAULT 'CONTACTRA',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "primeiraVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimaVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telefones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "pessoaId" UUID NOT NULL,
    "endereco" TEXT NOT NULL,
    "score" INTEGER,
    "origem" TEXT NOT NULL DEFAULT 'CONTACTRA',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "primeiraVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimaVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enderecos" (
    "id" UUID NOT NULL,
    "pessoaId" UUID NOT NULL,
    "logradouro" TEXT,
    "numero" TEXT,
    "complemento" TEXT,
    "bairro" TEXT,
    "cidade" TEXT,
    "uf" VARCHAR(2),
    "cep" VARCHAR(8),
    "tipo" TEXT,
    "origem" TEXT NOT NULL DEFAULT 'CONTACTRA',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "primeiraVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimaVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enderecos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processos" (
    "id" UUID NOT NULL,
    "numeroPrecatorio" TEXT NOT NULL,
    "numeroOriginario" TEXT,
    "numeroRequisitorio" TEXT,
    "tribunal" TEXT NOT NULL DEFAULT 'TRF5',
    "vara" TEXT,
    "entidadeDevedora" TEXT,
    "natureza" TEXT,
    "situacao" TEXT,
    "valor" DECIMAL(15,2),
    "dataAutuacao" TIMESTAMP(3),
    "exercicio" INTEGER,
    "fonte" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processo_pessoas" (
    "processoId" UUID NOT NULL,
    "pessoaId" UUID NOT NULL,
    "papel" "PapelProcessual" NOT NULL DEFAULT 'REQUERENTE',
    "valorIndividual" DECIMAL(15,2),
    "observacoes" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processo_pessoas_pkey" PRIMARY KEY ("processoId","pessoaId")
);

-- CreateTable
CREATE TABLE "enriquecimentos" (
    "id" UUID NOT NULL,
    "pessoaId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'CONTACTRA',
    "versao" INTEGER NOT NULL,
    "status" "StatusConsulta" NOT NULL,
    "dadosBrutos" JSONB,
    "mensagemErro" TEXT,
    "custoCreditos" DECIMAL(10,4),
    "requestId" TEXT,
    "latenciaMs" INTEGER,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enriquecimentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "importacoes" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "arquivoNome" TEXT NOT NULL,
    "arquivoHash" TEXT NOT NULL,
    "arquivoTipo" TEXT NOT NULL,
    "storageKey" TEXT,
    "status" "StatusImportacao" NOT NULL DEFAULT 'RECEBIDA',
    "totalLinhas" INTEGER NOT NULL DEFAULT 0,
    "processadas" INTEGER NOT NULL DEFAULT 0,
    "sucesso" INTEGER NOT NULL DEFAULT 0,
    "falhas" INTEGER NOT NULL DEFAULT 0,
    "mensagemErro" TEXT,
    "iniciadoEm" TIMESTAMP(3),
    "concluidoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "importacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "importacao_linhas" (
    "id" UUID NOT NULL,
    "importacaoId" UUID NOT NULL,
    "numeroLinha" INTEGER NOT NULL,
    "dadosBrutos" JSONB NOT NULL,
    "cpf" VARCHAR(11),
    "numeroProcesso" TEXT,
    "status" "StatusLinha" NOT NULL DEFAULT 'PENDENTE',
    "mensagemErro" TEXT,
    "pessoaId" UUID,
    "processoId" UUID,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "importacao_linhas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs_sincronizacao" (
    "id" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "referencia" TEXT,
    "status" "StatusJob" NOT NULL DEFAULT 'AGUARDANDO',
    "tentativas" INTEGER NOT NULL DEFAULT 0,
    "maxTentativas" INTEGER NOT NULL DEFAULT 3,
    "ultimoErro" TEXT,
    "payload" JSONB,
    "agendadoPara" TIMESTAMP(3),
    "iniciadoEm" TIMESTAMP(3),
    "concluidoEm" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_sincronizacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_usage" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'CONTACTRA',
    "data" DATE NOT NULL,
    "chamadas" INTEGER NOT NULL DEFAULT 0,
    "sucesso" INTEGER NOT NULL DEFAULT 0,
    "semDados" INTEGER NOT NULL DEFAULT 0,
    "erros" INTEGER NOT NULL DEFAULT 0,
    "creditosGastos" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "latenciaMediaMs" INTEGER,
    "editadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "userId" UUID,
    "acao" TEXT NOT NULL,
    "entidade" TEXT,
    "entidadeId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "dadosAntes" JSONB,
    "dadosDepois" JSONB,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consultas_cliente" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tipo" TEXT NOT NULL,
    "termo" TEXT NOT NULL,
    "cpfConsultado" VARCHAR(11),
    "totalResultados" INTEGER NOT NULL DEFAULT 0,
    "contatoExibido" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "userAgent" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultas_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitacoes_titular" (
    "id" UUID NOT NULL,
    "protocolo" TEXT NOT NULL,
    "cpf" VARCHAR(11) NOT NULL,
    "nome" TEXT,
    "email" TEXT,
    "tipo" "TipoSolicitacaoTitular" NOT NULL,
    "status" "StatusSolicitacaoTitular" NOT NULL DEFAULT 'RECEBIDA',
    "descricao" TEXT,
    "resposta" TEXT,
    "prazoLimite" TIMESTAMP(3),
    "recebidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondidoEm" TIMESTAMP(3),

    CONSTRAINT "solicitacoes_titular_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_cnpj_key" ON "organizations"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organizationId_idx" ON "users"("organizationId");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familiaId_idx" ON "refresh_tokens"("familiaId");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiraEm_idx" ON "refresh_tokens"("expiraEm");

-- CreateIndex
CREATE UNIQUE INDEX "pessoas_cpf_key" ON "pessoas"("cpf");

-- CreateIndex
CREATE INDEX "pessoas_nomeNormalizado_idx" ON "pessoas"("nomeNormalizado");

-- CreateIndex
CREATE INDEX "pessoas_statusEnriquecimento_ultimaSincronizacao_idx" ON "pessoas"("statusEnriquecimento", "ultimaSincronizacao");

-- CreateIndex
CREATE INDEX "telefones_pessoaId_idx" ON "telefones"("pessoaId");

-- CreateIndex
CREATE INDEX "telefones_numero_idx" ON "telefones"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "telefones_pessoaId_ddd_numero_key" ON "telefones"("pessoaId", "ddd", "numero");

-- CreateIndex
CREATE INDEX "emails_pessoaId_idx" ON "emails"("pessoaId");

-- CreateIndex
CREATE UNIQUE INDEX "emails_pessoaId_endereco_key" ON "emails"("pessoaId", "endereco");

-- CreateIndex
CREATE INDEX "enderecos_pessoaId_idx" ON "enderecos"("pessoaId");

-- CreateIndex
CREATE INDEX "enderecos_uf_cidade_idx" ON "enderecos"("uf", "cidade");

-- CreateIndex
CREATE INDEX "enderecos_cep_idx" ON "enderecos"("cep");

-- CreateIndex
CREATE UNIQUE INDEX "processos_numeroPrecatorio_key" ON "processos"("numeroPrecatorio");

-- CreateIndex
CREATE INDEX "processos_numeroOriginario_idx" ON "processos"("numeroOriginario");

-- CreateIndex
CREATE INDEX "processos_numeroRequisitorio_idx" ON "processos"("numeroRequisitorio");

-- CreateIndex
CREATE INDEX "processos_entidadeDevedora_idx" ON "processos"("entidadeDevedora");

-- CreateIndex
CREATE INDEX "processos_exercicio_idx" ON "processos"("exercicio");

-- CreateIndex
CREATE INDEX "processo_pessoas_pessoaId_idx" ON "processo_pessoas"("pessoaId");

-- CreateIndex
CREATE INDEX "enriquecimentos_pessoaId_criadoEm_idx" ON "enriquecimentos"("pessoaId", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "enriquecimentos_status_criadoEm_idx" ON "enriquecimentos"("status", "criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "enriquecimentos_pessoaId_provider_versao_key" ON "enriquecimentos"("pessoaId", "provider", "versao");

-- CreateIndex
CREATE INDEX "importacoes_organizationId_criadoEm_idx" ON "importacoes"("organizationId", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "importacoes_status_idx" ON "importacoes"("status");

-- CreateIndex
CREATE INDEX "importacoes_arquivoHash_idx" ON "importacoes"("arquivoHash");

-- CreateIndex
CREATE INDEX "importacao_linhas_importacaoId_status_idx" ON "importacao_linhas"("importacaoId", "status");

-- CreateIndex
CREATE INDEX "importacao_linhas_cpf_idx" ON "importacao_linhas"("cpf");

-- CreateIndex
CREATE UNIQUE INDEX "importacao_linhas_importacaoId_numeroLinha_key" ON "importacao_linhas"("importacaoId", "numeroLinha");

-- CreateIndex
CREATE INDEX "jobs_sincronizacao_status_agendadoPara_idx" ON "jobs_sincronizacao"("status", "agendadoPara");

-- CreateIndex
CREATE INDEX "jobs_sincronizacao_tipo_status_idx" ON "jobs_sincronizacao"("tipo", "status");

-- CreateIndex
CREATE INDEX "jobs_sincronizacao_referencia_idx" ON "jobs_sincronizacao"("referencia");

-- CreateIndex
CREATE INDEX "api_usage_data_idx" ON "api_usage"("data" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "api_usage_provider_data_key" ON "api_usage"("provider", "data");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_criadoEm_idx" ON "audit_logs"("organizationId", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_userId_criadoEm_idx" ON "audit_logs"("userId", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_acao_criadoEm_idx" ON "audit_logs"("acao", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "consultas_cliente_userId_criadoEm_idx" ON "consultas_cliente"("userId", "criadoEm" DESC);

-- CreateIndex
CREATE INDEX "consultas_cliente_cpfConsultado_idx" ON "consultas_cliente"("cpfConsultado");

-- CreateIndex
CREATE INDEX "consultas_cliente_criadoEm_idx" ON "consultas_cliente"("criadoEm" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "solicitacoes_titular_protocolo_key" ON "solicitacoes_titular"("protocolo");

-- CreateIndex
CREATE INDEX "solicitacoes_titular_cpf_idx" ON "solicitacoes_titular"("cpf");

-- CreateIndex
CREATE INDEX "solicitacoes_titular_status_prazoLimite_idx" ON "solicitacoes_titular"("status", "prazoLimite");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telefones" ADD CONSTRAINT "telefones_pessoaId_fkey" FOREIGN KEY ("pessoaId") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_pessoaId_fkey" FOREIGN KEY ("pessoaId") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enderecos" ADD CONSTRAINT "enderecos_pessoaId_fkey" FOREIGN KEY ("pessoaId") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processo_pessoas" ADD CONSTRAINT "processo_pessoas_processoId_fkey" FOREIGN KEY ("processoId") REFERENCES "processos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processo_pessoas" ADD CONSTRAINT "processo_pessoas_pessoaId_fkey" FOREIGN KEY ("pessoaId") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enriquecimentos" ADD CONSTRAINT "enriquecimentos_pessoaId_fkey" FOREIGN KEY ("pessoaId") REFERENCES "pessoas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacoes" ADD CONSTRAINT "importacoes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "importacao_linhas" ADD CONSTRAINT "importacao_linhas_importacaoId_fkey" FOREIGN KEY ("importacaoId") REFERENCES "importacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consultas_cliente" ADD CONSTRAINT "consultas_cliente_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

