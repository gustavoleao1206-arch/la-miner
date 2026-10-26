#!/usr/bin/env node
/**
 * O PORTÃO DE VULNERABILIDADES — com aceites nomeados, datados e justificados.
 *
 * ── POR QUE ISTO EXISTE, EM VEZ DE `npm audit --audit-level=high` DIRETO ──
 *
 * O comando cru saía com erro em TODO push por causa de UM aviso conhecido, que
 * já tinha sido investigado e aceito por escrito — o js-yaml puxado pelo
 * @nestjs/swagger, corrigido em 17/08/2026 pelo bump para a 11.4.7, que passou a
 * apontar para js-yaml 5.3.0. Um portão permanentemente vermelho é pior que portão nenhum:
 * ele ensina a equipe a ignorar o sinal, e no dia em que aparecer uma
 * vulnerabilidade DE VERDADE ninguém vai olhar — ela chega no meio de um ruído
 * que todo mundo já aprendeu a passar por cima.
 *
 * Aqui o portão fica verde para o que já foi decidido e VERMELHO para tudo o
 * mais. Aceitar passa a ser um ato explícito: entra na lista abaixo, com nome,
 * data e motivo, e some sozinho quando a dependência for corrigida.
 *
 * ── O QUE ESTE SCRIPT NÃO FAZ ──
 *
 * Não silencia por pacote nem por severidade: o aceite é por AVISO (o GHSA), que
 * é a prática das ferramentas do ramo (`npm audit --exclude`, allowlist do
 * audit-ci, ignores do Snyk).
 *
 * ⚠ ATÉ 17/08/2026 ESTE PARÁGRAFO PROMETIA MAIS DO QUE O CÓDIGO ENTREGA. Ele
 * dizia que o aceite "só vale enquanto o CAMINHO até ele for o mesmo" e que o
 * portão fecharia se a dependência mudasse. O filtro lá embaixo compara apenas
 * `a.aviso === g.aviso` — nunca comparou caminho. Se o mesmo GHSA voltasse por
 * outra dependência, agora DE PRODUÇÃO (onde "o Swagger está desligado" não
 * protege nada), o aceite casaria igual e o portão seguiria verde.
 *
 * Corrigi o texto em vez de implementar a promessa: com a lista VAZIA o defeito
 * é inalcançável, e escrever casamento de caminho sem nenhuma entrada que o
 * exercite é código especulativo — o tipo que ninguém testa e todo mundo confia.
 * Quem for adicionar o próximo aceite e quiser a garantia de caminho: o dado
 * necessário existe e está sendo descartado — `gravesDe` recebe `v.effects`
 * (para o js-yaml era `["@nestjs/swagger"]`) e o cruzamento seria com `a.via`.
 * Comparar `a.pacote` NÃO serve: o pacote vulnerável não muda quando o caminho
 * muda.
 */
const { execSync } = require('node:child_process');

/**
 * Avisos aceitos, com prazo de validade prático: cada um sai daqui sozinho
 * quando a dependência subir. Se um aceite deixar de casar, o portão fecha e
 * alguém precisa decidir de novo — que é exatamente o comportamento desejado.
 */
const ACEITOS = [
  /* VAZIA, e isso é o estado saudável. O único aceite que já existiu — js-yaml
     (GHSA-pm4m-ph32-ghv5) via @nestjs/swagger — saiu em 17/08/2026, quando o
     bump para a 11.4.7 trocou a dependência para js-yaml 5.3.0, fora da faixa
     5.0.0–5.2.1. O `npm audit --omit=dev` passou a dizer "found 0
     vulnerabilities".

     Um aceite aqui é dívida com data: enquanto ele existe, o portão está verde
     por decisão, não por ausência de risco. O modelo de preenchimento está no
     histórico do git (commit desta remoção), com os campos que a linha de baixo
     espera: aviso, pacote, via, aceitoEm e porque. */
];

const GRAVES = new Set(['high', 'critical']);

function auditar() {
  try {
    /* `npm audit` sai com código != 0 quando ACHA algo — que é o caso normal
       aqui. O JSON vem no stdout mesmo assim, então o erro é esperado e o que
       importa é o corpo. */
    return JSON.parse(
      /* `execSync` com a linha inteira, e não `execFileSync` com lista.
         Duas tentativas anteriores falharam e vale registrar: `execFileSync`
         com `shell: true` dispara o DEP0190 do Node (argumentos concatenados
         sem escape) — um portão de segurança que emite alerta de segurança é
         piada de mau gosto; e `execFileSync('npm.cmd', [...])` sem shell dá
         EINVAL no Node 24, que passou a recusar spawn de `.cmd` sem shell.
         Aqui não há interpolação nenhuma: o comando é literal, fixo, sem uma
         única variável dentro. */
      execSync('npm audit --omit=dev --json', {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } catch (e) {
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

/** Todos os avisos GRAVES, achatados: um pacote pode carregar mais de um. */
function gravesDe(relatorio) {
  const achados = [];
  for (const [pacote, v] of Object.entries(relatorio.vulnerabilities ?? {})) {
    for (const origem of v.via ?? []) {
      /* `via` traz string (vulnerável POR CAUSA de outro pacote) ou objeto (o
         aviso em si). Só o objeto é um aviso de verdade; a string é caminho. */
      if (typeof origem !== 'object') continue;
      if (!GRAVES.has(origem.severity)) continue;
      achados.push({
        pacote,
        aviso: (origem.url ?? '').split('/').pop() || origem.source,
        titulo: origem.title,
        severidade: origem.severity,
      });
    }
  }
  return achados;
}

const relatorio = auditar();
const graves = gravesDe(relatorio);
const naoAceitos = graves.filter((g) => !ACEITOS.some((a) => a.aviso === g.aviso));
const aceitosVistos = new Set(graves.map((g) => g.aviso));

for (const g of naoAceitos) {
  console.error(`✗ ${g.severidade.toUpperCase()}  ${g.pacote} — ${g.titulo}`);
  console.error(`  ${g.aviso}`);
}

for (const a of ACEITOS) {
  if (aceitosVistos.has(a.aviso)) {
    console.log(`· aceito desde ${a.aceitoEm}: ${a.pacote} (${a.aviso}), via ${a.via}`);
  } else {
    /* ACEITE MORTO: a vulnerabilidade sumiu, e a linha na lista virou permissão
       que ninguém precisa mais. Avisa em vez de deixar apodrecer — é assim que
       uma lista de exceções deixa de crescer para sempre. */
    console.log(`· aceite obsoleto (pode sair da lista): ${a.pacote} (${a.aviso})`);
  }
}

if (naoAceitos.length > 0) {
  console.error(
    `\n${naoAceitos.length} vulnerabilidade(s) grave(s) NÃO aceita(s) em dependências de produção.\n` +
      'Corrija, ou acrescente um aceite em scripts/auditoria-producao.js com nome, data e motivo.',
  );
  process.exit(1);
}

console.log(`\nNenhuma vulnerabilidade grave não aceita. (${graves.length} grave(s) no total, ${ACEITOS.length} aceita(s).)`);
