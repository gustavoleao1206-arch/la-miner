'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Loader2, Lock } from 'lucide-react';
import { encerrarSessao, pausarAba, retomarAba } from '@/lib/api';

/**
 * A ABA QUE FICA PARADA SE APAGA SOZINHA.
 *
 * ── POR ABA, E NÃO POR SESSÃO ──
 *
 * Duas abas abertas, mexendo só numa: a outra tem de sair do ar. Se a conta
 * fosse por SESSÃO, a atividade numa aba seguraria a outra para sempre — e a
 * tela abandonada seguiria mostrando CPF e telefone de titular a quem passasse
 * pela mesa.
 *
 * ── POR QUE PAUSA, E NÃO LOGOUT ──
 *
 * Porque a sessão é ÚNICA. Se a aba parada mandasse para o login e a pessoa
 * entrasse por ali, esse login novo derrubaria a aba em que ela estava
 * trabalhando — sair da aba ociosa custaria a aba em uso. Aqui a volta é uma
 * RENOVAÇÃO, não um login: o cookie de refresh continua valendo, nenhuma
 * família nova nasce, e a outra aba não sente nada.
 *
 * Quando a renovação é recusada (sessão encerrada noutro lugar, senha trocada,
 * refresh expirado) aí sim vai para o login — e é o servidor quem decide isso,
 * não esta tela.
 *
 * ── POR QUE RELÓGIO DE PAREDE, E NÃO SÓ UM setTimeout ──
 *
 * A aba parada está, por definição, em SEGUNDO PLANO — e o navegador estrangula
 * temporizadores de aba escondida. Um `setTimeout` de 30 minutos pode disparar
 * muito depois. Aqui o que manda é a comparação de `Date.now()`; o intervalo só
 * serve para conferir de vez em quando, e `visibilitychange`/`focus` conferem no
 * instante em que a pessoa olha. A garantia que importa: ninguém CHEGA a ver uma
 * aba vencida destrancada.
 */

/** 30 minutos — o número que o dono pediu. */
export const INATIVIDADE_MS = 30 * 60_000;

/** De quanto em quanto se confere o relógio. Barato: é uma subtração. */
const INTERVALO_DE_CONFERENCIA_MS = 30_000;

/**
 * O que conta como "mexer".
 *
 * `pointermove` entra: mover o mouse é presença, e sem ele quem lê um processo
 * longo levaria um cadeado na cara no meio da leitura. O custo é uma atribuição
 * num ref — não redesenha nada.
 */
const EVENTOS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

const Ctx = createContext<{ pausada: boolean }>({ pausada: false });

/** Para quem precisar saber se a aba está pausada (hoje, os testes). */
export const useInatividade = () => useContext(Ctx);

export function ProvedorInatividade({ children }: { children: React.ReactNode }) {
  const [pausada, setPausada] = useState(false);
  const [voltando, setVoltando] = useState(false);
  const ultimaAtividade = useRef(Date.now());

  const conferir = useCallback(() => {
    if (Date.now() - ultimaAtividade.current < INATIVIDADE_MS) return;
    pausarAba();
    setPausada(true);
  }, []);

  useEffect(() => {
    /* Pausada, para de contar: não há o que vencer duas vezes, e o
       `pointermove` de quem passa o mouse sobre o cadeado não é "voltei". */
    if (pausada) return;

    const marcar = () => {
      ultimaAtividade.current = Date.now();
    };
    for (const e of EVENTOS) window.addEventListener(e, marcar, { passive: true });
    /* `visibilitychange` e `focus` conferem no instante em que a pessoa volta a
       olhar — é o que impede que ela chegue a ver a tela vencida enquanto o
       intervalo estrangulado ainda não rodou. */
    document.addEventListener('visibilitychange', conferir);
    window.addEventListener('focus', conferir);
    const relogio = setInterval(conferir, INTERVALO_DE_CONFERENCIA_MS);

    return () => {
      for (const e of EVENTOS) window.removeEventListener(e, marcar);
      document.removeEventListener('visibilitychange', conferir);
      window.removeEventListener('focus', conferir);
      clearInterval(relogio);
    };
  }, [pausada, conferir]);

  const voltar = useCallback(async () => {
    if (voltando) return;
    setVoltando(true);
    try {
      if (await retomarAba()) {
        ultimaAtividade.current = Date.now();
        setPausada(false);
        return;
      }
      /* A sessão não existe mais. `location.href`, e não o router do Next: é
         preciso recarregar o app inteiro, senão as telas por trás continuariam
         montadas com dados de uma sessão que acabou. */
      window.location.href = '/login?motivo=inatividade';
    } finally {
      setVoltando(false);
    }
  }, [voltando]);

  /**
   * Sair de verdade, do cadeado.
   *
   * `encerrarSessao` fala com o servidor antes de limpar o local — e ela
   * própria destranca o `abaPausada`, porque o `fetch` do logout é cru e não
   * passa pelo `api()`. Nunca lança: com a API fora do ar, o local é limpo do
   * mesmo jeito e a pessoa sai.
   */
  const sair = useCallback(async () => {
    await encerrarSessao();
    window.location.href = '/login';
  }, []);

  return (
    <Ctx.Provider value={{ pausada }}>
      {children}
      {pausada && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="titulo-pausa"
          /* `backdrop-blur` NÃO basta sozinho: com pouco contraste ainda dá para
             ler um CPF por trás. O fundo é opaco, e o borrão é só acabamento. */
          className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/95 p-6 backdrop-blur-xl"
        >
          <div className="cartao w-full max-w-sm p-8 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-linha bg-superficie">
              <Lock className="h-5 w-5 text-marca-ciano" aria-hidden />
            </span>
            <h2 id="titulo-pausa" className="mt-5 font-display text-[17px] font-medium text-ink">
              Sessão pausada
            </h2>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Esta aba ficou 30 minutos sem uso. As outras abas, se houver, continuam
              como estavam.
            </p>
            <button
              type="button"
              onClick={() => void voltar()}
              disabled={voltando}
              autoFocus
              className="mt-6 flex h-10 w-full items-center justify-center gap-2 rounded-full bg-marca text-[13px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {voltando && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Continuar trabalhando
            </button>
            {/* Um `<a href="/login">` aqui seria mentira: levaria à tela de
                login deixando a sessão VIVA no servidor e o cookie no
                navegador. Sair de verdade é avisar o servidor. */}
            <button
              type="button"
              onClick={() => void sair()}
              disabled={voltando}
              className="mt-4 text-[12px] text-muted underline-offset-4 hover:text-ink-2 hover:underline disabled:opacity-45"
            >
              Sair da conta
            </button>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
