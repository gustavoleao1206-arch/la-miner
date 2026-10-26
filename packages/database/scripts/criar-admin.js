#!/usr/bin/env node
/**
 * O PRIMEIRO ADMINISTRADOR de um banco de produção recém-criado.
 *
 * ── POR QUE ISTO EXISTE, SE JÁ HÁ UM SEED ──
 *
 * O `prisma/seed.ts` não roda em produção, e não é questão de gosto: ele é
 * executado por `tsx` e importa a leitura de planilha, ambos devDependencies.
 * Numa instalação de produção esses pacotes não estão no disco. Além disso o
 * seed carrega a base inteira de precatórios — não é o que se quer no primeiro
 * minuto de vida do sistema.
 *
 * Como também NÃO existe rota pública de cadastro (e não deve existir: quem
 * entra no MINER entra por convite ou por venda), sem este script o banco novo
 * fica com zero linhas em `User` e a tela de login responde "e-mail ou senha
 * inválidos" para sempre. O sintoma parece de senha, de CORS ou de DNS, e a
 * causa está a três camadas de distância.
 *
 * ── DUAS ARMADILHAS QUE ESTE ARQUIVO EVITA DE PROPÓSITO ──
 *
 * 1. O import. `require('@prisma/client')` LANÇA neste repositório — o schema
 *    declara `output = "../generated/client"`, então o pacote público continua
 *    sendo o stub que pede `prisma generate`. Todo script daqui importa de
 *    `@miner/database`, que aponta para o client realmente gerado.
 *
 * 2. O `tipo` da organização. O default do schema é CLIENTE, porque toda org
 *    nova nasce de uma venda. Se a organização da operação nascer como CLIENTE,
 *    o administrador entra, o sistema funciona — e a carteira aparece VAZIA,
 *    porque o escopo por liberação vai filtrar tudo. É o pior tipo de defeito:
 *    nada falha, só some.
 *
 * ── A SENHA NÃO MORA AQUI ──
 *
 * Vem de `ADMIN_SENHA`, definida na hora, por quem executa. Nada de valor
 * padrão: uma senha padrão em script de produção é a que sobrevive por anos.
 *
 * Uso, no Shell do serviço:
 *   ADMIN_EMAIL=voce@exemplo.com.br ADMIN_SENHA='...' node packages/database/scripts/criar-admin.js
 */

const { PrismaClient, Papel, TipoOrganizacao } = require('@miner/database');
const { hash } = require('@node-rs/argon2');

/* Os MESMOS parâmetros do AuthService (OWASP 2024). Não é redundância a ser
   eliminada: se divergirem, o hash gravado aqui não é aceito no login, e o erro
   sai como "senha inválida" — verdadeiro e completamente enganoso. */
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

const ORG_NOME = process.env.ADMIN_ORG_NOME ?? 'Leão Amorim';
const ORG_CNPJ = process.env.ADMIN_ORG_CNPJ ?? '00000000000000';

async function main() {
  /* `toLowerCase().trim()` porque é assim que o login normaliza antes de
     procurar. Um e-mail gravado com maiúscula simplesmente não é encontrado, e
     de novo o sintoma seria "credenciais inválidas". */
  const email = (process.env.ADMIN_EMAIL ?? '').toLowerCase().trim();
  const senha = process.env.ADMIN_SENHA ?? '';

  if (!email || !senha) {
    throw new Error(
      'Defina ADMIN_EMAIL e ADMIN_SENHA no ambiente.\n' +
        "  ADMIN_EMAIL=voce@exemplo.com.br ADMIN_SENHA='...' node packages/database/scripts/criar-admin.js",
    );
  }
  /* Piso baixo de propósito: a política de senha de verdade é a da API. Isto
     aqui só barra o dedo escorregado — senha de três letras no primeiro
     administrador de um sistema com CPF de terceiros dentro. */
  if (senha.length < 12) {
    throw new Error('ADMIN_SENHA precisa de pelo menos 12 caracteres.');
  }

  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.upsert({
      where: { cnpj: ORG_CNPJ },
      /* INTERNA nos DOIS lados, como no seed: no `update` também, senão rodar o
         script uma segunda vez rebaixaria a operação a assinante dela mesma. */
      update: { nome: ORG_NOME, tipo: TipoOrganizacao.INTERNA },
      create: { nome: ORG_NOME, cnpj: ORG_CNPJ, tipo: TipoOrganizacao.INTERNA },
    });

    const jaExistia = await prisma.user.findUnique({ where: { email }, select: { id: true } });

    const admin = await prisma.user.upsert({
      where: { email },
      /* `update: {}` — write-once, igual ao seed. Rodar de novo NÃO reseta a
         senha de um administrador que já existe e já trocou as credenciais.
         Trocar senha é operação da aplicação, com a sessão de quem é dono dela;
         um script que sobrescreve senha é um script que apaga rastro. */
      update: {},
      create: {
        organizationId: org.id,
        email,
        nome: process.env.ADMIN_NOME ?? 'Administrador',
        papel: Papel.ADMIN,
        ativo: true,
        senhaHash: await hash(senha, ARGON2),
      },
    });

    console.log(`organização: ${org.nome} (${org.tipo})`);
    console.log(
      `admin: ${admin.email}${jaExistia ? ' — JÁ EXISTIA, senha preservada' : ' — criado agora'}`,
    );
    if (jaExistia) {
      console.log('Nada foi alterado no usuário. Para trocar a senha, use a aplicação.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  /* Sem stack: a mensagem já diz o que fazer, e stack de Prisma em terminal de
     produção costuma carregar pedaço de string de conexão. */
  console.error(e.message);
  process.exit(1);
});
