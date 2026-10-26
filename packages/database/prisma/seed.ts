/**
 * Seed — carrega uma carteira de precatórios a partir de uma planilha.
 *
 * Tribunal, exercício e arquivo vêm de env (SEED_TRIBUNAL, SEED_EXERCICIO,
 * SEED_XLSX); o default reproduz a carga original do TRF5/2027. As COLUNAS vêm
 * do PerfilImportacao do tribunal — o mesmo que a API usa —, então os dois
 * caminhos leem o arquivo de um jeito só.
 *
 * Fonte: RELATORIO_PRECATORIOS_TRF5_COMPLETOS.xlsx, aba "Requerentes Completos"
 *   4.188 linhas — uma por precatório — com nome + CPF + valor + precatório +
 *   originário + requisitório. São 3.974 requerentes DISTINTOS: 149 titulares
 *   aparecem em mais de um precatório, o que responde por as duas contagens
 *   nunca baterem. Conferido na fonte: todo CPF com dígito verificador válido,
 *   nenhum CPF ligado a mais de um nome e nenhum precatório repetido entre
 *   linhas.
 *
 * É idempotente: pode rodar quantas vezes quiser (upsert por CPF e por precatório).
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { readSheet } from 'read-excel-file/node';
import { hash } from '@node-rs/argon2';
import { PrismaClient, Papel, PapelProcessual, TipoOrganizacao } from '../generated/client';
import { calcularDelta, descreverDelta, mesmoDinheiro } from './timeline-processo';

import { lerCampos, linhasEmObjetos, valorDePlanilha, type MapaColunas } from './colunas-planilha';

const prisma = new PrismaClient();

/**
 * Variável de ambiente, tratando VAZIA como ausente.
 *
 * `??` só cai no default para `undefined`/`null`, e `.env.example` traz as
 * chaves opcionais como `SEED_XLSX=` — string vazia. Sem isto, quem copia o
 * exemplo recebe "Planilha não encontrada em " com o caminho em branco, e a
 * mensagem que existe para orientar não orienta nada.
 */
const env = (nome: string): string | undefined => {
  const v = process.env[nome]?.trim();
  return v ? v : undefined;
};

/**
 * Onde está a planilha da carga.
 *
 * Era um caminho absoluto para o `Downloads` de uma máquina específica — o seed
 * só rodava no computador de quem o escreveu.
 *
 * O default agora é `dados/carteira.xlsx` na RAIZ DO REPOSITÓRIO, resolvido a
 * partir de `__dirname` e não de `process.cwd()`: o seed é chamado tanto de
 * `packages/database` (`npm run seed`) quanto da raiz (`--workspace`), e um
 * caminho relativo ao cwd apontaria para lugares diferentes nos dois casos.
 *
 * A pasta `dados/` está fora do versionamento (o `.gitignore` já cobre `*.xlsx`)
 * e é isso que a torna o lugar certo: a planilha tem 3.974 CPFs de pessoas
 * reais, e "caminho relativo" não pode virar "dado pessoal dentro do repositório".
 *
 * `SEED_XLSX` continua tendo precedência, para quem guarda o arquivo noutro
 * lugar — é o que o `.env` desta máquina usa.
 */
const RAIZ_REPO = path.resolve(__dirname, '..', '..', '..');
const PLANILHA = env('SEED_XLSX') ?? path.join(RAIZ_REPO, 'dados', 'carteira.xlsx');

/* Tribunal e exercício da carga. Default = a carteira original, para o seed
   continuar reproduzindo exatamente o que já está no banco; qualquer outro lote
   entra por env, sem tocar em código. */
const TRIBUNAL = (env('SEED_TRIBUNAL') ?? 'TRF5').toUpperCase().replace(/-/g, '');
const EXERCICIO = Number(env('SEED_EXERCICIO') ?? 2027);

const ORG_NOME = env('SEED_ORG_NOME') ?? 'Leão Amorim Advogados';
const ADMIN_EMAIL = env('SEED_ADMIN_EMAIL') ?? 'admin@exemplo.com.br';

// ── normalização ──────────────────────────────────────────────

const soDigitos = (v: unknown): string => String(v ?? '').replace(/\D/g, '');

const normalizarNome = (v: unknown): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Valida CPF pelo dígito verificador. Lixo não entra no banco. */
function cpfValido(cpf: string): boolean {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const i of [9, 10]) {
    let soma = 0;
    for (let j = 0; j < i; j++) soma += Number(cpf[j]) * (i + 1 - j);
    if (((soma * 10) % 11) % 10 !== Number(cpf[i])) return false;
  }
  return true;
}

/**
 * "TRF5_Divida_Consolidada_2027_INSS_-_INSTITUTO_..._-_ALIMENTAR.pdf" → "INSS"
 *
 * O prefixo é DERIVADO, não literal: era `.replace('TRF5_Divida_Consolidada_2027_')`,
 * um casamento exato que, numa carga do TRF1, deixaria o prefixo inteiro dentro
 * da entidade devedora — e o ranking do dashboard passaria a agrupar por
 * "TRF1 Divida Consolidada 2028 INSS" em vez de "INSS". */
function entidadeDoArquivo(nomeArquivo: string): string {
  const prefixo = new RegExp(`^${TRIBUNAL}_[A-Za-z_]*?_${EXERCICIO}_`, 'i');
  return String(nomeArquivo ?? '')
    .replace(prefixo, '')
    .replace(/\.pdf$/i, '')
    .split('_-_')[0]
    .replace(/_/g, ' ')
    .trim();
}

function naturezaDoArquivo(nomeArquivo: string): string | null {
  const n = String(nomeArquivo ?? '').toUpperCase();
  if (n.includes('NÃO_ALIMENTAR') || n.includes('NAO_ALIMENTAR')) return 'Natureza comum';
  if (n.includes('ALIMENTAR')) return 'Natureza alimentar';
  return null;
}

// ── reconciliação (diff-and-update) ───────────────────────────

/**
 * Pessoa: cria ou corrige. NÃO gera evento.
 *
 * Nenhum campo de Pessoa é logável: nome e CPF são dado pessoal e EventoProcesso
 * é append-only. Registrar "nome mudou de X para Y" criaria um dado que uma
 * SolicitacaoTitular de EXCLUSÃO não conseguiria apagar.
 */
async function sincronizarPessoa(cpf: string, nomeBruto: string) {
  const nome = nomeBruto.trim();
  const nomeNormalizado = normalizarNome(nome);

  const atual = await prisma.pessoa.findUnique({
    where: { cpf },
    select: { id: true, nome: true, nomeNormalizado: true },
  });

  if (!atual) {
    const criada = await prisma.pessoa.create({
      data: { cpf, nome, nomeNormalizado },
      select: { id: true },
    });
    return { id: criada.id, criada: true, atualizada: false };
  }

  /* `nome` e `nomeNormalizado` andam JUNTOS: a busca por nome roda sobre o índice
     trigram de nomeNormalizado. Corrigir um sem o outro deixaria a pessoa achável
     pelo nome antigo e invisível pelo novo. */
  if (atual.nome !== nome || atual.nomeNormalizado !== nomeNormalizado) {
    await prisma.pessoa.update({ where: { id: atual.id }, data: { nome, nomeNormalizado } });
    return { id: atual.id, criada: false, atualizada: true };
  }

  return { id: atual.id, criada: false, atualizada: false };
}

/**
 * Lê o processo, calcula o delta e grava SÓ o que mudou — com um evento junto.
 *
 * Substitui o `upsert ... update: {}`, que era write-once: rodar o seed de novo
 * com a planilha corrigida não alterava campo algum.
 *
 * Sem tratamento de corrida (P2002): o seed roda sozinho, ao contrário da API —
 * a versão com retry está em apps/api/src/modules/importacao/importacao.service.ts.
 */
async function reconciliarProcesso(params: {
  tribunalId: string;
  organizationId: string;
  numeroPrecatorio: string;
  /** O MESMO objeto alimenta o `create` e o diff — listas separadas deixariam um
      campo entrar na criação e nunca mais ser corrigido numa recarga. */
  daPlanilha: {
    numeroOriginario: string | null;
    numeroRequisitorio: string | null;
    entidadeDevedora: string | null;
    natureza: string | null;
    situacao: string | null;
    valor: number | null;
  };
  /** Descrição da origem desta carga. Parâmetro, e não constante de módulo,
      porque depende do perfil resolvido em tempo de execução. */
  fonte: string;
}) {
  /* Chave composta: o número só é único DENTRO do tribunal. */
  const chave = {
    tribunalId_numeroPrecatorio: {
      tribunalId: params.tribunalId,
      numeroPrecatorio: params.numeroPrecatorio,
    },
  };

  /* Linha inteira, sem `select`: o diff percorre CAMPOS_LOGAVEIS, e um `select`
     que esquecesse um deles devolveria `undefined` — que o diff leria como
     "mudou", reescrevendo o campo e emitindo evento em TODA execução. */
  const atual = await prisma.processo.findUnique({ where: chave });

  if (!atual) {
    /* Criação e marco IMPORTADO na mesma transação: processo sem evento inicial
       faria a timeline do CRM começar do nada. */
    const criado = await prisma.$transaction(async (tx) => {
      const novo = await tx.processo.create({
        data: {
          ...params.daPlanilha,
          numeroPrecatorio: params.numeroPrecatorio,
          tribunalId: params.tribunalId,
          organizationId: params.organizationId,
          /* A carga do seed reproduz a divida consolidada dos TRFs, que lista
             precatorio ja autuado e aguardando exercicio. */
          fase: 'PRECATORIO_EXPEDIDO',
          exercicio: EXERCICIO,
          /* create-only: `fonte` descreve a origem da carga. Diffá-la faria toda
             recarga "atualizar" todo processo. */
          fonte: params.fonte,
        },
        select: { id: true },
      });
      await tx.eventoProcesso.create({
        data: {
          processoId: novo.id,
          tipo: 'IMPORTADO',
          /* Frase estável, sem o nome do arquivo: `descricao` é texto livre numa
             tabela append-only e não passa pela trava de LGPD do calcularDelta.
             Ver o comentário equivalente em importacao.service.ts. */
          descricao: 'Processo importado para a carteira',
        },
      });
      return novo;
    });
    return { id: criado.id, criado: true, atualizado: false };
  }

  const delta = calcularDelta({ ...atual }, params.daPlanilha);

  /* Nada mudou: nenhum update — nem o `editadoEm` — e nenhum evento. É o que faz
     recarregar a planilha idêntica ser no-op observável. */
  if (!delta) return { id: atual.id, criado: false, atualizado: false };

  /* Update e evento na MESMA transação: campo alterado sem linha na timeline é a
     falha que este desenho existe para tornar impossível. */
  await prisma.$transaction([
    prisma.processo.update({ where: { id: atual.id }, data: delta.dados }),
    prisma.eventoProcesso.create({
      data: {
        processoId: atual.id,
        tipo: 'DADO_ATUALIZADO',
        /* Sem o nome do arquivo — mesmo motivo do IMPORTADO acima. */
        descricao: descreverDelta(delta, 'recarga da planilha'),
        /* Só campo NÃO pessoal chega aqui — garantido por calcularDelta. */
        camposAlterados: delta.campos,
        detalhe: delta.detalhe,
      },
    }),
  ]);

  return { id: atual.id, criado: false, atualizado: true };
}

/**
 * Vínculo parte↔processo. Corrige `valorIndividual`, sem evento — é o valor
 * devido a UM titular, e registrá-lo num log append-only apontaria para a pessoa.
 */
async function vincularParte(processoId: string, pessoaId: string, valorIndividual: number | null) {
  const chave = { processoId_pessoaId: { processoId, pessoaId } };

  const vinculo = await prisma.processoPessoa.findUnique({
    where: chave,
    select: { valorIndividual: true },
  });

  if (!vinculo) {
    await prisma.processoPessoa.create({
      data: { processoId, pessoaId, papel: PapelProcessual.REQUERENTE, valorIndividual },
    });
    return;
  }

  /* Comparação por mesmoDinheiro porque Decimal do Prisma é objeto:
     `vinculo.valorIndividual !== 1234.56` seria sempre verdadeiro e reescreveria
     os 4.188 vínculos em toda execução — e a soma da carteira depende deles. */
  if (valorIndividual !== null && !mesmoDinheiro(vinculo.valorIndividual, valorIndividual)) {
    await prisma.processoPessoa.update({ where: chave, data: { valorIndividual } });
  }
}

// ── seed ──────────────────────────────────────────────────────

async function main() {
  console.log(`┌─ Seed — carteira ${TRIBUNAL} ${EXERCICIO}`);

  // 1. Organização
  const org = await prisma.organization.upsert({
    where: { cnpj: env('SEED_ORG_CNPJ') ?? '00000000000000' },
    /* tipo INTERNA nos dois lados: o default do schema é CLIENTE (toda org nova
       nasce de uma venda), então sem isto o re-seed marcaria a operação interna
       como cliente e ela sumiria do próprio painel na Fase B. */
    update: { nome: ORG_NOME, tipo: TipoOrganizacao.INTERNA },
    create: {
      nome: ORG_NOME,
      cnpj: env('SEED_ORG_CNPJ') ?? '00000000000000',
      tipo: TipoOrganizacao.INTERNA,
    },
  });

  /* O catálogo de tribunais vem da migration de identidade. O seed não o cria:
     se faltar, é sinal de banco fora do esperado e falhar alto é melhor do que
     inventar um tribunal e gravar 4.188 processos sob ele. */
  const tribunal = await prisma.tribunal.findUnique({
    where: { sigla: TRIBUNAL },
    select: { id: true, sigla: true },
  });
  if (!tribunal) throw new Error(`Tribunal ${TRIBUNAL} ausente. Rode as migrations antes do seed.`);

  /* O PERFIL passa a mandar em como a planilha é lida — antes o seed tinha os
     rótulos literais numa constante e a API lia pelo perfil, então o MESMO
     arquivo tinha duas interpretações possíveis e nenhuma era a oficial. */
  const perfil = await prisma.perfilImportacao.findFirst({
    where: { tribunalId: tribunal.id, ativo: true },
    orderBy: { criadoEm: 'asc' },
    select: { nome: true, mapaColunas: true, colunasObrigatorias: true, aba: true },
  });
  if (!perfil) {
    throw new Error(
      `Nenhum perfil de importação ativo para ${tribunal.sigla}. ` +
        'Rode as migrations antes do seed.',
    );
  }
  const MAPA = perfil.mapaColunas as MapaColunas;
  const FONTE = `${tribunal.sigla} — ${perfil.nome} ${EXERCICIO}`;
  console.log(`├─ lote: ${tribunal.sigla} · ${EXERCICIO} · perfil "${perfil.nome}"`);
  console.log(`├─ organização: ${org.nome}`);

  /* 2. Admin — senha vem do env; se ausente, gera uma forte e imprime UMA vez.

     `jaExistia` é consultado ANTES do upsert porque o upsert não conta qual dos
     dois caminhos tomou — e sem essa distinção o seed anunciava, com destaque,
     uma senha que ele mesmo acabara de descartar: o `update: {}` abaixo preserva
     a credencial de quem já existe, então o valor gerado nunca chegava ao banco.
     Quem rodasse num banco já semeado (o caso NORMAL, já que o seed é feito para
     rodar de novo) tentaria entrar com ela e falharia sem entender por quê.

     O upsert fica no lugar de um findUnique+create: ele é atômico, e a corrida
     entre duas execuções simultâneas é pior do que o único argon2 desperdiçado
     quando o admin já existe. */
  const jaExistia = (await prisma.user.count({ where: { email: ADMIN_EMAIL } })) > 0;

  let senhaAdmin = process.env.SEED_ADMIN_PASSWORD ?? '';
  let senhaGerada = false;
  if (!senhaAdmin) {
    senhaAdmin = randomBytes(12).toString('base64url');
    senhaGerada = true;
  }
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    /* Este `update: {}` FICA. Diferente dos de pessoa e processo, aqui write-once
       é o comportamento certo: rodar o seed de novo não pode ressetar a senha nem
       rebaixar o papel de um admin que já existe e já trocou as credenciais. */
    update: {},
    create: {
      organizationId: org.id,
      email: ADMIN_EMAIL,
      nome: 'Administrador',
      papel: Papel.ADMIN,
      senhaHash: await hash(senhaAdmin, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    },
  });
  console.log(`├─ admin: ${admin.email}${jaExistia ? ' (já existia — senha preservada)' : ' (criado agora)'}`);

  // 3. Planilha
  /* Erro acionável em vez do ENOENT cru. Com o caminho deixando de ser fixo, o
     arquivo ausente passa a ser o modo de falha ESPERADO num clone novo — e
     "ENOENT: no such file or directory" não diz onde pôr a planilha. */
  if (!existsSync(PLANILHA)) {
    throw new Error(
      `Planilha não encontrada em ${PLANILHA}\n` +
        '   Coloque o arquivo em dados/carteira.xlsx (a pasta é ignorada pelo git),\n' +
        '   ou aponte SEED_XLSX no .env para onde ele está.',
    );
  }
  console.log(`├─ lendo ${path.basename(PLANILHA)}`);
  /* PRIMEIRA aba, sempre — diferente da API, que respeita `perfil.aba`. Hoje dá
     no mesmo: `aba` está NULL nos 6 perfis, e a planilha do TRF5 tem uma aba só.
     Mas quem preencher `aba` num perfil vai ver a API mudar de aba e o seed
     continuar na primeira, em silêncio. É a exceção à leitura única que o
     cabeçalho deste arquivo promete — se for preencher, ajuste isto junto.
     (O `readSheet` sem segundo argumento já é a primeira aba.)

     LEITOR: `read-excel-file`, o mesmo da API desde o B6 — o SheetJS saiu por
     não ter correção para GHSA-4r6h-8v6p-xvw6 e GHSA-5pgg-2g8v-p4x9. A troca
     foi conferida célula a célula contra as planilhas reais do TRF1: 111.650
     células, zero divergência. */
  const linhas = linhasEmObjetos((await readSheet(readFileSync(PLANILHA))) as unknown[][]);
  console.log(`├─ ${linhas.length} linhas na planilha`);

  /* As colunas vêm do PERFIL, não de uma constante daqui. Antes esta lista
     tinha os rótulos exatos da planilha do TRF5 ("Número do processo de
     precatório no TRF5"), e a API lia o mesmo arquivo por aliases normalizados:
     duas leituras possíveis, nenhuma oficial. O leitor é o mesmo dos dois lados
     — ver colunas-planilha.ts. */

  let pessoasCriadas = 0;
  let pessoasAtualizadas = 0;
  let processosCriados = 0;
  let processosAtualizados = 0;
  let processosInalterados = 0;
  let eventos = 0;
  let vinculos = 0;
  let ignoradas = 0;

  /* Guarda contra a planilha que repete o MESMO processo em várias linhas — o
     formato de um precatório com vários beneficiários, em que as colunas do
     processo se repetem linha a linha e só o valor individual muda.

     Reconciliar o processo em toda linha faria os campos brigarem dentro da
     mesma execução: `valor` vem da coluna "Valor atualizado individual", então
     cada linha proporia um valor diferente para o mesmo processo, e a recarga
     seguinte inverteria tudo de novo — thrash perpétuo, evento em todo processo
     em toda recarga, o oposto do no-op exigido. A PRIMEIRA linha do processo
     decide; as demais só criam o vínculo da parte.

     ATENÇÃO ao mexer: a planilha do TRF5 NÃO exercita este caminho. Conferido
     na fonte — 4.188 linhas para 4.188 processos distintos, nenhum repetido, no
     máximo uma linha por processo. O que se repete nela é o TITULAR (149 deles),
     que é o caso oposto e não passa por aqui. A proteção vale para planilhas de
     outros tribunais; mudá-la é mexer em código que nada exercita. */
  const reconciliados = new Map<string, string>();

  for (const [i, linha] of linhas.entries()) {
    const campo = lerCampos(linha, MAPA);
    const cpf = soDigitos(campo('cpf'));
    const nome = campo('nome') ?? '';
    const numPrec = campo('processo') ?? '';

    if (!cpfValido(cpf) || !nome || !numPrec) {
      ignoradas++;
      continue;
    }

    // Pessoa — dedup por CPF (a mesma pessoa aparece em vários precatórios)
    const pessoa = await sincronizarPessoa(cpf, nome);
    if (pessoa.criada) pessoasCriadas++;
    else if (pessoa.atualizada) pessoasAtualizadas++;

    const arquivo = campo('arquivo') ?? '';
    /* Antes só aceitava `typeof === 'number'`, o que dependia do xlsx ter
       convertido a célula: valor gravado como TEXTO ("1.234,56") virava null e
       o precatório entrava sem valor, em silêncio. `valorDePlanilha` é o mesmo
       parser da API e resolve os dois formatos. */
    const valor = valorDePlanilha(campo('valor'));

    let processoId = reconciliados.get(numPrec);
    if (!processoId) {
      const reconciliacao = await reconciliarProcesso({
        fonte: FONTE,
        tribunalId: tribunal.id,
        organizationId: org.id,
        numeroPrecatorio: numPrec,
        daPlanilha: {
          numeroOriginario: campo('originario'),
          numeroRequisitorio: campo('requisitorio'),
          entidadeDevedora: entidadeDoArquivo(arquivo) || null,
          natureza: naturezaDoArquivo(arquivo),
          situacao: campo('situacao'),
          valor,
        },
      });
      processoId = reconciliacao.id;
      reconciliados.set(numPrec, processoId);

      if (reconciliacao.criado) processosCriados++;
      else if (reconciliacao.atualizado) processosAtualizados++;
      else processosInalterados++;
      if (reconciliacao.criado || reconciliacao.atualizado) eventos++;
    }

    await vincularParte(processoId, pessoa.id, valor);
    vinculos++;

    if ((i + 1) % 500 === 0) console.log(`│  ${i + 1}/${linhas.length}...`);
  }

  const totalPessoas = await prisma.pessoa.count();
  const totalProcessos = await prisma.processo.count();
  const soma = await prisma.processoPessoa.aggregate({ _sum: { valorIndividual: true } });

  console.log('├─────────────────────────────');
  console.log(`├─ pessoas únicas ....: ${totalPessoas}`);
  console.log(`├─ processos .........: ${totalProcessos}`);
  console.log(`├─ vínculos .........: ${vinculos}`);
  console.log(`├─ linhas ignoradas ..: ${ignoradas}`);
  /* O que ESTA execução mexeu. Rodar de novo com a mesma planilha tem de sair
     tudo zero, exceto "inalterados" — antes o contador somava uma linha por
     registro processado e dizia "4.188 processos novos" em toda execução, o que
     tornava impossível notar que o seed era write-once. */
  console.log('├─ nesta execução:');
  console.log(`├─   pessoas criadas ......: ${pessoasCriadas}`);
  console.log(`├─   pessoas atualizadas ..: ${pessoasAtualizadas}`);
  console.log(`├─   processos criados ....: ${processosCriados}`);
  console.log(`├─   processos atualizados : ${processosAtualizados}`);
  console.log(`├─   processos inalterados : ${processosInalterados}`);
  console.log(`├─   eventos na timeline ..: ${eventos}`);
  console.log(
    `├─ soma dos valores ..: R$ ${Number(soma._sum.valorIndividual ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
  );

  /* `!jaExistia` é o que separa uma credencial de uma mentira: a senha só foi
     gravada se o admin nasceu NESTA execução. Ver a nota no upsert. */
  if (senhaGerada && !jaExistia) {
    console.log('│');
    console.log('├─ ⚠  SENHA DO ADMIN GERADA (aparece só agora, troque no primeiro login):');
    console.log(`├─    ${ADMIN_EMAIL}`);
    console.log(`├─    ${senhaAdmin}`);
  }
  console.log('└─ concluído');
}

main()
  .catch((e) => {
    console.error('seed falhou:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
