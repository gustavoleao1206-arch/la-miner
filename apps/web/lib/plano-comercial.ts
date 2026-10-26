import { API_URL } from '@/lib/config';

/**
 * O plano que o site vende — um só, por decisão de produto.
 *
 * ── POR QUE UM MÓDULO, E NÃO A BUSCA REPETIDA EM CADA PÁGINA ──
 *
 * A landing e o cadastro precisam do MESMO plano, e precisam concordar: se a
 * vitrine anuncia um preço e o formulário envia outro `planoId`, o cliente
 * assina uma coisa e paga outra. Duas cópias da mesma busca divergem no
 * primeiro ajuste — foi exatamente o que aconteceu com `colunas-planilha.ts`
 * no importador, e a lição custou uma migration de correção.
 */

export type PlanoComercial = {
  id: string;
  nome: string;
  descricao: string | null;
  processosPorCiclo: number;
  precoCentavos: number;
  intervaloMeses: number;
};

/**
 * Busca TODOS os planos da vitrine, do mais barato ao mais caro. NUNCA lança.
 *
 * A landing tem uma função antes de vender: existir. API fora do ar ou tabela
 * vazia devolvem `null`, e as páginas caem no caminho de contato — que continua
 * sendo uma venda, só que por e-mail.
 */
export async function buscarPlanosComerciais(): Promise<PlanoComercial[]> {
  try {
    /* `/v1` NÃO é opcional: a API é versionada e `API_URL` termina em `/api`.
       Sem ele a resposta é 404 — e como esta função engole erro por desenho, o
       sintoma era a página dizer "plano sob consulta" para um plano que
       existia. Um defeito que a robustez escondeu, e que só apareceu ao abrir
       a página de verdade. O painel monta a URL igual, em `lib/api.ts`. */
    const r = await fetch(`${API_URL}/v1/planos`, { next: { revalidate: 300 } });
    if (!r.ok) return [];

    /* A vitrine mostra TUDO que está ativo — desde 19/08/2026, quando o plano
       anual entrou. Ativar/desativar plano no banco é o que decide o que se
       vende; o site apenas obedece. O aviso de "plano invisível" que morava
       aqui morreu junto com a regra de mostrar só o primeiro. */
    return (await r.json()) as PlanoComercial[];
  } catch {
    return [];
  }
}

/**
 * Resolve o plano ESCOLHIDO (via ?plano= do cadastro) dentro do catálogo.
 * Id desconhecido cai no primeiro — nunca num formulário sem preço.
 */
export function planoEscolhido(
  planos: PlanoComercial[],
  planoId?: string,
): PlanoComercial | null {
  if (planos.length === 0) return null;
  return planos.find((p) => p.id === planoId) ?? planos[0];
}

/** Quantos % o plano economiza sobre 12x o MENSAL mais barato do catálogo. */
export function descontoSobreMensal(
  planos: PlanoComercial[],
  plano: PlanoComercial,
): number | null {
  if (plano.intervaloMeses <= 1) return null;
  const mensal = planos.find((p) => p.intervaloMeses === 1);
  if (!mensal) return null;
  const cheio = mensal.precoCentavos * plano.intervaloMeses;
  if (cheio <= 0 || plano.precoCentavos >= cheio) return null;
  /* Piso, nunca arredondamento para cima: anunciar 21% quando é 20,4% é
     propaganda enganosa; anunciar 20% quando é 20,4% é honestidade barata. */
  return Math.floor(((cheio - plano.precoCentavos) / cheio) * 100);
}

/** "R$ 799" quando redondo, "R$ 799,90" quando houver centavos. */
export function reais(centavos: number): string {
  const temCentavos = centavos % 100 !== 0;
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: temCentavos ? 2 : 0,
    maximumFractionDigits: temCentavos ? 2 : 0,
  });
}

/** O endereço público de contato, num lugar só. */
export const CONTATO = 'contato@leaoamorimtecnologia.com.br';
