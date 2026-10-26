'use client';

import { useState } from 'react';
import Link from 'next/link';

import { API_URL } from '@/lib/config';

/**
 * "Esqueci minha senha" — o pedido do link.
 *
 * Até 20/08/2026 o login tinha um botão com este nome e NENHUM destino: nem
 * rota na API, nem tela aqui. O primeiro cliente a esquecer a senha viraria um
 * chamado de suporte resolvido com UPDATE à mão no banco.
 *
 * A TELA NÃO SABE SE O E-MAIL EXISTE, e isso é deliberado: a API responde 204
 * nos dois casos, e o texto abaixo é escrito no condicional ("se este e-mail
 * tiver conta") justamente para não denunciar. Uma mensagem simpática do tipo
 * "não encontramos esse e-mail" transformaria a página num verificador de quais
 * escritórios são nossos clientes.
 *
 * `fetch` puro, sem o `lib/api.ts`: aqui não há sessão, e os reflexos daquele
 * cliente — renovar no 401, desviar no 402/403 — seriam todos errados.
 */
export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [enviado, setEnviado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function pedir(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const r = await fetch(`${API_URL}/v1/auth/esqueci-senha`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      /* 429 é o único erro que vale contar: sem isso, quem clicou três vezes
         acha que "enviamos" e fica esperando um e-mail que não saiu. */
      if (r.status === 429) {
        setErro('Muitos pedidos seguidos. Espere um minuto e tente de novo.');
        return;
      }
      if (!r.ok && r.status !== 204) {
        setErro('Não foi possível concluir o pedido. Tente novamente em instantes.');
        return;
      }
      setEnviado(true);
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
        {enviado ? (
          <>
            <h1 className="font-display text-xl font-semibold text-ink">Verifique seu e-mail</h1>
            <p role="status" className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
              Se este e-mail tiver uma conta ativa, um link para criar uma nova senha acabou de
              ser enviado. Ele vale por <strong className="text-ink-2">1 hora</strong> e só pode
              ser usado uma vez.
            </p>
            <p className="mt-3 text-[14px] leading-relaxed text-muted-2 text-justify">
              Não chegou em alguns minutos? Confira a caixa de spam.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex rounded-sm border border-linha px-5 py-2.5 text-[14px] text-ink-2 transition-colors hover:text-ink"
            >
              Voltar para o login
            </Link>
          </>
        ) : (
          <>
            <h1 className="font-display text-xl font-semibold text-ink">Esqueceu sua senha?</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-muted text-justify">
              Informe o e-mail da sua conta. Enviaremos um link para você criar uma nova senha.
            </p>

            <form method="post" onSubmit={pedir} className="mt-6">
              <label htmlFor="email" className="rotulo">
                E-mail
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@escritorio.com.br"
                className="mt-2 h-11 w-full rounded-sm border border-linha bg-bg px-4 text-[15px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
              />

              {erro && (
                <p role="alert" className="mt-3 text-[14px] text-erro">
                  {erro}
                </p>
              )}

              <button
                type="submit"
                disabled={enviando || !email.trim()}
                className="mt-6 w-full rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho disabled:opacity-50"
              >
                {enviando ? 'Enviando…' : 'Enviar link'}
              </button>
            </form>

            <p className="mt-5 text-center text-[13px] text-muted">
              Lembrou?{' '}
              <Link href="/login" className="text-marca-ciano hover:underline">
                Entrar
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
