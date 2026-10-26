import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AvisoCookies } from '@/components/aviso-cookies';
import {
  CHAVE_COOKIES,
  VERSAO_AVISO,
  carregarScriptSeConsentido,
  decisaoDeCookies,
  permitido,
} from '@/lib/cookies';

/**
 * O aviso de cookies: aparece uma vez, é dispensado uma vez, e lembra.
 *
 * O que se fixa aqui é sobretudo a MEMÓRIA: um aviso que volta a cada visita
 * ensina o visitante a fechá-lo sem ler, e um que não volta quando a natureza
 * dele mudou (versão nova) esconde justamente a pergunta nova.
 */
describe('Aviso de cookies', () => {
  beforeEach(() => window.localStorage.clear());

  it('aparece para quem nunca decidiu, e diz que só há cookies essenciais', () => {
    render(<AvisoCookies />);

    const aviso = screen.getByRole('region', { name: 'Aviso de cookies' });
    expect(aviso).toBeInTheDocument();
    expect(aviso).toHaveTextContent('cookies essenciais');
    /* Sem "Recusar": não há o que recusar, e oferecer a escolha seria enganoso. */
    expect(screen.queryByRole('button', { name: /recusar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Política de Privacidade' })).toHaveAttribute(
      'href',
      '/privacidade#cookies',
    );
  });

  it('"Entendi" dispensa o aviso e grava a decisão, versionada', () => {
    render(<AvisoCookies />);

    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));

    expect(screen.queryByRole('region', { name: 'Aviso de cookies' })).not.toBeInTheDocument();
    const d = decisaoDeCookies();
    expect(d?.versao).toBe(VERSAO_AVISO);
    expect(d?.essenciais).toBe(true);
    expect(d?.analitica).toBe(false);
  });

  it('quem já decidiu não vê o aviso de novo', () => {
    window.localStorage.setItem(
      CHAVE_COOKIES,
      JSON.stringify({ versao: VERSAO_AVISO, decidiuEm: '2026-08-21T00:00:00.000Z', essenciais: true, analitica: false }),
    );

    render(<AvisoCookies />);

    expect(screen.queryByRole('region', { name: 'Aviso de cookies' })).not.toBeInTheDocument();
  });

  it('decisão de uma VERSÃO antiga não vale: o aviso volta', () => {
    /* É o mecanismo para o dia em que entrar analytics: a versão sobe e todo
       mundo responde à pergunta nova, em vez de herdar um "entendi" que foi
       dado para outro aviso. */
    window.localStorage.setItem(
      CHAVE_COOKIES,
      JSON.stringify({ versao: VERSAO_AVISO - 1, decidiuEm: '2026-01-01T00:00:00.000Z', essenciais: true, analitica: false }),
    );

    render(<AvisoCookies />);

    expect(screen.getByRole('region', { name: 'Aviso de cookies' })).toBeInTheDocument();
  });

  it('"Preferências" abre o painel, e a analítica aparece DESLIGADA e travada', () => {
    render(<AvisoCookies />);

    fireEvent.click(screen.getByRole('button', { name: 'Preferências' }));

    const analitica = screen.getByRole('switch', { name: 'Medição e analytics' });
    expect(analitica).toHaveAttribute('aria-checked', 'false');
    expect(analitica).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('switch', { name: 'Essenciais' })).toHaveAttribute('aria-checked', 'true');
  });

  it('localStorage corrompido não derruba a página: o aviso simplesmente aparece', () => {
    window.localStorage.setItem(CHAVE_COOKIES, '{isto não é json');

    render(<AvisoCookies />);

    expect(screen.getByRole('region', { name: 'Aviso de cookies' })).toBeInTheDocument();
  });
});

describe('Bloqueio prévio: nenhum script de terceiro sem consentimento', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.head.querySelectorAll('script[data-categoria]').forEach((s) => s.remove());
  });

  it('essenciais sempre passam; analítica só com decisão explícita', () => {
    expect(permitido('essenciais')).toBe(true);
    expect(permitido('analitica')).toBe(false);
  });

  it('o script analítico NÃO é injetado sem consentimento', () => {
    const ok = carregarScriptSeConsentido('analitica', 'https://exemplo.invalid/ga.js');

    expect(ok).toBe(false);
    expect(document.head.querySelector('script[src="https://exemplo.invalid/ga.js"]')).toBeNull();
  });

  it('"Entendi" (só essenciais) continua NÃO liberando a analítica', () => {
    render(<AvisoCookies />);
    fireEvent.click(screen.getByRole('button', { name: 'Entendi' }));

    expect(permitido('analitica')).toBe(false);
    expect(carregarScriptSeConsentido('analitica', 'https://exemplo.invalid/ga.js')).toBe(false);
  });
});
