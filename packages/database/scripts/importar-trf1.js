#!/usr/bin/env node
/**
 * Carga das planilhas de Dívida Consolidada do TRF1.
 *
 * ── POR QUE UM CARREGADOR PRÓPRIO, e não a rota /importacao ──
 *
 * 1. SEMÂNTICA DO VALOR. Na planilha do TRF5 a coluna era "Valor atualizado
 *    individual" — o que cabe a UMA pessoa. No TRF1 é o valor do PRECATÓRIO, e
 *    quando ele tem 3 credores as 3 linhas repetem o mesmo total. O importador
 *    genérico grava `valorIndividual = valor da linha`, o que somaria o mesmo
 *    dinheiro três vezes: R$ 69,3 milhões a mais nos 230 precatórios com mais de
 *    um credor. Aqui o total fica no Processo e é DIVIDIDO entre as partes.
 *
 *    ⚠ A divisão é IGUALITÁRIA e é uma ESTIMATIVA: a planilha não informa o
 *    rateio real. Vale para 230 de 8.237 precatórios (2,8%); nos outros 97,2%,
 *    com um credor só, o valor individual é exato. O agregado fecha em qualquer
 *    caso, porque a soma das partes é sempre o total do precatório.
 *
 * 2. `natureza` e `vara` vêm em coluna própria e o importador genérico não as lê
 *    (no TRF5 a natureza era deduzida do nome do arquivo PDF).
 *
 * 3. VOLUME. São 8.479 linhas com 4-6 idas ao banco cada. A rota faz isso dentro
 *    da requisição HTTP e estouraria o timeout do proxy — é o achado da auditoria
 *    que a Onda B vai resolver movendo a importação para a fila.
 *
 * O que NÃO muda: os cabeçalhos saem do PerfilImportacao (fonte única), o CPF é
 * validado por dígito verificador, e tudo é idempotente — rodar duas vezes com a
 * mesma planilha não duplica nada.
 *
 *   node scripts/importar-trf1.js "<arquivo.xlsx>" [--sim]
 *
 * Sem `--sim` é SIMULAÇÃO: lê, confere e relata, sem gravar uma linha.
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolve } = require('node:path');

require('dotenv').config({ path: resolve(__dirname, '../../../.env') });

const { readSheet } = require('read-excel-file/node');
const { PrismaClient } = require('../generated/client');

/**
 * Converte a matriz de células em objetos — cópia de `colunas-planilha.ts`.
 *
 * Duplicada pelo MESMO motivo do `chaveColuna` logo abaixo: aquele arquivo é
 * TypeScript e este é um script Node puro. Se mudar lá, muda aqui.
 */
function linhasEmObjetos(linhas) {
  const [cabecalho = [], ...corpo] = linhas;
  const colunas = cabecalho.map((c) => (c === null || c === undefined ? '' : String(c)));

  return corpo.map((linha) => {
    const registro = {};
    colunas.forEach((nome, i) => {
      if (nome === '' || nome in registro) return;
      const v = linha[i];
      registro[nome] = v === undefined ? null : v;
    });
    return registro;
  });
}

/**
 * Reduz um cabeçalho à forma comparável — cópia de `colunas-planilha.ts`.
 *
 * Duplicado porque aquele arquivo é TypeScript e este é um script Node puro; é a
 * mesma razão pela qual o projeto já mantém DUAS cópias dele (uma no seed, outra
 * na API). A função é pura e de seis linhas, então a cópia é segura — mas se ela
 * mudar lá, muda aqui.
 */
const chaveColuna = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const RAIZ = resolve(__dirname, '../../..');
const TRIBUNAL = 'TRF1';
const EXERCICIO = 2027; // LOA 2026, pago em 2027 — confirmado pelo dono da carteira

const arquivoArg = process.argv[2];
const GRAVAR = process.argv.includes('--sim');
if (!arquivoArg) {
  console.error('uso: node scripts/importar-trf1.js "<arquivo.xlsx>" [--sim]');
  process.exit(1);
}
const CAMINHO = path.isAbsolute(arquivoArg) ? arquivoArg : path.join(RAIZ, 'dados', arquivoArg);
if (!fs.existsSync(CAMINHO)) {
  console.error(`planilha não encontrada: ${CAMINHO}`);
  process.exit(1);
}

const prisma = new PrismaClient();
const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const brl = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const normalizarNome = (v) =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Valida CPF pelo dígito verificador. Lixo não entra no banco. */
function cpfValido(cpf) {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const i of [9, 10]) {
    let soma = 0;
    for (let j = 0; j < i; j++) soma += Number(cpf[j]) * (i + 1 - j);
    if (((soma * 10) % 11) % 10 !== Number(cpf[i])) return false;
  }
  return true;
}

/** Valor monetário: aqui as planilhas vêm com ponto decimal, mas aceita os dois. */
function valorDe(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const limpo = String(v).replace(/[^\d.,-]/g, '');
  if (!/\d/.test(limpo)) return null;
  const vir = limpo.lastIndexOf(',');
  const pon = limpo.lastIndexOf('.');
  const n = Number(vir > pon ? limpo.replace(/\./g, '').replace(',', '.') : limpo.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

(async () => {
  console.log(`┌─ Carga ${TRIBUNAL} · exercício ${EXERCICIO}`);
  console.log(`├─ arquivo: ${path.basename(CAMINHO)}`);
  console.log(`├─ modo: ${GRAVAR ? '⚠ GRAVANDO' : 'SIMULAÇÃO (nada é escrito)'}`);

  const tribunal = await prisma.tribunal.findUnique({
    where: { sigla: TRIBUNAL },
    select: { id: true, sigla: true },
  });
  if (!tribunal) throw new Error(`Tribunal ${TRIBUNAL} ausente. Rode as migrations.`);

  const org = await prisma.organization.findFirstOrThrow({
    where: { tipo: 'INTERNA' },
    orderBy: { criadoEm: 'asc' },
    select: { id: true, nome: true },
  });
  console.log(`├─ organização: ${org.nome}`);

  const perfil = await prisma.perfilImportacao.findFirstOrThrow({
    where: { tribunalId: tribunal.id, ativo: true },
    orderBy: { criadoEm: 'asc' },
    select: { nome: true, mapaColunas: true },
  });
  const MAPA = perfil.mapaColunas;
  console.log(`├─ perfil: "${perfil.nome}"`);

  /* Leitor: `read-excel-file`, o mesmo da API e do seed. O SheetJS saiu do
     projeto por não ter correção publicada (GHSA-4r6h-8v6p-xvw6 e
     GHSA-5pgg-2g8v-p4x9). Conferido célula a célula contra ESTAS planilhas:
     111.650 células, zero divergência.
     O `cellDates: true` some sem consequência — o read-excel-file já devolve
     `Date` nativo em célula de data, e este script consome tudo por
     `String(v).trim()`. */
  const linhas = linhasEmObjetos(await readSheet(fs.readFileSync(CAMINHO)));
  console.log(`├─ ${linhas.length} linhas na planilha`);

  /* Leitor pelo perfil — mesma resolução de cabeçalho da API. */
  const lerCampo = (bruto) => {
    const porChave = new Map();
    for (const [k, v] of Object.entries(bruto)) porChave.set(chaveColuna(k), v);
    return (campo) => {
      for (const alias of MAPA[campo] ?? []) {
        const v = porChave.get(chaveColuna(alias));
        if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
      }
      return null;
    };
  };

  /* ── Passo 1: agrupar por precatório ─────────────────────────────────
     É aqui que a semântica do valor é resolvida: o precatório tem UM valor, e
     as partes dividem. Fazer isso antes de tocar no banco também deixa a
     simulação contar exatamente o que a gravação faria. */
  const porPrecatorio = new Map();
  let ignoradas = 0;
  const motivos = {};

  for (const bruta of linhas) {
    const campo = lerCampo(bruta);
    const cpf = soDigitos(campo('cpf'));
    const nome = campo('nome');
    const numero = campo('processo');

    const recusar = (m) => { ignoradas++; motivos[m] = (motivos[m] ?? 0) + 1; };
    if (!numero) { recusar('sem número de precatório'); continue; }
    if (!nome) { recusar('sem nome'); continue; }
    if (!cpfValido(cpf)) { recusar(cpf.length === 14 ? 'CNPJ (não é pessoa física)' : 'CPF inválido'); continue; }

    if (!porPrecatorio.has(numero)) {
      porPrecatorio.set(numero, {
        numero,
        valor: valorDe(campo('valor')),
        originario: campo('originario'),
        requisitorio: campo('requisitorio'),
        entidade: campo('entidade'),
        natureza: campo('natureza'),
        vara: campo('vara'),
        situacao: campo('situacao'),
        partes: new Map(),
      });
    }
    /* Map por CPF: o mesmo credor repetido na mesma linha de precatório é uma
       parte só, não duas. */
    porPrecatorio.get(numero).partes.set(cpf, nome.trim());
  }

  const precatorios = [...porPrecatorio.values()];
  const totalPartes = precatorios.reduce((s, p) => s + p.partes.size, 0);
  const cpfsUnicos = new Set(precatorios.flatMap((p) => [...p.partes.keys()]));
  const somaPrecatorios = precatorios.reduce((s, p) => s + (p.valor ?? 0), 0);
  const comVariosCredores = precatorios.filter((p) => p.partes.size > 1).length;

  console.log('├─────────────────────────────');
  console.log(`├─ precatórios distintos ..: ${precatorios.length}`);
  console.log(`├─   com +1 credor ........: ${comVariosCredores} (valor será dividido)`);
  console.log(`├─ vínculos parte↔processo : ${totalPartes}`);
  console.log(`├─ CPFs distintos .........: ${cpfsUnicos.size}`);
  console.log(`├─ soma dos precatórios ...: ${brl(somaPrecatorios)}`);
  if (ignoradas > 0) {
    console.log(`├─ linhas ignoradas .......: ${ignoradas}`);
    for (const [m, n] of Object.entries(motivos)) console.log(`├─     ${m}: ${n}`);
  }

  /* Quanto disso já existe no banco — a carga é idempotente, então rodar de novo
     deve mostrar "novos: 0". */
  const jaExistem = await prisma.processo.count({
    where: { tribunalId: tribunal.id, numeroPrecatorio: { in: precatorios.map((p) => p.numero) } },
  });
  const cpfsJa = await prisma.pessoa.count({ where: { cpf: { in: [...cpfsUnicos] } } });
  console.log(`├─ já no banco ............: ${jaExistem} precatório(s), ${cpfsJa} pessoa(s)`);
  console.log(`├─ entrariam NOVOS ........: ${precatorios.length - jaExistem} precatório(s), ${cpfsUnicos.size - cpfsJa} pessoa(s)`);

  if (!GRAVAR) {
    console.log('└─ SIMULAÇÃO: nada foi gravado. Repita com --sim para gravar.');
    return;
  }

  /* ── Passo 2: gravar ──────────────────────────────────────────────── */
  const FONTE = `${tribunal.sigla} — ${perfil.nome} ${EXERCICIO}`;
  let procCriados = 0, procAtualizados = 0, pessoasCriadas = 0, vinculos = 0;

  for (const [i, p] of precatorios.entries()) {
    const chave = { tribunalId_numeroPrecatorio: { tribunalId: tribunal.id, numeroPrecatorio: p.numero } };
    const dados = {
      numeroOriginario: p.originario,
      numeroRequisitorio: p.requisitorio,
      entidadeDevedora: p.entidade,
      natureza: p.natureza,
      vara: p.vara,
      situacao: p.situacao,
      valor: p.valor,
    };

    const atual = await prisma.processo.findUnique({ where: chave, select: { id: true } });
    let processoId;
    if (atual) {
      await prisma.processo.update({ where: chave, data: dados });
      processoId = atual.id;
      procAtualizados++;
    } else {
      const novo = await prisma.$transaction(async (tx) => {
        const criado = await tx.processo.create({
          data: {
            ...dados,
            numeroPrecatorio: p.numero,
            tribunalId: tribunal.id,
            organizationId: org.id,
            exercicio: EXERCICIO,
            fonte: FONTE,
          },
          select: { id: true },
        });
        /* Marco inicial da timeline. Sem nome de arquivo: `descricao` é texto
           livre numa tabela append-only e nome de arquivo costuma conter nome e
           CPF do requerente. */
        await tx.eventoProcesso.create({
          data: { processoId: criado.id, tipo: 'IMPORTADO', descricao: 'Processo importado para a carteira' },
        });
        return criado;
      });
      processoId = novo.id;
      procCriados++;
    }

    /* A divisão. Ver a nota no cabeçalho: igualitária, e exata quando há um
       credor só. Arredondada a centavos. */
    const quota = p.valor === null ? null : Math.round((p.valor / p.partes.size) * 100) / 100;

    for (const [cpf, nome] of p.partes) {
      const pes = await prisma.pessoa.findUnique({ where: { cpf }, select: { id: true } });
      let pessoaId;
      if (pes) {
        pessoaId = pes.id;
      } else {
        const nova = await prisma.pessoa.create({
          data: { cpf, nome, nomeNormalizado: normalizarNome(nome) },
          select: { id: true },
        });
        pessoaId = nova.id;
        pessoasCriadas++;
      }

      await prisma.processoPessoa.upsert({
        where: { processoId_pessoaId: { processoId, pessoaId } },
        create: { processoId, pessoaId, papel: 'REQUERENTE', valorIndividual: quota },
        update: { valorIndividual: quota },
      });
      vinculos++;
    }

    if ((i + 1) % 500 === 0) console.log(`│  ${i + 1}/${precatorios.length}…`);
  }

  console.log('├─────────────────────────────');
  console.log(`├─ processos criados .....: ${procCriados}`);
  console.log(`├─ processos atualizados .: ${procAtualizados}`);
  console.log(`├─ pessoas criadas .......: ${pessoasCriadas}`);
  console.log(`├─ vínculos gravados .....: ${vinculos}`);

  const totalGeral = await prisma.processo.count();
  const totalPessoas = await prisma.pessoa.count();
  const soma = await prisma.processoPessoa.aggregate({ _sum: { valorIndividual: true } });
  console.log(`├─ BASE AGORA: ${totalGeral} processos · ${totalPessoas} pessoas`);
  console.log(`└─ soma dos vínculos: ${brl(soma._sum.valorIndividual ?? 0)}`);
})()
  .catch((e) => { console.error('\nFALHOU:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
