import { describe, it, expect, vi, afterEach } from 'vitest';
import { calcularSaldoOficial } from '@/lib/calculadora-cnj';

/**
 * O CONTRATO com o gateway do CNJ, nos dois sentidos — com o fetch dublado.
 *
 * A resposta usada aqui é a REAL de produção (medida em 18/08/2026), reduzida
 * aos campos lidos. O gateway de verdade nunca é chamado: teste que depende de
 * infraestrutura do governo estar de pé não é teste, é loteria.
 */

const RESPOSTA_REAL = {
  dataAtualizacao: '2026-07-31',
  valoresCalculadora: {
    totalRequisitadoAtualizado: 120997.31101508677,
    creditos: [{ correcao: 4558.005097365091, juros: 1916.874454410606, selic: 14522.431463311083 }],
  },
  configuracoesCalculo: [
    { nome: 'Selic', dataInicio: '2024-07-01', dataFinal: '2025-08-29', percentual: 13.889354 },
    { nome: '2% a.a + IPCA', dataInicio: '2025-09-01', dataFinal: '2026-07-31', percentual: 6.30328 },
  ],
  legislacoesCalculo: ['RESOLUCAO_303', 'EC_136_25'],
};

const PEDIDO = {
  valorPrincipal: 100000,
  dataBase: '2024-07-01',
  dataProtocolo: '2024-08-15',
  exercicio: '2027',
  esfera: 'FEDERAL' as const,
};

const resposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('calcularSaldoOficial — o contrato com o gateway do CNJ', () => {
  it('mapeia a resposta real de produção', async () => {
    const fetchFalso = vi.fn(async () => resposta(200, RESPOSTA_REAL));
    vi.stubGlobal('fetch', fetchFalso);

    const r = await calcularSaldoOficial(PEDIDO);

    expect(r.saldoAtualizado).toBeCloseTo(120997.31, 2);
    expect(r.correcao).toBeCloseTo(4558.01, 2);
    expect(r.selic).toBeCloseTo(14522.43, 2);
    /* A troca de regime da EC 136/25 atravessa o mapeamento — é o que faz o
       memorial ser defensável na proposta. */
    expect(r.indices[1].nome).toBe('2% a.a + IPCA');
    expect(r.legislacoes).toContain('EC_136_25');
    expect(r.serieAtualizadaAte).toBe('2026-07-31');
    expect(r.fonte).toBe('SISPREQ');
  });

  /**
   * ⚠ A ASSERÇÃO DE PRIVACIDADE.
   *
   * O corpo enviado ao CNJ não pode carregar nome, CPF nem o número do
   * precatório. Quem um dia "enriquecer" o pedido quebra este caso e é
   * obrigado a ter a conversa.
   */
  it('não manda dado pessoal nem número de precatório, e delega a série com zeros', async () => {
    const fetchFalso = vi.fn(async () => resposta(200, RESPOSTA_REAL));
    vi.stubGlobal('fetch', fetchFalso);

    await calcularSaldoOficial(PEDIDO);

    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(
      'https://gateway.cloud.pje.jus.br/sispreq/api/v1/publico/calculadora-saldo',
    );
    const corpo = JSON.parse(init.body as string);
    expect(corpo).not.toHaveProperty('numeroRequisicao');
    expect(JSON.stringify(corpo)).not.toMatch(/cpf|nome|credor/i);
    /* Zero = "use a sua série" — medido em produção antes de escrito. */
    expect(corpo.selicAcumulada).toBe(0);
    expect(corpo.jurosCompensatorios).toBe(0);
    expect(corpo.jurosMoratorios).toBe(0);
    expect(corpo.classeRequisicao).toBe('PRC');
  });

  it('gateway fora do ar vira erro claro, nunca um saldo qualquer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resposta(500, {})));
    await expect(calcularSaldoOficial(PEDIDO)).rejects.toThrow(/não respondeu/);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(calcularSaldoOficial(PEDIDO)).rejects.toThrow(/não respondeu/);
  });

  /* Contrato mudou = erro ALTO. Um `undefined` virando 0 em silêncio seria
     "este crédito não vale nada" impresso numa proposta. */
  it('resposta sem saldo é recusada, e não tratada como zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resposta(200, { valoresCalculadora: {} })));
    await expect(calcularSaldoOficial(PEDIDO)).rejects.toThrow(/formato inesperado/);
  });

  it('data-base no futuro é recusada ANTES de qualquer chamada', async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);

    await expect(
      calcularSaldoOficial({ ...PEDIDO, dataBase: '2099-01-01' }),
    ).rejects.toThrow(/futuro/);
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});
