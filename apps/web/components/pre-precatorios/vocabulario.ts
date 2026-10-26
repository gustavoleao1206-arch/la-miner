import type {
  ConferenciaNome,
  EsferaTribunal,
  FaseProcesso,
  TribunalCatalogo,
} from '@/lib/api';

/**
 * O VOCABULÁRIO DO MÓDULO DE PRÉ-PRECATÓRIOS — um lugar só.
 *
 * Os três recortes que a tela oferece (estágio do crédito, esfera da justiça,
 * veredito do CPF) aparecem nos chips, nos cartões e na linha. Três cópias de
 * "Estadual é dourado" divergem na primeira que alguém ajustar — a mesma lição
 * de `carteira/estagios.ts`.
 */

/** As quatro fases do módulo, em ordem CRONOLÓGICA — a ordem em que o crédito anda. */
export const FASES_PRE: FaseProcesso[] = [
  'TRANSITO_EM_JULGADO',
  'CALCULOS_HOMOLOGADOS',
  'REQUISITORIO_EXPEDIDO',
  'PRECATORIO_AUTUADO',
];

/** `SUPERIOR` existe no enum e não tem processo; fora dos chips de propósito. */
export const ORDEM_ESFERAS: EsferaTribunal[] = ['FEDERAL', 'ESTADUAL', 'TRABALHISTA'];

/**
 * A esfera é IDENTIDADE, não magnitude: uma cor por esfera, fixa, sempre a
 * mesma. E a cor nunca é o único canal — a sigla (TRF, TJ, TRT) diz a mesma
 * coisa em texto, e o `title` traz o nome inteiro do tribunal.
 */
export const ESFERA: Record<EsferaTribunal, { rotulo: string; ponto: string }> = {
  FEDERAL: { rotulo: 'Justiça Federal', ponto: 'bg-marca-azul' },
  ESTADUAL: { rotulo: 'Justiça Estadual', ponto: 'bg-marca-ouro' },
  TRABALHISTA: { rotulo: 'Justiça do Trabalho', ponto: 'bg-marca-ciano' },
  SUPERIOR: { rotulo: 'Tribunal Superior', ponto: 'bg-muted' },
};

/** O nome CURTO, para o chip: "Federal", não "Justiça Federal". */
export const ESFERA_CURTA: Record<EsferaTribunal, string> = {
  FEDERAL: 'Federal',
  ESTADUAL: 'Estadual',
  TRABALHISTA: 'Trabalhista',
  SUPERIOR: 'Superior',
};

export const ORDEM_CONFERENCIAS: ConferenciaNome[] = ['CONFERE', 'DIVERGE', 'NAO_CONFERIDO'];

/**
 * Os três vereditos como CHIP (grupo), e o ÚNICO lugar onde eles ainda aparecem
 * na tela: o selo por linha saiu em 20/09/2026. Só a operação interna vê estes
 * chips. A cor segue o peso de cada veredito: verde para o que confere, âmbar
 * para a evidência contra, neutro para a falta de evidência.
 */
export const CONFERENCIA: Record<ConferenciaNome, { chip: string; ativo: string }> = {
  CONFERE: { chip: 'CPF confere', ativo: 'border-ok/40 bg-ok/10 text-ok' },
  DIVERGE: { chip: 'CPF a conferir', ativo: 'border-alerta/40 bg-alerta/10 text-alerta' },
  NAO_CONFERIDO: {
    chip: 'CPF não conferido',
    ativo: 'border-linha-2 bg-superficie-2 text-ink',
  },
};

/**
 * O tribunal da linha, resolvido pelo CATÁLOGO — nome inteiro e esfera exata.
 *
 * O catálogo já está carregado para o painel inteiro (`useLote`), então isto
 * não custa uma requisição. E é resolvido, não adivinhado pelo prefixo da
 * sigla: "TJ" quase sempre é estadual, mas o catálogo é quem sabe.
 *
 * `undefined` antes de o catálogo chegar — a linha mostra só a sigla, que já
 * diz o essencial.
 */
export function tribunalDoCatalogo(
  catalogo: TribunalCatalogo[],
  sigla: string,
): { nome: string; esfera: EsferaTribunal | undefined } | undefined {
  const t = catalogo.find((c) => c.sigla === sigla);
  if (!t) return undefined;
  const esfera = (Object.keys(ESFERA) as EsferaTribunal[]).find((e) => e === t.esfera);
  return { nome: t.nome, esfera };
}
