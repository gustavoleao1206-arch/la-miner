#!/usr/bin/env node
/**
 * Provisiona os PERFIS DE CLIENTE para teste.
 *
 * ── O PROBLEMA QUE ISTO RESOLVE ──
 *
 * O sistema se comporta de formas diferentes conforme o estado da assinatura, e
 * nenhuma delas dava para exercitar sem mexer no banco à mão: SUSPENSA e
 * CANCELADA tomam 402 no guard, INADIMPLENTE ainda passa (é a carência),
 * PENDENTE passa mas nasce sem carteira. Conferir "se está tudo OK" olhando só
 * um cliente ativo é conferir o caminho feliz e chamar de auditoria.
 *
 * ── AS CARTEIRAS SAEM DO MOTOR DE VERDADE ──
 *
 * As liberações vêm do `DistribuicaoService.gerarLote` — o MESMO código que o
 * cron mensal executa —, e não de `INSERT` em `ProcessoLiberado`. Dado de teste
 * fabricado por outro caminho testa o caminho errado: produziria combinações que
 * o motor nunca produz (lote sem competência, liberação sem lote, carteira sem
 * processo-irmão) e esconderia justamente os defeitos que ele tem.
 *
 * Pelo mesmo motivo, quem termina INADIMPLENTE, SUSPENSA ou CANCELADA passa
 * ANTES por ATIVA e recebe seus lotes ali. É o ciclo de vida real — e é o que
 * torna verdadeira a promessa "dados preservados, acesso barrado".
 *
 * ── IDEMPOTENTE ──
 *
 * Rodar de novo não duplica nada: as orgs são casadas pelo CNPJ sintético, os
 * usuários pelo e-mail, e o motor de distribuição já é idempotente por
 * (assinatura, competência).
 *
 *   node apps/api/scripts/perfis-de-teste.js            # cria/atualiza
 *   node apps/api/scripts/perfis-de-teste.js --remover --sim
 *
 * A senha sai em `perfis-de-teste.local.md`, na raiz — fora do git. Defina
 * `PERFIS_SENHA` para escolher a sua.
 */
const { randomBytes } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { resolve } = require('node:path');

const RAIZ = resolve(__dirname, '../../..');
require('dotenv').config({ path: resolve(RAIZ, '.env') });

// ── Trava de ambiente ──────────────────────────────────────
//
// Mesma disciplina do `reset-seguro.js`. Aqui nada é apagado na criação, mas
// apontar para produção encheria o sistema real de escritórios fictícios com
// assinatura e carteira — visíveis para o dono, contáveis nos agregados, e
// removíveis só um a um.
const url = (process.env.DATABASE_URL ?? '').trim();
const recusar = (motivo) => {
  console.error(`\n  RECUSANDO.\n  ${motivo}\n`);
  process.exit(1);
};
if (!url) recusar('DATABASE_URL não definida.');
if (process.env.NODE_ENV === 'production') recusar('NODE_ENV=production.');

let host;
let banco;
try {
  const u = new URL(url);
  host = u.hostname;
  banco = u.pathname.replace(/^\//, '');
} catch {
  recusar('DATABASE_URL não é uma URL válida.');
}
if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host) && !banco.endsWith('_test')) {
  recusar(`O destino é "${banco}" em "${host}" — nem local, nem um banco de teste.`);
}

const REMOVER = process.argv.includes('--remover');
if (REMOVER && !process.argv.includes('--sim')) {
  recusar('Remover apaga as orgs de teste e tudo que pende delas. Repita com --sim.');
}

const { PrismaClient } = require(path.join(RAIZ, 'packages/database/generated/client'));
const { hash } = require(path.join(RAIZ, 'node_modules/@node-rs/argon2'));
const {
  DistribuicaoService,
} = require(path.join(RAIZ, 'apps/api/dist/modules/distribuicao/distribuicao.service.js'));

const prisma = new PrismaClient();
const distribuicao = new DistribuicaoService(prisma);

/** Marca que identifica tudo que este script criou. */
const MARCA = 'PERFIL-TESTE';
const DOMINIO = 'clienteteste.local';

// ── O plano ────────────────────────────────────────────────
//
// UM só, de 250 por mês. É decisão de produto: não há upgrade, não há pedir
// +250 no mesmo mês. O que cresce é a CARTEIRA — 250 no primeiro mês, 500 no
// segundo, 750 no terceiro, enquanto a assinatura estiver paga.
const PLANO = {
  nome: 'Mensal 250',
  processosPorCiclo: 250,
  preco: 1990,
  descricao: '250 precatórios novos por mês, sorteados e nunca repetidos.',
};

/**
 * Planos que ESTE script já criou e não usa mais.
 *
 * Só desativados, nunca apagados, e só quando não há assinatura apontando para
 * eles: plano é referência histórica de quanto um cliente pagava, e apagá-lo
 * apagaria o contexto de faturas antigas.
 */
const PLANOS_APOSENTADOS = ['Inicial 100', 'Avançado 1000'];

// ── Os perfis ──────────────────────────────────────────────
//
// `ciclos` é quantos MESES de lote a org recebe, contados para trás a partir do
// mês corrente. Zero = nunca recebeu nada.
//
// `statusFinal` é para onde a assinatura vai DEPOIS de gerar os lotes — o motor
// só distribui para ATIVA, e é assim que um suspenso fica com carteira e sem
// acesso, que é o estado que interessa testar.
const PERFIS = [
  {
    chave: 'pendente',
    nome: 'Fonseca & Ribeiro Advogados',
    plano: PLANO.nome,
    statusFinal: 'PENDENTE',
    ciclos: 0,
    porque: 'Assinou e ainda não pagou. Entra no sistema, mas não recebeu carteira.',
  },
  {
    chave: 'novo',
    nome: 'Martins Sociedade de Advogados',
    plano: PLANO.nome,
    statusFinal: 'ATIVA',
    ciclos: 0,
    porque: 'Pagou agora; o primeiro lote ainda não rodou. É a PRIMEIRA tela que um cliente novo vê — e o estado onde interface costuma quebrar.',
  },
  {
    chave: 'ativo',
    nome: 'Advocacia Nogueira',
    plano: PLANO.nome,
    statusFinal: 'ATIVA',
    ciclos: 2,
    crm: true,
    equipe: true,
    porque: 'O cliente saudável: dois ciclos recebidos e o CRM em uso.',
  },
  {
    chave: 'grande',
    nome: 'Vasconcelos Contencioso',
    plano: PLANO.nome,
    statusFinal: 'ATIVA',
    ciclos: 12,
    crm: true,
    equipe: true,
    porque: 'Doze meses pagos: 250 por mês viram 3.000 acumulados. Para ver busca, paginação e tempo de tela sob volume — e a acumulação funcionando.',
  },
  {
    chave: 'inadimplente',
    nome: 'Barreto Advogados Associados',
    plano: PLANO.nome,
    statusFinal: 'INADIMPLENTE',
    ciclos: 1,
    porque: 'Pagamento falhou. AINDA ACESSA — é a carência. O que ele não recebe é lote novo.',
  },
  {
    chave: 'suspensa',
    nome: 'Queiroz & Lima',
    plano: PLANO.nome,
    statusFinal: 'SUSPENSA',
    ciclos: 1,
    porque: 'Passou da carência. Toma 402 em tudo, e a carteira continua no banco — "dados preservados, acesso barrado".',
  },
  {
    chave: 'cancelada',
    nome: 'Escritório Andrade',
    plano: PLANO.nome,
    statusFinal: 'CANCELADA',
    ciclos: 1,
    porque: 'Encerrou. Mesmo bloqueio da suspensa, por outro motivo comercial.',
  },
];

const ETIQUETAS = [
  { nome: 'Contato feito', cor: 'ok' },
  { nome: 'Aguardando documento', cor: 'alerta' },
  { nome: 'Proposta enviada', cor: 'marca-ciano' },
  { nome: 'Sem retorno', cor: 'muted' },
  { nome: 'Prioridade do sócio', cor: 'erro' },
];

const ANOTACOES = [
  'Liguei para o titular. Atendeu a filha; pediu para retornar depois das 18h.',
  'Titular confirmou interesse na antecipação. Enviar proposta por e-mail.',
  'Número de telefone da base está desatualizado — tentar pelo endereço.',
  'Cliente pediu para aguardar a decisão do processo originário antes de fechar.',
  'Documentação recebida e conferida. Falta só a certidão de casamento.',
  'Sem retorno em três tentativas. Reavaliar no próximo ciclo.',
];

/**
 * O funil que a carteira precisa TER para as telas dizerem alguma coisa.
 *
 * Sem isto, todo perfil abria com 100% em "Novo": o funil da fila mostrava um
 * número e quatro zeros, o filtro de frios devolvia a carteira inteira
 * (indistinguível de nenhum filtro) e a tela do sócio ficava com doze safras
 * idênticas. As telas nasceriam impossíveis de conferir — e conferir na tela é
 * o único jeito de saber que estão certas.
 *
 * A maioria continua em NOVO de propósito: é o estado real de uma carteira no
 * começo do mês, e é o caminho "novo por AUSÊNCIA de linha" que mais quebra.
 */
const FUNIL = [
  { estagio: 'EM_CONTATO', ate: 0.2 },
  { estagio: 'PROPOSTA', ate: 0.3 },
  { estagio: 'FECHADO', ate: 0.35 },
  { estagio: 'PERDIDO', ate: 0.42 },
  /* o resto fica em NOVO */
];

const MOTIVOS_PERDA = [
  'Titular já cedeu o precatório a outro escritório.',
  'Telefone e endereço desatualizados; sem como localizar.',
  'Titular prefere aguardar o pagamento pelo tribunal.',
  'Valor da proposta recusado pela família.',
  'Titular falecido; inventário em andamento.',
];

const CONTATOS = [
  { canal: 'TELEFONE', resultado: 'ATENDEU' },
  { canal: 'TELEFONE', resultado: 'NAO_ATENDEU' },
  { canal: 'TELEFONE', resultado: 'NUMERO_ERRADO' },
  { canal: 'WHATSAPP', resultado: 'RECADO' },
  { canal: 'EMAIL', resultado: 'ATENDEU' },
  { canal: 'PRESENCIAL', resultado: 'RECUSOU' },
];

const TAREFAS = [
  { titulo: 'Ligar para o titular', tipo: 'TAREFA', dias: 1 },
  { titulo: 'Enviar proposta de antecipação', tipo: 'TAREFA', dias: 3 },
  { titulo: 'Conferir documentação recebida', tipo: 'TAREFA', dias: 5 },
  { titulo: 'Retomar contato', tipo: 'FOLLOW_UP', dias: 15 },
  { titulo: 'Reavaliar no próximo ciclo', tipo: 'FOLLOW_UP', dias: 30 },
];

/** Uma data a N dias atrás — as telas de funil só significam algo no tempo. */
function diasAtras(n) {
  return new Date(Date.now() - n * 86_400_000);
}

/** Sorteio determinístico: o mesmo perfil recebe sempre o mesmo CRM. */
function sorteio(semente) {
  let s = semente;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const primeiroDiaDoMes = (recuo) => {
  const hoje = new Date();
  return new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - recuo, 1));
};

async function remover() {
  const orgs = await prisma.organization.findMany({
    where: { cnpj: { startsWith: MARCA } },
    select: { id: true, nome: true },
  });
  if (orgs.length === 0) {
    console.log('Nada a remover: nenhuma org de teste encontrada.');
    return;
  }
  console.log(`Removendo ${orgs.length} org(s) de teste…`);
  for (const o of orgs) console.log(`  · ${o.nome}`);

  const ids = orgs.map((o) => o.id);

  /**
   * ── A ORDEM IMPORTA, E O CASCADE SOZINHO NÃO BASTA ──
   *
   * Apagar a organização leva junto os USUÁRIOS dela por cascade. Só que
   * `AnotacaoProcesso.autor` e `TarefaProcesso.criadoPor` apontam para User com
   * `onDelete: Restrict` — de propósito: anotação e tarefa são registro de
   * trabalho, e sumir com o autor apagaria de quem era.
   *
   * O efeito aqui é uma violação de chave estrangeira que aborta a remoção
   * INTEIRA, deixando as orgs de teste no banco. Foi o que aconteceu na primeira
   * execução. Estes dois saem antes, à mão; o resto o cascade resolve.
   */
  const anotacoes = await prisma.anotacaoProcesso.deleteMany({ where: { organizationId: { in: ids } } });
  const tarefas = await prisma.tarefaProcesso.deleteMany({ where: { organizationId: { in: ids } } });
  /* Auditoria e consultas também prendem o usuário (relação obrigatória sem
     cascade declarado). São registros de uso, e o dado de teste vai junto. */
  const auditoria = await prisma.auditLog.deleteMany({ where: { organizationId: { in: ids } } });
  const consultas = await prisma.consultaCliente.deleteMany({
    where: { user: { organizationId: { in: ids } } },
  });
  const importacoes = await prisma.importacao.deleteMany({ where: { organizationId: { in: ids } } });

  const { count } = await prisma.organization.deleteMany({ where: { id: { in: ids } } });
  console.log(
    `\n${count} organização(ões) removida(s) · ${anotacoes.count} anotação(ões) · ` +
      `${tarefas.count} tarefa(s) · ${auditoria.count} auditoria · ${consultas.count} consulta(s) · ` +
      `${importacoes.count} importação(ões).`,
  );
}

async function provisionar() {
  const senha = process.env.PERFIS_SENHA || `Teste.${randomBytes(6).toString('base64url')}!9`;
  const senhaHash = await hash(senha);

  const interna = await prisma.organization.findFirst({ where: { tipo: 'INTERNA' }, select: { id: true } });
  if (!interna) recusar('Não há organização INTERNA. Rode o seed antes.');
  const naBase = await prisma.processo.count({ where: { organization: { tipo: 'INTERNA' } } });
  console.log(`Base interna: ${naBase.toLocaleString('pt-BR')} processos disponíveis para distribuir.\n`);

  // ── O plano único ──
  const plano = await prisma.plano.upsert({
    where: { nome: PLANO.nome },
    update: {
      processosPorCiclo: PLANO.processosPorCiclo,
      preco: PLANO.preco,
      descricao: PLANO.descricao,
      ativo: true,
    },
    create: { ...PLANO, intervaloMeses: 1 },
    select: { id: true, nome: true, processosPorCiclo: true },
  });
  const planos = new Map([[plano.nome, plano]]);

  /* Aposenta os planos que versões anteriores deste script criaram — e SÓ os
     que ninguém assina. Desativar, e não apagar: o plano é a referência de
     quanto um cliente pagava, e sumir com ele apagaria o contexto de faturas
     antigas. */
  for (const nome of PLANOS_APOSENTADOS) {
    const antigo = await prisma.plano.findUnique({
      where: { nome },
      select: { id: true, ativo: true, _count: { select: { assinaturas: true } } },
    });
    if (antigo && antigo.ativo && antigo._count.assinaturas === 0) {
      await prisma.plano.update({ where: { id: antigo.id }, data: { ativo: false } });
      console.log(`Plano "${nome}" desativado (sem assinantes).`);
    }
  }
  console.log(`Plano único: ${plano.nome} · ${plano.processosPorCiclo}/mês\n`);

  const credenciais = [];

  for (const perfil of PERFIS) {
    const plano = planos.get(perfil.plano);
    const cnpj = `${MARCA}-${perfil.chave}`;

    const org = await prisma.organization.upsert({
      where: { cnpj },
      update: { nome: perfil.nome, tipo: 'CLIENTE', ativo: true },
      create: { nome: perfil.nome, cnpj, tipo: 'CLIENTE' },
      select: { id: true },
    });

    // ── Usuários ──
    const usuarios = [
      { sufixo: 'gestor', nome: `Gestor · ${perfil.nome}`, gestor: true, ativo: true },
    ];
    if (perfil.equipe) {
      usuarios.push({ sufixo: 'colega', nome: `Colega · ${perfil.nome}`, gestor: false, ativo: true });
      /* Um desativado em cada equipe: "usuário sem acesso" é estado que a tela
         de usuários mostra e que o login precisa recusar. */
      usuarios.push({ sufixo: 'inativo', nome: `Desativado · ${perfil.nome}`, gestor: false, ativo: false });
    }

    const criados = [];
    for (const u of usuarios) {
      const email = `${u.sufixo}.${perfil.chave}@${DOMINIO}`;
      const usuario = await prisma.user.upsert({
        where: { email },
        update: { senhaHash, nome: u.nome, gestor: u.gestor, ativo: u.ativo, organizationId: org.id },
        create: {
          email,
          senhaHash,
          nome: u.nome,
          /* Papel CLIENTE sempre: `gestor` é o eixo SEPARADO que decide quem
             manda dentro da própria organização. ADMIN aqui daria ao escritório
             assinante acesso à base inteira. */
          papel: 'CLIENTE',
          gestor: u.gestor,
          ativo: u.ativo,
          organizationId: org.id,
        },
        select: { id: true, email: true, ativo: true, gestor: true },
      });
      criados.push(usuario);
    }

    // ── Assinatura ──
    //
    // Começa ATIVA e recua o início, para os `ciclos` meses de lote caberem
    // dentro da vida dela — o motor recusa competência anterior ao início.
    const inicioEm = primeiroDiaDoMes(Math.max(perfil.ciclos - 1, 0));
    await prisma.assinatura.upsert({
      where: { organizationId: org.id },
      update: { planoId: plano.id, status: 'ATIVA', inicioEm, canceladaEm: null, inadimplenteDesde: null },
      create: {
        organizationId: org.id,
        planoId: plano.id,
        status: 'ATIVA',
        inicioEm,
        provedorCobranca: 'manual',
        proximaRenovacaoEm: primeiroDiaDoMes(-1),
      },
    });

    // ── Lotes, pelo motor de verdade ──
    let liberados = 0;
    for (let i = perfil.ciclos - 1; i >= 0; i--) {
      const r = await distribuicao.gerarLote({
        organizationId: org.id,
        competencia: primeiroDiaDoMes(i),
      });
      liberados += r.liberados ?? 0;
    }

    // ── Estado final da assinatura ──
    if (perfil.statusFinal !== 'ATIVA') {
      await prisma.assinatura.update({
        where: { organizationId: org.id },
        data: {
          status: perfil.statusFinal,
          inadimplenteDesde:
            perfil.statusFinal === 'INADIMPLENTE' || perfil.statusFinal === 'SUSPENSA'
              ? new Date(Date.now() - 12 * 24 * 60 * 60 * 1000)
              : null,
          canceladaEm: perfil.statusFinal === 'CANCELADA' ? new Date() : null,
          proximaRenovacaoEm: perfil.statusFinal === 'CANCELADA' ? null : undefined,
        },
      });
    }

    if (perfil.crm) await povoarCrm(org.id, criados.filter((u) => u.ativo), perfil.chave);

    console.log(
      `${perfil.statusFinal.padEnd(13)} ${perfil.nome.padEnd(32)} ${String(liberados).padStart(5)} liberados · ${criados.length} usuário(s)`,
    );

    credenciais.push({ perfil, org: org.id, usuarios: criados, liberados });
  }

  escreverCredenciais(credenciais, senha, Boolean(process.env.PERFIS_SENHA));
}

/**
 * Enche o overlay de CRM: funil, contatos, prioridade, responsável, etiquetas,
 * anotações e tarefas.
 *
 * Sem isto o cliente abre o CRM — que é o produto vendido — e vê listas vazias,
 * que não dizem se ele funciona. Cobre os dois lados de cada estado: tarefa
 * vencida E em dia, concluída E aberta, anotação fixada E comum, estágio
 * avançado E o "novo por ausência de linha", contato recente E frio.
 *
 * O teto de linhas é o que separa "carteira com movimento" de "esperar cinco
 * minutos por um script de teste": o resto da carteira fica sem overlay de
 * propósito, e é justamente esse resto que exercita o caminho da linha AUSENTE.
 */
async function povoarCrm(organizationId, usuarios, semente) {
  const sortear = sorteio([...semente].reduce((a, c) => a + c.charCodeAt(0), 7) * 2654435761);

  const etiquetas = [];
  for (const e of ETIQUETAS) {
    etiquetas.push(
      await prisma.etiqueta.upsert({
        where: { organizationId_nome: { organizationId, nome: e.nome } },
        update: { cor: e.cor },
        create: { organizationId, nome: e.nome, cor: e.cor },
        select: { id: true },
      }),
    );
  }

  /* Só os processos que a org REALMENTE recebeu: pôr CRM sobre processo não
     liberado criaria uma carteira que o escopo do cliente não enxerga. */
  const liberados = await prisma.processoLiberado.findMany({
    where: { organizationId },
    orderBy: { liberadoEm: 'desc' },
    take: 150,
    select: { processoId: true },
  });
  if (liberados.length === 0) return;

  const PRIORIDADES = ['BAIXA', 'NORMAL', 'NORMAL', 'ALTA', 'URGENTE'];
  const hoje = new Date();

  for (let i = 0; i < liberados.length; i++) {
    const processoId = liberados[i].processoId;
    const dono = usuarios[i % usuarios.length];

    /* ── O FUNIL ──
       O estágio vem do sorteio determinístico, e a data DE QUANDO ele mudou é
       recuada até 75 dias: sem recuar, tudo teria acontecido "agora" e a janela
       de 30 dias da tela mostraria 100% do movimento, que é o mesmo que não ter
       janela. */
    const dado = sortear();
    const faixa = FUNIL.find((f) => dado < f.ate);
    const estagio = faixa ? faixa.estagio : 'NOVO';
    const diasDoEstagio = Math.floor(sortear() * 75);
    const estagioEm = estagio === 'NOVO' ? null : diasAtras(diasDoEstagio);

    const doFunil = {
      estagio,
      estagioEm,
      motivoPerda:
        estagio === 'PERDIDO' ? MOTIVOS_PERDA[Math.floor(sortear() * MOTIVOS_PERDA.length)] : null,
    };

    /* ── POR QUE NÃO É UM `upsert` COM `update: {}` ──
       Era, e o efeito de rodar o script de novo seria nenhum: as linhas de
       overlay já existiam da execução anterior, e `update: {}` as deixa como
       estão. O funil nunca chegaria a quem já tem carteira.
       Também não pode ser `update` incondicional: sobrescreveria a triagem que
       o dono fez à mão enquanto testava. O critério é "ainda intocada" —
       estágio NOVO e sem carimbo de movimento. */
    const existente = await prisma.carteiraProcesso.findUnique({
      where: { organizationId_processoId: { organizationId, processoId } },
      select: { estagio: true, estagioEm: true },
    });
    const intocada = !existente || (existente.estagio === 'NOVO' && existente.estagioEm === null);

    if (!existente) {
      await prisma.carteiraProcesso.create({
        data: {
          organizationId,
          processoId,
          prioridade: PRIORIDADES[Math.floor(sortear() * PRIORIDADES.length)],
          responsavelId: dono.id,
          ...doFunil,
        },
      });
    } else if (intocada) {
      await prisma.carteiraProcesso.update({
        where: { organizationId_processoId: { organizationId, processoId } },
        data: doFunil,
      });
    }
    if (!intocada) continue;

    /* ── OS CONTATOS ──
       Quem saiu de NOVO só saiu porque alguém falou (ou tentou falar) com o
       titular — um estágio avançado sem nenhuma tentativa de contato registrada
       seria uma carteira que não existe. `ultimoContatoEm` é gravado na MESMA
       passada: é dele que sai o "sem contato" e o filtro de frios, e mantê-lo
       fora de sincronia com os contatos faria os dois números brigarem. */
    if (estagio !== 'NOVO') {
      const quantos = 1 + Math.floor(sortear() * 3);
      let maisRecente = null;
      for (let t = 0; t < quantos; t++) {
        const c = CONTATOS[Math.floor(sortear() * CONTATOS.length)];
        /* Espalhados ANTES da mudança de estágio: liga-se, depois se avança. */
        const quando = diasAtras(diasDoEstagio + 3 + t * 7);
        if (!maisRecente || quando > maisRecente) maisRecente = quando;
        await prisma.contatoProcesso.create({
          data: {
            processoId,
            organizationId,
            autorId: dono.id,
            canal: c.canal,
            resultado: c.resultado,
            criadoEm: quando,
          },
        });
      }
      await prisma.carteiraProcesso.update({
        where: { organizationId_processoId: { organizationId, processoId } },
        data: { ultimoContatoEm: maisRecente },
      });
    }

    /* Nem todo processo tem tudo — uma carteira em que 100% dos itens têm
       anotação, tarefa e etiqueta não se parece com nenhuma carteira real, e
       esconde como a tela fica quando o campo está vazio. */
    if (sortear() < 0.6) {
      const etiqueta = etiquetas[Math.floor(sortear() * etiquetas.length)];
      await prisma.processoEtiqueta.upsert({
        where: { processoId_etiquetaId: { processoId, etiquetaId: etiqueta.id } },
        update: {},
        create: { processoId, etiquetaId: etiqueta.id },
      });
    }

    if (sortear() < 0.5) {
      const jaTem = await prisma.anotacaoProcesso.count({ where: { processoId, organizationId } });
      if (jaTem === 0) {
        await prisma.anotacaoProcesso.create({
          data: {
            processoId,
            organizationId,
            autorId: dono.id,
            texto: ANOTACOES[Math.floor(sortear() * ANOTACOES.length)],
            fixada: sortear() < 0.2,
          },
        });
      }
    }

    if (sortear() < 0.45) {
      const jaTem = await prisma.tarefaProcesso.count({ where: { processoId, organizationId } });
      if (jaTem === 0) {
        const t = TAREFAS[Math.floor(sortear() * TAREFAS.length)];
        /* Um terço VENCIDAS: prazo estourado é o que a tela precisa destacar, e
           só aparece se existir. */
        const vencida = sortear() < 0.33;
        const prazo = new Date(hoje);
        prazo.setUTCDate(prazo.getUTCDate() + (vencida ? -t.dias : t.dias));
        await prisma.tarefaProcesso.create({
          data: {
            processoId,
            organizationId,
            tipo: t.tipo,
            titulo: t.titulo,
            prazo,
            responsavelId: dono.id,
            criadoPorId: usuarios[0].id,
            concluidaEm: sortear() < 0.25 ? new Date() : null,
          },
        });
      }
    }
  }
}

function escreverCredenciais(credenciais, senha, senhaVeioDoAmbiente) {
  const destino = resolve(RAIZ, 'perfis-de-teste.local.md');
  const linhas = [
    '# Perfis de cliente para teste',
    '',
    '> Gerado por `node apps/api/scripts/perfis-de-teste.js`.',
    '> **Fora do git** (`.gitignore`). Contém senha — não versione, não cole em chat.',
    '',
    senhaVeioDoAmbiente
      ? '**Senha:** a que você definiu em `PERFIS_SENHA`.'
      : `**Senha (a mesma para todos):** \`${senha}\``,
    '',
    '| Estado | Escritório | Entrar como | Carteira | O que este perfil testa |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const c of credenciais) {
    const gestor = c.usuarios.find((u) => u.gestor) ?? c.usuarios[0];
    linhas.push(
      `| \`${c.perfil.statusFinal}\` | ${c.perfil.nome} | \`${gestor.email}\` | ${c.liberados} | ${c.perfil.porque} |`,
    );
  }
  linhas.push('', '## Outros usuários', '');
  for (const c of credenciais) {
    for (const u of c.usuarios.filter((x) => !x.gestor)) {
      linhas.push(`- \`${u.email}\` — ${u.ativo ? 'colega, sem poder de gestão' : 'DESATIVADO: o login tem de recusar'}`);
    }
  }
  linhas.push(
    '',
    '## Para remover tudo',
    '',
    '```bash',
    'node apps/api/scripts/perfis-de-teste.js --remover --sim',
    '```',
    '',
  );
  writeFileSync(destino, linhas.join('\n'), 'utf8');
  console.log(`\nCredenciais em: ${destino}`);
  if (!senhaVeioDoAmbiente) console.log('(senha gerada agora; defina PERFIS_SENHA para escolher a sua)');
}

(REMOVER ? remover() : provisionar())
  .catch((e) => {
    console.error('FALHOU:', e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
