import { BadRequestException, Logger } from '@nestjs/common';

import { AsaasProvider } from './asaas.provider';

/**
 * O ADAPTADOR do Asaas, com o fetch dublado — o pedaço que nenhum teste de
 * integração alcança, porque lá o gateway é sempre um dublê inteiro.
 *
 * O que se fixa: o CORPO enviado ao criar a cobrança (billingType delegado,
 * callback de volta ao site) e a tradução dos eventos de webhook — inclusive
 * os que NÃO mudam estado, que precisam virar `null` e nunca um chute.
 */

const configDe = (valores: Record<string, string>) =>
  ({
    get: (chave: string, padrao?: unknown) => valores[chave] ?? padrao,
    getOrThrow: (chave: string) => {
      if (valores[chave] === undefined) throw new Error(`config ausente: ${chave}`);
      return valores[chave];
    },
  }) as never;

const CONFIG = configDe({
  ASAAS_API_KEY: '$aact_hmlg_chave-de-teste',
  WEB_URL: 'https://app.laminer.com.br',
});

function fetchQueDevolve(status: number, corpo: unknown) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo),
  })) as unknown as typeof fetch;
}

/** Uma resposta DIFERENTE por chamada, na ordem — para exercitar a repetição. */
function fetchEmSequencia(respostas: { status: number; corpo: unknown }[]) {
  let i = 0;
  return jest.fn(async () => {
    const r = respostas[Math.min(i++, respostas.length - 1)];
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.corpo) };
  }) as unknown as typeof fetch;
}

const PEDIDO = {
  clienteExternoId: 'cus_1',
  valor: 7670,
  vencimentoEm: new Date(Date.UTC(2026, 8, 1)),
  descricao: 'Miner 250 Anual — setembro/2026',
  referencia: 'fatura-uuid-1',
} as never;

/** O erro exato do Asaas quando a conta não tem domínio e mandamos callback. */
const SEM_DOMINIO = {
  errors: [
    {
      code: 'invalid_callback',
      description:
        'Não há nenhum domínio configurado em sua conta. Cadastre um site em Minha Conta na aba Informações.',
    },
  ],
};

describe('AsaasProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('a cobrança nasce com o caminho de VOLTA — o callback para o site', async () => {
    const fetchFalso = fetchQueDevolve(200, { id: 'pay_1', invoiceUrl: 'https://asaas/i/1' });
    global.fetch = fetchFalso;

    const r = await new AsaasProvider(CONFIG).emitirCobranca({
      clienteExternoId: 'cus_1',
      valor: 7670,
      vencimentoEm: new Date(Date.UTC(2026, 8, 1)),
      descricao: 'Miner 250 Anual — setembro/2026',
      referencia: 'fatura-uuid-1',
    } as never);

    const [url, init] = (fetchFalso as unknown as jest.Mock).mock.calls[0];
    /* Chave de homologação = sandbox, derivado do PREFIXO — nunca de env solta. */
    expect(String(url)).toBe('https://api-sandbox.asaas.com/v3/payments');

    const corpo = JSON.parse((init as RequestInit).body as string);
    /* Sem callback, quem paga termina numa tela do Asaas sem porta de saída. */
    expect(corpo.callback).toEqual({
      successUrl: 'https://app.laminer.com.br/login?pagamento=confirmado',
      autoRedirect: true,
    });
    /* UNDEFINED delega ao painel do Asaas QUAIS meios aparecem (PIX, boleto,
       cartão) — o código não decide isso. */
    expect(corpo.billingType).toBe('UNDEFINED');
    expect(corpo.externalReference).toBe('fatura-uuid-1');
    expect(r.idExterno).toBe('pay_1');
    expect(r.urlPagamento).toBe('https://asaas/i/1');
  });

  /**
   * ── A REGRESSÃO DE 19/08/2026, FIXADA ──
   *
   * O `callback` derrubou a emissão inteira em produção: conta sem domínio
   * cadastrado + successUrl apontando para localhost (WEB_URL não declarada na
   * Render) = 400 na cara de quem clicou em "Gerar cobrança". Trocar receita
   * por um redirecionamento é o pior negócio possível.
   */
  describe('quando o Asaas recusa o callback', () => {
    it('repete SEM o callback e a cobrança abre — o retorno é que se perde, não o dinheiro', async () => {
      const avisos = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const fetchFalso = fetchEmSequencia([
        { status: 400, corpo: SEM_DOMINIO },
        { status: 200, corpo: { id: 'pay_2', invoiceUrl: 'https://asaas/i/2' } },
      ]);
      global.fetch = fetchFalso;

      const r = await new AsaasProvider(CONFIG).emitirCobranca(PEDIDO);

      const chamadas = (fetchFalso as unknown as jest.Mock).mock.calls;
      expect(chamadas).toHaveLength(2);

      const primeira = JSON.parse((chamadas[0][1] as RequestInit).body as string);
      const segunda = JSON.parse((chamadas[1][1] as RequestInit).body as string);
      /* A PRIMEIRA tenta com o retorno; a SEGUNDA larga exatamente ele — e nada
         mais. Se algum campo obrigatório sumisse junto, a cobrança nasceria
         torta em silêncio. */
      expect(primeira.callback).toBeDefined();
      expect(segunda.callback).toBeUndefined();
      expect(segunda).toEqual({ ...primeira, callback: undefined });

      /* O que importa para o negócio: a cobrança EXISTE e tem link de pagamento. */
      expect(r.idExterno).toBe('pay_2');
      expect(r.urlPagamento).toBe('https://asaas/i/2');

      /* E ninguém fica sabendo por acaso: o WARN diz o que consertar no painel. */
      expect(avisos).toHaveBeenCalledTimes(1);
      expect(avisos.mock.calls[0][0]).toContain('Minha Conta');
    });

    it('se falhar TAMBÉM sem o callback, o erro sobe — nada é engolido', async () => {
      global.fetch = fetchQueDevolve(400, {
        errors: [{ description: 'CPF/CNPJ inválido' }],
      });

      await expect(new AsaasProvider(CONFIG).emitirCobranca(PEDIDO)).rejects.toThrow(
        /CPF\/CNPJ inválido/,
      );
    });

    it('401 não vira repetição: chave errada não se conserta tentando de novo', async () => {
      const fetchFalso = fetchQueDevolve(401, { errors: [{ description: 'Chave inválida' }] });
      global.fetch = fetchFalso;

      await expect(new AsaasProvider(CONFIG).emitirCobranca(PEDIDO)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect((fetchFalso as unknown as jest.Mock).mock.calls).toHaveLength(1);
    });
  });

  it('eventos que não mudam estado viram null — análise de risco não libera nada', () => {
    const provider = new AsaasProvider(CONFIG);
    for (const event of [
      'PAYMENT_AWAITING_RISK_ANALYSIS',
      'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
      'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
      'PAYMENT_PARTIALLY_REFUNDED',
    ]) {
      expect(provider.interpretarEvento({ event, payment: { id: 'pay_9' } })).toBeNull();
    }
  });

  it('cobrança apagada e restaurada no painel viram eventos de verdade', () => {
    const provider = new AsaasProvider(CONFIG);
    /* Antes caíam no ignorado, e a fatura ficava ABERTA para sempre: um botão
       "Pagar" apontando para uma cobrança que não existe mais. */
    expect(provider.interpretarEvento({ event: 'PAYMENT_DELETED', payment: { id: 'pay_9' } })?.tipo).toBe(
      'COBRANCA_REMOVIDA',
    );
    expect(
      provider.interpretarEvento({ event: 'PAYMENT_RESTORED', payment: { id: 'pay_9' } })?.tipo,
    ).toBe('COBRANCA_RESTAURADA');
  });

  it('estorno e chargeback traduzem para PAGAMENTO_ESTORNADO', () => {
    const provider = new AsaasProvider(CONFIG);
    for (const event of ['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED']) {
      expect(provider.interpretarEvento({ event, payment: { id: 'pay_9' } })?.tipo).toBe(
        'PAGAMENTO_ESTORNADO',
      );
    }
  });
});
