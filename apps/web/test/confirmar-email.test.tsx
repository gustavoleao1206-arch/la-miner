import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmarEmailPage from '@/app/(site)/confirmar-email/page';

/**
 * A tela do link de confirmação.
 *
 * O que se fixa: o token da URL é consumido UMA vez (e sai da barra), o
 * sucesso leva ao pagamento, e o reenvio responde a MESMA coisa exista ou não
 * o e-mail — a tela não pode virar oráculo nem quando a API respeita isso.
 */

const resposta = (status: number, corpo: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => corpo }) as Response;

beforeEach(() => {
  window.history.replaceState(null, '', '/confirmar-email');
});
afterEach(() => vi.unstubAllGlobals());

describe('Confirmar e-mail', () => {
  it('com token na URL: confirma, tira o token da barra e oferece o pagamento', async () => {
    window.history.replaceState(null, '', '/confirmar-email?token=abc123def456ghi789');
    const fetchFalso = vi.fn(async () =>
      resposta(200, { email: 'ana@x.com', urlPagamento: 'https://asaas/pagar/1' }),
    );
    vi.stubGlobal('fetch', fetchFalso);

    render(<ConfirmarEmailPage />);

    expect(await screen.findByText('E-mail confirmado')).toBeTruthy();
    const cta = screen.getByRole('link', { name: /ir para o pagamento/i });
    expect(cta.getAttribute('href')).toBe('https://asaas/pagar/1');

    /* O token viajou no corpo — e SAIU da barra de endereço: link com
       credencial não fica em histórico nem em print. */
    const corpo = JSON.parse((fetchFalso.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(corpo.token).toBe('abc123def456ghi789');
    expect(window.location.search).toBe('');
  });

  it('link vencido: mostra o erro da API e o caminho de refazer o cadastro', async () => {
    window.history.replaceState(null, '', '/confirmar-email?token=vencido123456789');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resposta(400, { mensagem: 'Este link venceu. Faça o cadastro novamente.' })),
    );

    render(<ConfirmarEmailPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/venceu/i);
    expect(screen.getByRole('link', { name: /refazer cadastro/i })).toBeTruthy();
  });

  it('sem token: o reenvio responde o MESMO texto genérico, exista ou não o e-mail', async () => {
    const fetchFalso = vi.fn(async () => resposta(200, { enviado: true }));
    vi.stubGlobal('fetch', fetchFalso);
    const user = userEvent.setup();

    render(<ConfirmarEmailPage />);
    expect(await screen.findByText(/confirme seu e-mail/i)).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: /e-mail/i }), 'qualquer@x.com');
    await user.click(screen.getByRole('button', { name: /reenviar link/i }));

    /* "Se existir, enviamos" — a tela nunca diz se a conta existe. */
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/se este e-mail tiver um cadastro/i),
    );
  });
});
