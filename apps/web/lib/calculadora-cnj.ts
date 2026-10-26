'use client';

/**
 * A calculadora oficial do CNJ (SISPREQ), chamada DIRETO DO NAVEGADOR.
 *
 * ── POR QUE DAQUI, E NÃO DA NOSSA API ──
 *
 * Não foi preferência: foi medido. O gateway do CNJ bloqueia IP estrangeiro —
 * sonda de 19/08/2026 em seis países: Brasil 200, EUA/Alemanha/Hungria/
 * Indonésia/Sérvia 403 Forbidden. Nossa API mora na Render (EUA) e NUNCA vai
 * alcançá-lo; a primeira versão desta funcionalidade proxiava pelo servidor e
 * falhou em produção exatamente assim. O navegador do usuário está no Brasil.
 *
 * E o caminho é sancionado pelo próprio CNJ: o gateway responde CORS refletindo
 * qualquer origem (`Access-Control-Allow-Origin: https://app.laminer.com.br`,
 * medido) — é assim que a calculadora pública deles funciona para qualquer
 * cidadão.
 *
 * ── O QUE NUNCA SAI DAQUI ──
 *
 * Nenhum dado pessoal, e nem o NÚMERO do precatório. Só valor e datas. Além de
 * regra de privacidade, aqui é também praticidade: a requisição sai da máquina
 * do usuário, e o que o CNJ loga do outro lado não está sob nosso controle.
 *
 * `selicAcumulada: 0` NÃO é "sem SELIC" — é "use a sua série": medido em
 * produção, com 0 o motor aplica a SELIC oficial e troca sozinho para
 * "2% a.a + IPCA" a partir de set/2025 (EC 136/25).
 */

export type EsferaCnj = 'FEDERAL' | 'ESTADUAL' | 'MUNICIPAL';

export interface PedidoSaldoCnj {
  valorPrincipal: number;
  /** AAAA-MM-DD */
  dataBase: string;
  /** AAAA-MM-DD */
  dataProtocolo: string;
  exercicio?: string;
  esfera: EsferaCnj;
  tributario?: boolean;
}

export interface SaldoOficialCnj {
  fonte: 'SISPREQ';
  valorBase: number;
  dataBase: string;
  dataFinal: string;
  saldoAtualizado: number;
  correcao: number;
  juros: number;
  selic: number;
  indices: { nome: string; dataInicio: string; dataFinal: string; percentual: number }[];
  legislacoes: string[];
  serieAtualizadaAte: string | null;
}

const GATEWAY = 'https://gateway.cloud.pje.jus.br/sispreq';

export async function calcularSaldoOficial(pedido: PedidoSaldoCnj): Promise<SaldoOficialCnj> {
  const hoje = new Date().toISOString().slice(0, 10);
  if (pedido.dataBase > hoje) {
    throw new Error('A data-base não pode estar no futuro.');
  }

  let resposta: Response;
  try {
    resposta = await fetch(`${GATEWAY}/api/v1/publico/calculadora-saldo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        classeRequisicao: 'PRC',
        tributario: pedido.tributario ?? false,
        valorPrincipal: pedido.valorPrincipal,
        dataBase: pedido.dataBase,
        dataFinal: hoje,
        dataProtocolo: pedido.dataProtocolo,
        ...(pedido.exercicio ? { exercicio: pedido.exercicio } : {}),
        selicAcumulada: 0,
        jurosCompensatorios: 0,
        jurosMoratorios: 0,
        possuiSuperpreferencia: false,
        esfera: pedido.esfera,
        descontos: [],
      }),
      /* 15s: infraestrutura pública tem dias lentos. Mais que isso, melhor
         falhar claro do que segurar a tela. */
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('A calculadora oficial do CNJ não respondeu. Tente novamente em instantes.');
  }

  if (!resposta.ok) {
    throw new Error('A calculadora oficial do CNJ não respondeu. Tente novamente em instantes.');
  }

  const dados = (await resposta.json().catch(() => null)) as {
    dataAtualizacao?: string | null;
    valoresCalculadora?: {
      totalRequisitadoAtualizado?: number;
      creditos?: { correcao?: number; juros?: number; selic?: number }[];
    };
    configuracoesCalculo?: {
      nome?: string;
      dataInicio?: string;
      dataFinal?: string;
      percentual?: number;
    }[];
    legislacoesCalculo?: string[];
  } | null;

  const saldo = dados?.valoresCalculadora?.totalRequisitadoAtualizado;
  /* Contrato mudou = erro ALTO, nunca zero: um saldo `0` silencioso viraria
     "este crédito não vale nada" impresso numa proposta. */
  if (typeof saldo !== 'number' || !Number.isFinite(saldo)) {
    throw new Error('A calculadora oficial respondeu num formato inesperado. Avise o suporte.');
  }

  const soma = (campo: 'correcao' | 'juros' | 'selic') =>
    (dados?.valoresCalculadora?.creditos ?? []).reduce((s, c) => s + (c[campo] ?? 0), 0);

  return {
    fonte: 'SISPREQ',
    valorBase: pedido.valorPrincipal,
    dataBase: pedido.dataBase,
    dataFinal: hoje,
    saldoAtualizado: saldo,
    correcao: soma('correcao'),
    juros: soma('juros'),
    selic: soma('selic'),
    indices: (dados?.configuracoesCalculo ?? []).map((c) => ({
      nome: c.nome ?? '?',
      dataInicio: c.dataInicio ?? '',
      dataFinal: c.dataFinal ?? '',
      percentual: c.percentual ?? 0,
    })),
    legislacoes: dados?.legislacoesCalculo ?? [],
    serieAtualizadaAte: dados?.dataAtualizacao ?? null,
  };
}
