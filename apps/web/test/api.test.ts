import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, enviarPlanilha, estadoImportacao, ErroApi, type DestinoImportacao } from '@/lib/api';

/**
 * O cliente `api()` e — o alvo real — o MUTEX de renovação.
 *
 * O comentário no código descreve o bug que ele evita: quando o access expira,
 * as chamadas paralelas do dashboard recebem 401 ao mesmo tempo; sem a trava,
 * cada uma chamaria o refresh ROTATIVO por conta própria, e as perdedoras
 * derrubariam o token que a vencedora acabou de emitir — logout a cada
 * expiração e "reuso detectado" falso inundando o log de segurança. Testar isso
 * exige forçar a concorrência de forma determinística.
 */

/** Deferred manual: uma promise que só resolve quando EU mandar. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Um dublê de `Response`.
 *
 * `clone()` precisa existir: o `api()` lê o corpo do PRIMEIRO 401 (para levar o
 * motivo até a tela de login) sem consumir o original, e um dublê sem clone
 * derrubava seis casos com "r.clone is not a function" — o teste falhando por
 * falta do dublê, não por defeito do código. O clone devolve outro dublê sobre o
 * MESMO corpo, que é o que a Response de verdade faz.
 */
/* O tipo de retorno é EXPLÍCITO porque a função se referencia no `clone` —
   sem a anotação o TS não consegue inferir e reprova com TS7023. */
const resposta = (status: number, corpo: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
    clone: () => resposta(status, corpo),
  }) as Response;

beforeEach(() => {
  sessionStorage.clear();
  /* Só o ACCESS mora aqui. O refresh vive num cookie httpOnly que este código
     não vê — nem para ler, nem para escrever. Se `miner.refresh` reaparecer no
     storage, o B3 foi desfeito. */
  sessionStorage.setItem('miner.access', 'access-velho');
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api() — caminho feliz', () => {
  it('manda o Bearer e devolve o JSON', async () => {
    // Assinatura explícita (url, init): sem ela o TS tipa mock.calls como tupla
    // vazia e o destructuring de `init` abaixo não compila.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      resposta(200, { ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const dados = await api<{ ok: boolean }>('/carteira/resumo');

    expect(dados).toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer access-velho' });
  });

  /**
   * REGRESSÃO de um bug encontrado conferindo a tela de segurança no navegador.
   *
   * `r.json()` sobre um corpo VAZIO lança. Desativar o MFA responde 204, a
   * chamada estourava com "Unexpected end of JSON input" e a tela mostrava esse
   * erro de parser — só que a operação TINHA funcionado (conferido no banco:
   * segredo nulo). O pior tipo de mensagem, a que assusta e mente.
   */
  it('204 não tem corpo, e isso não pode virar erro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 204,
        /* Como o fetch real se comporta com corpo vazio. */
        json: async () => {
          throw new SyntaxError('Unexpected end of JSON input');
        },
      })) as unknown as typeof fetch,
    );

    await expect(api<void>('/auth/mfa/desativar', { method: 'POST' })).resolves.toBeUndefined();
  });

  /**
   * O 403 de MFA obrigatório precisa chegar DISTINGUÍVEL de um 403 de permissão:
   * a saída de um é cadastrar o segundo fator, a do outro é pedir acesso. Casar
   * por texto de mensagem quebraria na primeira revisão de redação.
   */
  it('403 de MFA obrigatório preserva o código e leva para /seguranca', async () => {
    const location = { href: '', pathname: '/dashboard', search: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resposta(403, { mensagem: 'Este ambiente exige…', erro: 'MFA_OBRIGATORIO' }),
      ),
    );

    await expect(api('/carteira/resumo')).rejects.toMatchObject({
      status: 403,
      codigo: 'MFA_OBRIGATORIO',
    });
    expect(location.href).toBe('/seguranca?obrigatorio=1');
  });

  /**
   * O 402 é a suspensão da assinatura, e ele tem TELA — `/assinatura`, que já
   * diz "regularize a fatura em aberto e o acesso volta exatamente como
   * estava". O que faltava era chegar nela.
   *
   * Sem este desvio o cliente suspenso caía no dashboard, as quatro consultas
   * da carteira tomavam 402 em paralelo e a página ficava em esqueleto para
   * sempre — encontrado no navegador, com o perfil de teste "Queiroz & Lima".
   */
  it('402 de assinatura suspensa leva para /assinatura', async () => {
    const location = { href: '', pathname: '/dashboard', search: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resposta(402, { mensagem: 'Assinatura suspensa ou inativa. Regularize o pagamento…' }),
      ),
    );

    await expect(api('/carteira/resumo')).rejects.toMatchObject({ status: 402 });
    expect(location.href).toBe('/assinatura');
  });

  /**
   * Sem esta guarda haveria LAÇO: a própria `/assinatura` roda o seletor de
   * lote no cabeçalho, que consulta uma rota da carteira e toma 402.
   */
  it('já estando em /assinatura, o 402 não redireciona de novo', async () => {
    const location = { href: '', pathname: '/assinatura', search: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(402, { mensagem: 'Assinatura suspensa' })),
    );

    await expect(api('/carteira/tribunais')).rejects.toMatchObject({ status: 402 });
    expect(location.href).toBe('');
  });

  it('erro não-401 vira ErroApi com a mensagem do backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(400, { mensagem: 'Prioridade inválida.' })),
    );

    await expect(api('/x')).rejects.toThrow(ErroApi);
    await expect(api('/x')).rejects.toMatchObject({ status: 400, message: 'Prioridade inválida.' });
  });
});

describe('api() — renovação transparente', () => {
  it('401 → renova uma vez → repete a chamada com o token novo', async () => {
    let chamadaDoRefresh: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        chamadaDoRefresh = init;
        /* A API só devolve o access: o refresh volta no Set-Cookie, invisível
           para o JavaScript. */
        return resposta(200, { accessToken: 'access-novo' });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      // Token velho → 401; token novo → 200.
      return auth === 'Bearer access-novo'
        ? resposta(200, { dado: 'ok' })
        : resposta(401, { mensagem: 'expirado' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const dados = await api<{ dado: string }>('/carteira/resumo');

    expect(dados).toEqual({ dado: 'ok' });
    expect(chamadaDoRefresh).toBeDefined();

    /**
     * `credentials: 'include'` é o detalhe que faz tudo funcionar — e cuja
     * ausência falha do jeito mais traiçoeiro: o padrão do fetch é
     * `same-origin`, a API está noutra origem, e sem isto o cookie
     * simplesmente não é enviado. Login funcionaria, e a sessão morreria 15
     * minutos depois, sem erro em lugar nenhum.
     */
    expect(chamadaDoRefresh?.credentials).toBe('include');
    // E sem corpo: o token vem do cookie, não de algo que o JS conheça.
    expect(chamadaDoRefresh?.body).toBeUndefined();

    expect(sessionStorage.getItem('miner.access')).toBe('access-novo');
    // O refresh NÃO pode ter sido guardado em lugar algum acessível ao JS.
    expect(sessionStorage.getItem('miner.refresh')).toBeNull();
  });

  it('refresh recusado pelo servidor → limpa a sessão e joga para /login', async () => {
    /* Agora quem decide se existe sessão é o SERVIDOR, não o storage local: o
       front não enxerga mais o cookie e, portanto, não tem como saber de
       antemão. Um 401 no próprio /auth/refresh é a resposta. */
    // jsdom estoura ao navegar de verdade; um objeto simples captura o destino.
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(401, { mensagem: 'expirado' })),
    );

    await expect(api('/x')).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem('miner.access')).toBeNull();
    expect(location.href).toBe('/login');
  });

  /**
   * POR QUE a sessão acabou vai junto para a tela de login.
   *
   * Com sessão única, ser derrubado por um login em outro computador é rotina —
   * e chegar numa tela de login em branco faz o usuário concluir que o sistema
   * o desloga sozinho. O código vem do campo `erro` da resposta do refresh, que
   * é a ÚNICA parte da cadeia que sabe distinguir os casos: o 401 da requisição
   * original vem do guard e não explica nada.
   */
  it('sessão derrubada por outro login leva o motivo para /login', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resposta(401, { mensagem: 'Sua conta foi aberta em outro dispositivo.', erro: 'OUTRA_SESSAO' }),
      ),
    );

    await expect(api('/x')).rejects.toMatchObject({ status: 401 });
    expect(location.href).toBe('/login?motivo=OUTRA_SESSAO');
  });

  /**
   * O motivo é consumido UMA vez.
   *
   * Grudado, ele explicaria a queda errada: a pessoa entra de novo, a sessão
   * expira normalmente horas depois, e a tela acusa "sua conta foi aberta em
   * outro dispositivo" — mandando-a caçar um invasor que não existe.
   */
  it('o motivo não sobrevive para a queda seguinte', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(401, { mensagem: 'x', erro: 'OUTRA_SESSAO' })),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 401 });
    expect(location.href).toBe('/login?motivo=OUTRA_SESSAO');

    /* Segunda queda, agora sem código nenhum: nada de motivo herdado. */
    location.href = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(401, { mensagem: 'expirado' })),
    );
    await expect(api('/y')).rejects.toMatchObject({ status: 401 });
    expect(location.href).toBe('/login');
  });

  /**
   * 401 que SOBREVIVE a uma renovação bem-sucedida.
   *
   * Antes da sessão única este estado era inalcançável: tudo que fazia o guard
   * recusar o access (usuário desativado, `sessoesRevogadasEm`) matava o refresh
   * na mesma transação. Com a família no token ele passa a existir — e sem este
   * tratamento a tela ficava num laço 401 → refresh 200 → 401, mostrando erro
   * para sempre e sem NUNCA mandar ninguém para o login.
   */
  it('401 que sobrevive à renovação manda para o login, em vez de virar erro na tela', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/auth/refresh')
          ? resposta(200, { accessToken: 'access-novo' })
          : resposta(401, { mensagem: 'Aberta em outro dispositivo.', erro: 'OUTRA_SESSAO' }),
      ),
    );

    await expect(api('/x')).rejects.toMatchObject({ status: 401, codigo: 'OUTRA_SESSAO' });
    expect(location.href).toBe('/login?motivo=OUTRA_SESSAO');
    expect(sessionStorage.getItem('miner.access')).toBeNull();
  });

  /**
   * As QUATRO chamadas do dashboard não podem apagar o motivo umas das outras.
   *
   * O mutex faz o refresh acontecer uma vez só, mas as quatro continuações
   * rodam em seguida. Consumindo o motivo, a primeira navegaria com ele e as
   * outras três sobrescreveriam o `location.href` com um `/login` pelado — e a
   * última atribuição é a que o navegador honra. A explicação sumia justamente
   * na tela onde ela mais aparece.
   *
   * ⚠ O 401 da rota vem SEM código, e só o do refresh traz `OUTRA_SESSAO`.
   * Não é enfeite do caso: é o que o isola. Com código nos dois, cada chamada
   * teria a própria cópia (o `motivoDoGuard`) e restauraria o motivo sozinha —
   * o teste passaria mesmo com o consumo de volta. E a forma aqui é a real: um
   * access token expirado é recusado pelo guard sem explicação nenhuma, e quem
   * sabe o que houve é a rotação.
   */
  it('as 4 chamadas paralelas do dashboard preservam o motivo', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/auth/refresh')
          ? resposta(401, { mensagem: 'Aberta em outro dispositivo.', erro: 'OUTRA_SESSAO' })
          : resposta(401, { mensagem: 'expirado' }),
      ),
    );

    await Promise.allSettled([api('/a'), api('/b'), api('/c'), api('/d')]);

    expect(location.href).toBe('/login?motivo=OUTRA_SESSAO');
  });
});

describe('api() — o MUTEX de renovação (o coração)', () => {
  /**
   * Quatro chamadas concorrentes tomam 401 ao mesmo tempo. Com o mutex, apenas
   * UMA bate no /auth/refresh; as outras três aguardam o mesmo resultado. Sem
   * ele, seriam quatro refreshes e três derrubariam o token da vencedora.
   *
   * O deferred torna o teste determinístico: seguro o refresh até que as quatro
   * chamadas tenham enfileirado, provando que é a TRAVA, não a ordem de
   * microtasks, que as unifica.
   */
  it('4 chamadas concorrentes com 401 disparam UM só refresh', async () => {
    const soltarRefresh = deferred<void>();
    let refreshCount = 0;
    let dataComTokenNovo = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCount += 1;
        await soltarRefresh.promise; // segura até eu liberar
        return resposta(200, { accessToken: 'access-novo', refreshToken: 'refresh-2' });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === 'Bearer access-novo') {
        dataComTokenNovo += 1;
        return resposta(200, { dado: 'ok' });
      }
      return resposta(401, { mensagem: 'expirado' });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Dispara as 4 sem await — todas correm juntas.
    const todas = Promise.all([
      api('/a'),
      api('/b'),
      api('/c'),
      api('/d'),
    ]);

    // Deixa as 4 chegarem ao 401 e enfileirarem no mutex antes de soltar.
    await new Promise((r) => setTimeout(r, 0));
    soltarRefresh.resolve();

    const resultados = await todas;

    expect(resultados).toHaveLength(4);
    expect(resultados.every((r) => (r as { dado: string }).dado === 'ok')).toBe(true);
    // O ponto: UM refresh, quatro repetições da chamada original.
    expect(refreshCount).toBe(1);
    expect(dataComTokenNovo).toBe(4);
    // E o par novo ficou guardado uma vez só, coerente.
    expect(sessionStorage.getItem('miner.access')).toBe('access-novo');
  });

  /**
   * Depois que uma renovação termina, o mutex tem de LIBERAR: uma segunda
   * expiração mais tarde precisa renovar de novo, não ficar presa ao resultado
   * antigo. Sem o reset no `.finally`, a sessão morreria na segunda expiração.
   */
  it('libera após concluir: uma nova expiração renova outra vez', async () => {
    let refreshCount = 0;
    let accessValido = 'access-1';

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCount += 1;
        accessValido = `access-${refreshCount + 1}`;
        return resposta(200, { accessToken: accessValido, refreshToken: `refresh-${refreshCount + 1}` });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === `Bearer ${accessValido}`
        ? resposta(200, { dado: 'ok' })
        : resposta(401, { mensagem: 'expirado' });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Primeira expiração: access-velho é inválido → renova para access-2.
    await api('/primeira');
    expect(refreshCount).toBe(1);

    // Invalida de novo, simulando a segunda expiração.
    sessionStorage.setItem('miner.access', 'access-expirado-de-novo');
    await api('/segunda');
    expect(refreshCount).toBe(2); // renovou OUTRA vez, não ficou preso
  });
});

/**
 * O upload de planilha NÃO passa por `api()` — multipart exige que o
 * Content-Type seja omitido, para o navegador montar o boundary. Essa exceção
 * criou um buraco real: `enviarPlanilha` fazia um fetch cru, sem tratar 401.
 *
 * O sintoma era cruel. A simulação passava (token ainda válido), o operador lia
 * o relatório, decidia gravar — e o "Importar de verdade", segundos ou minutos
 * depois, morria com um "Unauthorized" seco. Quanto mais o operador conferisse
 * a simulação, maior a chance de falhar. E o único jeito de sair era navegar
 * para outra tela, onde alguma chamada via `api()` renovava o token de raspão.
 */
describe('enviarPlanilha() — renovação no upload', () => {
  const planilha = () => new File([new Uint8Array([1, 2, 3])], 'carteira.xlsx');
  /* `modo` explícito: a união discriminada existe para que uma tela nova não
     consiga mandar tribunal e perfil juntos — nem nenhum dos dois. */
  const destino: DestinoImportacao = { modo: 'TRIBUNAL', tribunal: 'TRF5', exercicio: 2027 };
  const destinoPerfil: DestinoImportacao = { modo: 'PERFIL', perfilId: 'perfil-multi-1' };

  it('access expirado renova e REPETE o upload, em vez de estourar 401', async () => {
    let refreshCount = 0;
    let uploads = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        refreshCount += 1;
        return resposta(200, { accessToken: 'access-novo', refreshToken: 'refresh-2' });
      }
      uploads += 1;
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === 'Bearer access-novo'
        ? resposta(200, { importacaoId: 'i1', totalLinhas: 10 })
        : resposta(401, { mensagem: 'Unauthorized' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await enviarPlanilha(planilha(), destino);

    expect(r).toMatchObject({ importacaoId: 'i1' });
    expect(refreshCount).toBe(1);
    expect(uploads).toBe(2); // a recusada e a repetida
  });

  it('o retry NÃO pode mandar Content-Type — o boundary é do navegador', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/refresh')) {
        return resposta(200, { accessToken: 'access-novo', refreshToken: 'refresh-2' });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === 'Bearer access-novo' ? resposta(200, {}) : resposta(401, {});
    });
    vi.stubGlobal('fetch', fetchMock);

    await enviarPlanilha(planilha(), destino);

    /* Um `Content-Type: application/json` copiado de `api()` por descuido faria
       o backend ler o multipart como JSON e recusar TODA importação. */
    for (const [, init] of fetchMock.mock.calls.filter(([u]) => !u.includes('/auth/refresh'))) {
      expect(init?.headers).not.toHaveProperty('Content-Type');
    }
  });

  it('sem refresh válido, encerra a sessão em vez de repetir para sempre', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/auth/refresh') ? resposta(401, {}) : resposta(401, { mensagem: 'Unauthorized' }),
      ),
    );

    await expect(enviarPlanilha(planilha(), destino)).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem('miner.access')).toBeNull();
    expect(location.href).toBe('/login');
  });

  /**
   * O MODO MULTI-TRIBUNAL, do lado do cliente.
   *
   * Até 06/09/2026 a rota nem aceitava `perfilId`, e o front nunca o mandou —
   * o modo existia no serviço e era inalcançável. Estes dois casos fixam as duas
   * metades do contrato: o que vai quando o destino é um perfil, e o que NÃO
   * pode ir junto.
   */
  it('⚠ modo PERFIL manda perfilId — e NENHUM tribunal', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resposta(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await enviarPlanilha(planilha(), destinoPerfil, true);

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('perfilId=perfil-multi-1');
    /* Mandar os dois é 400 na API. O cliente não pode nem chegar lá: se o
       tribunal viajasse junto, TODA importação multi-tribunal seria recusada. */
    expect(url).not.toContain('tribunal=');
    expect(url).not.toContain('exercicio=');
  });

  it('modo TRIBUNAL continua mandando tribunal e exercício, e nenhum perfilId', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resposta(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await enviarPlanilha(planilha(), destino, true);

    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain('tribunal=TRF5');
    expect(url).toContain('exercicio=2027');
    expect(url).not.toContain('perfilId');
  });

  it('dryRun vai na query — é o que separa simular de gravar', async () => {
    // Assinatura explícita: sem ela o TS tipa mock.calls como tupla vazia.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => resposta(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await enviarPlanilha(planilha(), destino, true);
    expect(fetchMock.mock.calls[0][0]).toContain('dryRun=true');

    fetchMock.mockClear();
    await enviarPlanilha(planilha(), destino);
    expect(fetchMock.mock.calls[0][0]).not.toContain('dryRun');
  });

  /**
   * Desde o B5 a rota responde 202 — aceite, não resultado. O código continua
   * sendo sucesso; um `r.status === 200` em vez de `r.ok`, hoje ou numa refação
   * futura, quebraria TODA importação com um erro que parece de servidor.
   */
  it('202 é sucesso: o recibo da importação chega inteiro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resposta(202, {
          importacaoId: 'imp-1',
          status: 'RECEBIDA',
          totalLinhas: 4000,
          destino: { tribunal: 'TRF5', exercicio: 2027 },
        }),
      ),
    );

    const r = await enviarPlanilha(planilha(), destino);
    expect(r).toMatchObject({ importacaoId: 'imp-1', status: 'RECEBIDA', totalLinhas: 4000 });
  });
});

describe('estadoImportacao() — o acompanhamento da carga na fila', () => {
  it('consulta a importação pelo id', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      resposta(200, { id: 'imp-1', processadas: 500, totalLinhas: 4000, terminou: false }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const e = await estadoImportacao('imp-1');

    expect(fetchMock.mock.calls[0][0]).toContain('/importacao/imp-1');
    expect(e).toMatchObject({ processadas: 500, terminou: false });
  });

  /**
   * `terminou` vem da API de propósito. Cada tela enumerar os status finais é a
   * regra que diverge no dia em que um sexto status aparecer — e o sintoma seria
   * uma tela consultando para sempre uma carga que já acabou.
   */
  it('é a API que diz quando parar de consultar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(200, { status: 'CONCLUIDA_COM_ERROS', terminou: true })),
    );

    expect((await estadoImportacao('imp-1')).terminou).toBe(true);
  });
});
