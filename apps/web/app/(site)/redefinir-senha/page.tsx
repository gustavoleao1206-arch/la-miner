'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

import { API_URL } from '@/lib/config';

/**
 * A tela do link: escolher a nova senha.
 *
 * O token é lido de `window.location.search` num efeito e SAI da barra na
 * mesma linha — link com credencial não fica em histórico de navegador nem
 * aparece em print de tela. Mesma decisão da confirmação de e-mail.
 *
 * `useSearchParams()` obrigaria a página inteira a viver num <Suspense>; a
 * leitura direta evita isso, como no login e na confirmação.
 */

const MINIMO = 12;

export default function RedefinirSenhaPage() {
  const [token, setToken] = useState<string | null>(null);
  const [senha, setSenha] = useState('');
  const [repetida, setRepetida] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) window.history.replaceState(null, '', window.location.pathname);
    setToken(t);
  }, []);

  const curta = senha.length > 0 && senha.length < MINIMO;
  const divergem = repetida.length > 0 && senha !== repetida;
  const podeEnviar = senha.length >= MINIMO && senha === repetida && !enviando;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setEnviando(true);
    setErro(null);
    try {
      const r = await fetch(`${API_URL}/v1/auth/redefinir-senha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, senha }),
      });
      if (r.ok || r.status === 204) {
        setPronto(true);
        return;
      }
      const corpo = await r.json().catch(() => ({}));
      const m = corpo?.mensagem ?? corpo?.message;
      setErro(
        Array.isArray(m) ? m.join(' ') : (m ?? 'Não foi possível redefinir a senha.'),
      );
    } catch {
      setErro('Não conseguimos falar com o servidor. Verifique sua conexão.');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <Link
        href="/"
        className="font-display text-sm font-bold tracking-tight text-ink transition-colors hover:text-marca-ciano"
      >
        LEÃO AMORIM
        <span className="ml-2 font-mono text-[10px] font-medium tracking-[0.3em] text-marca-ciano">
          MINER
        </span>
      </Link>

      <div className="mt-10 rounded-lg border border-linha bg-superficie p-8">
        {pronto ? (
          <>
            <h1 className="font-display text-xl font-semibold text-ink">Senha alterada</h1>
            <p role="status" className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
              Pronto. Por segurança, <strong className="text-ink-2">todas as sessões abertas
              foram encerradas</strong>. Entre de novo com a senha nova.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho"
            >
              Ir para o login
            </Link>
          </>
        ) : token === null ? (
          /* Sem token: quem chegou aqui digitando o endereço, ou clicou num link
             truncado pelo cliente de e-mail. Não é erro — é falta de caminho. */
          <>
            <h1 className="font-display text-xl font-semibold text-ink">Link incompleto</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
              Esta página só funciona a partir do link enviado por e-mail. Se o seu link não
              abriu direito, peça outro: leva um minuto.
            </p>
            <Link
              href="/esqueci-senha"
              className="mt-6 inline-flex rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho"
            >
              Pedir um novo link
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-xl font-semibold text-ink">Escolha uma nova senha</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
              Mínimo de {MINIMO} caracteres. Uma frase que só você diria vale mais que
              &ldquo;Senha@123&rdquo;.
            </p>

            <form method="post" onSubmit={enviar} className="mt-6 space-y-4">
              <div>
                <label htmlFor="senha" className="rotulo">
                  Nova senha
                </label>
                <input
                  id="senha"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  className="mt-2 h-11 w-full rounded-sm border border-linha bg-bg px-4 text-[15px] text-ink outline-none focus:border-marca-ciano"
                />
                {curta && (
                  <p className="mt-1.5 text-[13px] text-alerta">
                    Faltam {MINIMO - senha.length} caractere(s).
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="repetida" className="rotulo">
                  Repita a nova senha
                </label>
                <input
                  id="repetida"
                  type="password"
                  required
                  autoComplete="new-password"
                  value={repetida}
                  onChange={(e) => setRepetida(e.target.value)}
                  className="mt-2 h-11 w-full rounded-sm border border-linha bg-bg px-4 text-[15px] text-ink outline-none focus:border-marca-ciano"
                />
                {divergem && (
                  <p className="mt-1.5 text-[13px] text-alerta">As duas senhas não coincidem.</p>
                )}
              </div>

              {erro && (
                <p role="alert" className="text-[14px] text-erro">
                  {erro}{' '}
                  <Link href="/esqueci-senha" className="text-marca-ciano hover:underline">
                    Pedir um novo link
                  </Link>
                </p>
              )}

              <button
                type="submit"
                disabled={!podeEnviar}
                className="w-full rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho disabled:opacity-50"
              >
                {enviando ? 'Salvando…' : 'Salvar nova senha'}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
