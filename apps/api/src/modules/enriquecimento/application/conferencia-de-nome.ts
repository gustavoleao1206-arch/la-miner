/**
 * O NOME DA PLANILHA × O NOME DO TITULAR DO CPF.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Nos pré-precatórios, o CPF não vem de campo estruturado: a própria fonte
 * documenta que "NENHUMA fonte pública devolve documento em campo (…) o número é
 * extraído do texto do despacho e só entra depois de passar no dígito
 * verificador". Dígito verificador válido prova que o número é bem formado —
 * não que ele seja DAQUELE credor. A fonte reconhece o risco ao explicar que
 * descarta o documento quando há mais de um credor no polo ativo: "documento
 * errado ao lado de um nome é pior que documento nenhum".
 *
 * O enriquecimento já resolve isso de graça e jogava fora: a Contactra devolve o
 * nome de quem REALMENTE tem aquele CPF, e o processor recebia esse nome sem
 * usá-lo. Comparar os dois é a diferença entre "titular identificado" ser
 * promessa de marketing e ser um estado que o sistema afirma ou nega.
 *
 * ── POR QUE NÃO SE GUARDA O NOME DO PROVEDOR ──
 *
 * Guardar o segundo nome dobraria a superfície de dado pessoal — e um pedido de
 * exclusão passaria a ter mais um lugar para alcançar. O veredito basta: é ele
 * que a tela mostra e é ele que decide se a abordagem é segura.
 */

/** Ligações que não identificam ninguém e atrapalham a comparação. */
const CONECTIVOS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);

/**
 * Reduz o nome a tokens comparáveis.
 *
 * Sem acento, sem caixa, sem pontuação — "JOSÉ D'ÁVILA" e "Jose D Avila" viram a
 * mesma coisa. Conectivos saem, e tokens de UMA letra também: a planilha às
 * vezes traz inicial abreviada ("M. DA SILVA"), e comparar "M" com "MARIA"
 * produziria divergência onde não há.
 */
export function tokensDoNome(nome: string): string[] {
  return nome
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !CONECTIVOS.has(t));
}

export type VereditoNome = 'CONFERE' | 'DIVERGE' | 'NAO_CONFERIDO';

/**
 * Os dois nomes são da mesma pessoa?
 *
 * ── A REGRA, E POR QUE ELA É FROUXA DE PROPÓSITO ──
 *
 * `CONFERE` quando o PRIMEIRO nome bate e há ao menos um sobrenome em comum.
 *
 * Frouxa porque os dois lados divergem por motivos inocentes o tempo todo: a
 * publicação abrevia ("MARIA A. DOS SANTOS"), o cadastro da Receita traz o nome
 * de solteira, um dos dois corta o último sobrenome. Exigir igualdade marcaria
 * como suspeita metade da base, e um alarme que dispara sempre é um alarme que
 * ninguém lê.
 *
 * O que se quer pegar é o caso GROSSEIRO — o CPF de outra pessoa, colhido do
 * mesmo despacho. Ali os nomes não têm nada a ver um com o outro, e a regra
 * acusa.
 *
 * ── O CASO DO NOME DE UM TOKEN SÓ ──
 *
 * Se um dos lados tem só um nome ("MARIA"), não há sobrenome para comparar.
 * Basta o primeiro bater: é tudo o que a informação disponível permite afirmar,
 * e inventar rigor sobre dado que não existe produziria divergência falsa.
 */
/**
 * Os credores que a célula da planilha lista.
 *
 * ── POR QUE A CÉLULA PRECISA SER PARTIDA ANTES DE COMPARAR ──
 *
 * A planilha de pré-precatórios empilha vários credores numa coluna só,
 * separados por vírgula: "OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER". Medido em
 * 08/09/2026 na base de produção: 192 dos 1.169, um em cada seis.
 *
 * `tokensDoNome` remove pontuação — a vírgula inclusive. Comparar a célula
 * inteira, como se fazia, jogava os sobrenomes de TODOS num saco só, e isso
 * quebrava a regra nas duas direções:
 *
 * 1. FROUXO DEMAIS. Para "OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER", um CPF de
 *    "OTAVIO SANTOS KESSLER" batia: primeiro nome OTAVIO, e KESSLER estava no saco —
 *    só que KESSLER é sobrenome do OUTRO credor. O veredito CONFERE saía de uma
 *    coincidência entre pessoas diferentes.
 * 2. RÍGIDO DEMAIS. `a[0]` era o primeiro token da célula INTEIRA, então só o
 *    primeiro credor listado podia bater. Se o CPF fosse do segundo, o
 *    resultado era DIVERGE — e o processo ia para a lista de bloqueados por um
 *    defeito da comparação, não por um problema no dado.
 *
 * Partir a célula e conferir CADA candidato isoladamente corrige as duas: cada
 * nome é julgado com os próprios sobrenomes, e qualquer um deles pode ser o
 * dono do CPF.
 *
 * Só a vírgula separa. " E " é tentador e não serve: ele já é conectivo dentro
 * de nome, e partir por ele transformaria um credor em dois.
 */
export function candidatosDoNome(daPlanilha: string): string[] {
  return daPlanilha
    .split(',')
    .map((parte) => parte.trim())
    .filter((parte) => tokensDoNome(parte).length > 0);
}

/** A regra de sempre, aplicada a UM candidato. */
function confereComUm(a: string[], b: string[]): boolean {
  if (a[0] !== b[0]) return false;
  if (a.length === 1 || b.length === 1) return true;

  const sobrenomesDeB = new Set(b.slice(1));
  return a.slice(1).some((t) => sobrenomesDeB.has(t));
}

export function conferirNome(daPlanilha: string, doProvedor: string): VereditoNome {
  const b = tokensDoNome(doProvedor);

  /* Sem tokens de um dos lados não há o que comparar, e a resposta honesta é
     `NAO_CONFERIDO`.

     ── ISTO DEVOLVIA `CONFERE` ATÉ 10/09/2026, E ERA CONFIANÇA FABRICADA ──

     O raciocínio antigo estava certo pela metade: ausência de informação
     realmente não é evidência de erro, e `DIVERGE` encheria a tela de alarme
     sobre o nada. Mas `CONFERE` não é o neutro — ele AFIRMA que o CPF é daquela
     pessoa. O neutro tem nome próprio e é este.

     Medido em produção: 41 dos 1.169 pré-precatórios estavam marcados CONFERE
     com nome que não tem um único token comparável — "M.A.V.", "G.F.",
     "T.S.L.D.O.". São iniciais, a forma como o tribunal anonimiza menor de idade
     e segredo de justiça. Nada foi conferido em nenhum deles, e a tela dizia que
     sim.

     `NAO_CONFERIDO` preserva o objetivo original — ele NÃO desenha aviso na
     tela, só o `DIVERGE` desenha — sem afirmar o que ninguém verificou. */
  if (tokensDoNome(daPlanilha).length === 0 || b.length === 0) return 'NAO_CONFERIDO';

  /* Sem vírgula, `candidatos` é a própria célula e o resultado é o de sempre. */
  return candidatosDoNome(daPlanilha).some((c) => confereComUm(tokensDoNome(c), b))
    ? 'CONFERE'
    : 'DIVERGE';
}
