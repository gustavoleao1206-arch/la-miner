'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cookie, X } from 'lucide-react';

import { decisaoDeCookies, registrarDecisao } from '@/lib/cookies';

/**
 * As categorias, como o painel de preferências as apresenta. A analítica
 * aparece DESLIGADA E TRAVADA com a explicação de que não é usada: é a forma
 * de oferecer o painel que a lei espera sem fingir uma escolha que não existe.
 * Quando um rastreador entrar de verdade, `fixa` vira false e a escolha passa
 * a valer, e `VERSAO_AVISO` sobe para todo mundo decidir de novo.
 */
const CATEGORIAS = [
  {
    chave: 'essenciais',
    nome: 'Essenciais',
    texto: 'O cookie da sua sessão e as proteções da navegação. Sem eles o sistema não funciona.',
    fixa: true,
    ativa: true,
  },
  {
    chave: 'analitica',
    nome: 'Medição e analytics',
    texto: 'Não utilizados neste site. Se um dia forem, você decidirá aqui antes de qualquer coisa ser carregada.',
    fixa: true,
    ativa: false,
  },
  {
    chave: 'terceiros',
    nome: 'Conteúdo de terceiros',
    texto: 'O vídeo de apresentação (YouTube, modo sem cookies) só é carregado depois que você clica para assistir.',
    fixa: true,
    ativa: false,
  },
] as const;

/**
 * O AVISO DE COOKIES, na forma que o site de hoje justifica.
 *
 * Informativo, não bloqueante, um botão só. A razão está em `lib/cookies.ts`:
 * o único cookie do sistema é o da sessão, que dispensa consentimento, e um
 * "Recusar" que não recusa nada é o padrão que a ANPD chama de enganoso.
 *
 * Não renderiza NADA no servidor nem no primeiro quadro do cliente: a decisão
 * mora no localStorage, e decidir "mostrar ou não" antes de lê-lo faria o
 * aviso piscar para quem já o dispensou, em toda visita. O custo é o aviso
 * entrar um quadro depois do conteúdo, o que é exatamente a ordem certa.
 *
 * Barra inferior, nunca modal: um aviso que esconde a página para informar que
 * existe um cookie de sessão é desproporcional ao fato que comunica.
 */
export function AvisoCookies() {
  const [visivel, setVisivel] = useState(false);
  const [preferencias, setPreferencias] = useState(false);

  useEffect(() => {
    if (!decisaoDeCookies()) setVisivel(true);
  }, []);

  if (!visivel) return null;

  function dispensar() {
    registrarDecisao(false);
    setVisivel(false);
  }

  return (
    <section
      role="region"
      aria-label="Aviso de cookies"
      className="fixed inset-x-0 bottom-0 z-50 p-4 sm:p-6 motion-safe:animate-[subir_.4s_cubic-bezier(.16,1,.3,1)]"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-4 rounded-lg border border-linha bg-superficie p-5 shadow-cartao backdrop-blur-xl sm:flex-row sm:items-center sm:gap-6">
        <Cookie aria-hidden className="hidden h-5 w-5 shrink-0 text-marca-ciano sm:block" />
        <p className="flex-1 text-[14px] leading-relaxed text-ink-2">
          Este site usa apenas <strong className="font-semibold text-ink">cookies essenciais</strong>:
          o que mantém você conectado e os que protegem a navegação. Nenhum cookie de publicidade
          ou de rastreamento. Detalhes na{' '}
          <Link href="/privacidade#cookies" className="text-marca-ciano underline-offset-4 hover:underline">
            Política de Privacidade
          </Link>
          .
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPreferencias((p) => !p)}
            aria-expanded={preferencias}
            aria-controls="preferencias-cookies"
            className="cursor-pointer rounded-sm border border-linha px-4 py-2.5 text-[14px] text-ink-2 transition-colors hover:text-ink"
          >
            Preferências
          </button>
          <button
            type="button"
            onClick={dispensar}
            className="cursor-pointer rounded-sm bg-marca px-5 py-2.5 text-[14px] font-semibold text-white transition-opacity hover:opacity-90"
          >
            Entendi
          </button>
          <button
            type="button"
            onClick={dispensar}
            aria-label="Fechar aviso de cookies"
            className="cursor-pointer rounded-sm p-2 text-muted transition-colors hover:text-ink"
          >
            <X aria-hidden className="h-4 w-4" />
          </button>
        </div>
      </div>

      {preferencias && (
        <div
          id="preferencias-cookies"
          className="mx-auto mt-2 max-w-3xl rounded-lg border border-linha bg-superficie p-5 shadow-cartao backdrop-blur-xl"
        >
          <ul className="grid gap-3">
            {CATEGORIAS.map((c) => (
              <li key={c.chave} className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[14px] font-semibold text-ink">{c.nome}</p>
                  <p className="text-[13px] leading-relaxed text-muted">{c.texto}</p>
                </div>
                <span
                  role="switch"
                  aria-checked={c.ativa}
                  aria-disabled={c.fixa}
                  aria-label={c.nome}
                  className="mt-1 shrink-0 rounded-full border border-linha px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted"
                >
                  {c.ativa ? 'sempre ativo' : 'desligado'}
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={dispensar}
            className="mt-4 cursor-pointer rounded-sm bg-marca px-5 py-2 text-[13px] font-semibold text-white"
          >
            Salvar preferências
          </button>
        </div>
      )}
    </section>
  );
}
