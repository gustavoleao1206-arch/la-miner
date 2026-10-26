'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/config';

/**
 * A tela do link de confirmação — e o balcão de reenvio.
 *
 * PÚBLICA e no layout do site, porque quem chega aqui pode não ter sessão
 * nenhuma: veio do e-mail, ou foi expulso do painel pelo 403 de e-mail não
 * confirmado. Dois modos, decididos pela presença do token na URL:
 *
 *  - COM token: confirma na hora (o clique no e-mail É o gesto) e mostra o
 *    caminho do pagamento — é aqui que a fatura nasce, por desenho.
 *  - SEM token: instruções + formulário de reenvio, cuja resposta é a mesma
 *    exista ou não o e-mail (a API não confirma conta de ninguém).
 *
 * O token é lido de `window.location.search` num efeito, e NÃO de
 * `useSearchParams()` — o hook obrigaria a página inteira a viver num
 * <Suspense> (mesma decisão da tela de login, pelo mesmo motivo).
 *
 * `fetch` puro, sem o `lib/api.ts`: não há sessão aqui, e os reflexos daquele
 * cliente (renovar no 401, desviar 402/403) seriam todos errados nesta tela.
 */

type Modo =
  | { st: 'confirmando' }
  | { st: 'confirmado'; urlPagamento: string | null }
  | { st: 'erro'; mensagem: string }
  | { st: 'reenvio' };

export default function ConfirmarEmailPage() {
  const [modo, setModo] = useState<Modo>({ st: 'confirmando' });
  const [email, setEmail] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [reenviado, setReenviado] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    /* O token sai da barra imediatamente: link com credencial não fica em
       histórico nem em barra de endereço para print de tela. */
    if (token) window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setModo({ st: 'reenvio' });
      return;
    }
    void (async () => {
      try {
        const r = await fetch(`${API_URL}/v1/cadastro/confirmar-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const corpo = await r.json().catch(() => ({}));
        if (!r.ok) {
          const m = corpo?.mensagem ?? corpo?.message;
          setModo({
            st: 'erro',
            mensagem: Array.isArray(m) ? m.join(' ') : (m ?? 'Não foi possível confirmar.'),
          });
          return;
        }
        setModo({ st: 'confirmado', urlPagamento: corpo?.urlPagamento ?? null });
      } catch {
        setModo({ st: 'erro', mensagem: 'Não conseguimos falar com o servidor. Tente de novo.' });
      }
    })();
  }, []);

  async function reenviar(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || enviando) return;
    setEnviando(true);
    try {
      await fetch(`${API_URL}/v1/cadastro/reenviar-confirmacao`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch {
      /* A resposta ao usuário é a mesma com ou sem rede: "se existir, enviamos".
         Errar aqui para o lado de confirmar existência seria pior. */
    } finally {
      setEnviando(false);
      setReenviado(true);
    }
  }

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col justify-center px-6 py-16">
      {modo.st === 'confirmando' && (
        <div className="rounded-lg border border-linha bg-superficie p-8 text-center">
          <p className="text-[15px] text-muted">Confirmando seu e-mail…</p>
        </div>
      )}

      {modo.st === 'confirmado' && (
        <div className="rounded-lg border border-linha bg-superficie p-8 text-center">
          <h1 className="font-display text-xl font-semibold text-ink">E-mail confirmado</h1>
          {modo.urlPagamento ? (
            <>
              <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted text-justify">
                Sua conta está pronta. Falta só o pagamento: o acesso abre assim que ele for
                confirmado.
              </p>
              <a
                href={modo.urlPagamento}
                className="mt-6 inline-flex rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho"
              >
                Ir para o pagamento
              </a>
            </>
          ) : (
            <>
              {/* Gateway indisponível ou cobrança manual: a conta é boa, e a tela
                  de assinatura sabe retomar — o mesmo caminho do cadastro antigo. */}
              <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted text-justify">
                Sua conta está pronta. Não foi possível abrir o pagamento agora. Entre com seu
                e-mail e senha, e a tela de assinatura mostra como concluir.
              </p>
              <a
                href="/login"
                className="mt-6 inline-flex rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho"
              >
                Ir para o login
              </a>
            </>
          )}
        </div>
      )}

      {modo.st === 'erro' && (
        <div className="rounded-lg border border-linha bg-superficie p-8 text-center">
          <h1 className="font-display text-xl font-semibold text-ink">Não foi possível confirmar</h1>
          <p role="alert" className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-erro text-justify">
            {modo.mensagem}
          </p>
          <p className="mx-auto mt-3 max-w-sm text-[14px] leading-relaxed text-muted text-justify">
            Se o link venceu, cadastre-se de novo: leva um minuto e o CNPJ não fica preso. Se
            você já confirmou antes, é só entrar.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <a href="/cadastro" className="rounded-sm bg-marca px-5 py-2.5 font-semibold text-white">
              Refazer cadastro
            </a>
            <a href="/login" className="rounded-sm border border-linha px-5 py-2.5 text-ink-2">
              Entrar
            </a>
          </div>
        </div>
      )}

      {modo.st === 'reenvio' && (
        <div className="rounded-lg border border-linha bg-superficie p-8">
          <h1 className="font-display text-xl font-semibold text-ink">Confirme seu e-mail</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
            Enviamos um link de confirmação para o endereço cadastrado. Não chegou? Confira o
            spam, ou peça outro abaixo.
          </p>
          {reenviado ? (
            <p role="status" className="mt-5 rounded-sm border border-linha bg-bg p-4 text-[14px] text-ink-2">
              Se este e-mail tiver um cadastro aguardando confirmação, um novo link acabou de ser
              enviado. Vale conferir a caixa de spam.
            </p>
          ) : (
            <form method="post" onSubmit={reenviar} className="mt-5 flex flex-wrap gap-3">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@escritorio.com.br"
                aria-label="E-mail do cadastro"
                className="h-11 min-w-[240px] flex-1 rounded-sm border border-linha bg-bg px-4 text-[15px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
              />
              <button
                type="submit"
                disabled={enviando || !email.trim()}
                className="rounded-sm bg-marca px-6 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                {enviando ? 'Enviando…' : 'Reenviar link'}
              </button>
            </form>
          )}
        </div>
      )}
    </main>
  );
}
