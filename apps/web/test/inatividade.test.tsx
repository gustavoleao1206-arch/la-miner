import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { ProvedorInatividade, INATIVIDADE_MS } from '@/lib/inatividade';
import { api, pausarAba, retomarAba } from '@/lib/api';

/**
 * A aba que fica parada se apaga sozinha.
 *
 * O que se prova aqui não é "apareceu um cadeado" — é que a aba pausada PARA DE
 * FALAR com a API (senão o polling do painel a destrancaria por dentro) e que a
 * volta é uma RENOVAÇÃO, não um login (senão ela derrubaria a aba em que a
 * pessoa está trabalhando, por causa da sessão única).
 */

const resposta = (status: number, corpo: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
    clone: () => resposta(status, corpo),
  }) as Response;

/** Empurra o relógio e deixa o intervalo de conferência rodar. */
async function parar(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  sessionStorage.clear();
  vi.restoreAllMocks();

  /* A pausa vive no MÓDULO `lib/api`, não no componente — e por isso vaza de um
     caso para o outro: sem este reset, o segundo teste já nascia com a aba
     pausada pelo primeiro e falhava por contaminação, não por defeito.
     O reset usa o caminho DE VERDADE (uma renovação), porque é o único que
     existe — e é bom que seja assim: uma porta lateral para destrancar sem
     falar com o servidor seria exatamente o buraco que a pausa fecha. */
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => resposta(200, { accessToken: 'access-velho' })),
  );
  await retomarAba();
  vi.unstubAllGlobals();

  sessionStorage.setItem('miner.access', 'access-velho');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const Conteudo = () => <p>carteira do cliente</p>;

describe('Inatividade — a aba parada se apaga', () => {
  it('depois de 30 minutos parada, o cadeado cobre o conteúdo', async () => {
    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );

    /* Antes do prazo, nada acontece — sem este contraponto, um bug que
       trancasse na montagem passaria como "inatividade funcionando". */
    await parar(INATIVIDADE_MS - 60_000);
    expect(screen.queryByText('Sessão pausada')).toBeNull();

    await parar(120_000);
    expect(await screen.findByText('Sessão pausada')).toBeTruthy();
  });

  /**
   * ⚠ A ASSERÇÃO QUE IMPORTA.
   *
   * Sem a trava dentro do `api()`, pausar não pausaria nada: a primeira consulta
   * repetida do painel tomaria 401, renovaria pelo cookie — que continua válido,
   * porque a SESSÃO não morreu — e a aba voltaria a puxar dados de titulares
   * numa tela que o dono já abandonou.
   */
  it('a aba pausada não fala mais com a API — nem para renovar', async () => {
    const fetchFalso = vi.fn(async () => resposta(200, { ok: true }));
    vi.stubGlobal('fetch', fetchFalso);

    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );

    await expect(api('/carteira/resumo')).resolves.toEqual({ ok: true });
    expect(fetchFalso).toHaveBeenCalledTimes(1);

    await parar(INATIVIDADE_MS + 60_000);
    await screen.findByText('Sessão pausada');

    await expect(api('/carteira/resumo')).rejects.toMatchObject({ codigo: 'ABA_PAUSADA' });
    /* Nenhuma chamada NOVA: a recusa acontece antes do fetch. */
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    /* E a credencial saiu do storage — a aba pausada não guarda nada. */
    expect(sessionStorage.getItem('miner.access')).toBeNull();
  });

  /**
   * A VOLTA É RENOVAÇÃO, NÃO LOGIN.
   *
   * É o que protege a outra aba: um login novo criaria família nova e mataria a
   * sessão em que a pessoa está trabalhando. Aqui só o `/auth/refresh` é
   * chamado, e nenhuma tela de login aparece.
   */
  it('"Continuar trabalhando" volta em silêncio, com uma renovação', async () => {
    const fetchFalso = vi.fn(async (url: string) =>
      String(url).includes('/auth/refresh')
        ? resposta(200, { accessToken: 'access-novo' })
        : resposta(200, { ok: true }),
    );
    vi.stubGlobal('fetch', fetchFalso);

    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );
    await parar(INATIVIDADE_MS + 60_000);

    const botao = await screen.findByRole('button', { name: /continuar trabalhando/i });
    await act(async () => {
      botao.click();
    });

    await waitFor(() => expect(screen.queryByText('Sessão pausada')).toBeNull());
    expect(sessionStorage.getItem('miner.access')).toBe('access-novo');
    /* Só o refresh — nenhuma ida ao login. */
    expect(fetchFalso.mock.calls.map((c) => String(c[0]))).toEqual([
      expect.stringContaining('/auth/refresh'),
    ]);

    /* E volta a falar com a API. */
    await expect(api('/carteira/resumo')).resolves.toEqual({ ok: true });
  });

  /**
   * Quando a sessão morreu MESMO (encerrada noutro lugar, senha trocada), a
   * renovação é recusada — e aí não há como voltar sozinha. Quem decide isso é
   * o servidor, não esta tela.
   */
  it('se a renovação for recusada, vai para o login dizendo por quê', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(401, { mensagem: 'expirado' })),
    );

    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );
    await parar(INATIVIDADE_MS + 60_000);

    const botao = await screen.findByRole('button', { name: /continuar trabalhando/i });
    await act(async () => {
      botao.click();
    });

    await waitFor(() => expect(location.href).toBe('/login?motivo=inatividade'));
  });

  /**
   * Renovação recusada mantém a aba PAUSADA.
   *
   * Parece detalhe porque logo em seguida a tela navega para o login — mas a
   * navegação leva tempo, e nesse intervalo o painel continua montado com as
   * consultas que se repetem sozinhas. Soltar a trava aí devolveria a aba
   * abandonada à rede, com a sessão já recusada, bem no instante em que ela
   * deveria estar mais fechada.
   *
   * Sem componente de propósito: é o módulo que guarda a pausa, e o caso morre
   * afogado na navegação se for observado pela tela.
   */
  it('renovação recusada deixa a aba pausada, e não solta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(401, { mensagem: 'expirado' })),
    );

    pausarAba();
    expect(await retomarAba()).toBe(false);

    await expect(api('/carteira/resumo')).rejects.toMatchObject({ codigo: 'ABA_PAUSADA' });
  });

  /**
   * Mexer adia o prazo — e `pointermove` conta.
   *
   * Sem ele, quem lê um processo longo levaria o cadeado na cara no meio da
   * leitura, sem ter saído da frente do computador.
   */
  it('mexer na aba adia o cadeado', async () => {
    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );

    await parar(INATIVIDADE_MS - 60_000);
    await act(async () => {
      window.dispatchEvent(new Event('pointermove'));
    });

    /* Passou do prazo ORIGINAL e continua de pé, porque o relógio reiniciou. */
    await parar(120_000);
    expect(screen.queryByText('Sessão pausada')).toBeNull();

    await parar(INATIVIDADE_MS);
    expect(await screen.findByText('Sessão pausada')).toBeTruthy();
  });

  /**
   * O navegador estrangula temporizador de aba escondida: um `setTimeout` de 30
   * minutos pode disparar bem depois. A conferência no `visibilitychange` é o
   * que garante o essencial — ninguém CHEGA a ver a aba vencida destrancada.
   */
  it('voltar para a aba confere o relógio na hora, sem esperar o intervalo', async () => {
    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );

    /* Sem rodar o intervalo: só o relógio de parede andou, como aconteceria
       numa aba em segundo plano com os temporizadores estrangulados. */
    const agora = Date.now();
    vi.setSystemTime(agora + INATIVIDADE_MS + 60_000);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText('Sessão pausada')).toBeTruthy();
  });

  it('"Sair da conta" avisa o servidor antes de ir embora', async () => {
    const location = { href: '' };
    vi.stubGlobal('location', location);
    /* O parâmetro é declarado só para o `mock.calls` ter tipo — sem ele o
       TS trata a tupla de argumentos como vazia e `calls[0]` não compila. */
    const fetchFalso = vi.fn(async (url: string) => {
      void url;
      return resposta(204, null);
    });
    vi.stubGlobal('fetch', fetchFalso);

    render(
      <ProvedorInatividade>
        <Conteudo />
      </ProvedorInatividade>,
    );
    await parar(INATIVIDADE_MS + 60_000);

    const sair = await screen.findByRole('button', { name: /sair da conta/i });
    await act(async () => {
      sair.click();
    });

    /* Sair PRECISA funcionar com a aba pausada — o `fetch` do logout é cru e
       não passa pelo `api()`. Sem isso o botão do cadeado não faria nada. */
    await waitFor(() =>
      expect(fetchFalso.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining('/auth/logout'),
      ]),
    );
    expect(location.href).toBe('/login');
  });
});
