'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/config';
import type { PlanoComercial } from '@/lib/plano-comercial';

/**
 * O formulário de assinatura.
 *
 * ── POR QUE NÃO USA O `lib/api.ts` ──
 *
 * Aquele cliente existe para o PAINEL: anexa o token de acesso, renova no 401,
 * redireciona para /login quando a sessão morre e desvia o 402 para
 * /assinatura. Aqui não há sessão nenhuma — quem preenche este formulário
 * ainda não é usuário —, e cada um desses comportamentos seria errado: um 409
 * de "e-mail já cadastrado" não pode levar ninguém para a tela de login sem
 * explicação. `fetch` puro, com o tratamento de erro que esta tela precisa.
 */

type Campos = {
  nomeEscritorio: string;
  documento: string;
  telefone: string;
  nomeResponsavel: string;
  email: string;
  senha: string;
};

const VAZIO: Campos = {
  nomeEscritorio: '',
  documento: '',
  telefone: '',
  nomeResponsavel: '',
  email: '',
  senha: '',
};

/** Rótulo, dica e tipo de cada campo — fora do JSX, que é só a estrutura. */
const CAMPOS: {
  chave: keyof Campos;
  rotulo: string;
  tipo?: string;
  dica?: string;
  autoComplete?: string;
}[] = [
  { chave: 'nomeEscritorio', rotulo: 'Nome do escritório', autoComplete: 'organization' },
  { chave: 'documento', rotulo: 'CNPJ (ou CPF)', dica: 'Usado para emitir a cobrança.' },
  { chave: 'telefone', rotulo: 'Telefone com DDD', autoComplete: 'tel' },
  { chave: 'nomeResponsavel', rotulo: 'Seu nome', autoComplete: 'name' },
  { chave: 'email', rotulo: 'E-mail', tipo: 'email', autoComplete: 'email' },
  {
    chave: 'senha',
    rotulo: 'Senha',
    tipo: 'password',
    dica: 'Ao menos 12 caracteres. Uma frase longa é melhor que símbolos.',
    autoComplete: 'new-password',
  },
];

export function FormularioCadastro({ plano }: { plano: PlanoComercial }) {
  const [campos, setCampos] = useState<Campos>(VAZIO);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [semLink, setSemLink] = useState(false);
  const [confirmarEmail, setConfirmarEmail] = useState<string | null>(null);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      /* `/v1`: a API é versionada e `API_URL` para em `/api`. Sem ele, todo
         cadastro morreria em 404 — e aqui não haveria degradação graciosa para
         esconder, só um erro genérico na cara de quem estava comprando. */
      const r = await fetch(`${API_URL}/v1/cadastro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...campos, planoId: plano.id }),
      });

      const corpo = await r.json().catch(() => ({}));

      if (!r.ok) {
        /* `mensagem`, com E — o filtro de exceções desta API renomeia o campo,
           e `lib/api.ts` já lia assim. Escrito como `message`, todo erro de
           validação virava o texto genérico do fallback: quem errasse um dígito
           do CNPJ não descobriria qual campo consertar, e um ajuste de dez
           segundos viraria abandono de carrinho.
           `message` fica no `??` como rede, para o caso de a resposta vir de
           algo que não passou pelo filtro (um 502 do proxy, por exemplo).
           O ValidationPipe manda ARRAY quando há mais de um campo inválido. */
        const m = corpo?.mensagem ?? corpo?.message;
        setErro(
          Array.isArray(m) ? m.join(' ') : (m ?? 'Não foi possível concluir o cadastro.'),
        );
        return;
      }

      /* Com a confirmação obrigatória LIGADA no servidor, não há link de
         pagamento ainda — ele nasce quando o e-mail for confirmado. A tela
         vira instrução, e o endereço digitado fica à vista de propósito: é a
         última chance de a pessoa perceber o typo ANTES de procurar um e-mail
         que nunca vai chegar. */
      if (corpo?.confirmacaoPendente) {
        setConfirmarEmail(String(corpo.email ?? campos.email));
        return;
      }

      if (corpo?.urlPagamento) {
        /* Sai do nosso site para o checkout do gateway. `assign` e não `replace`
           de propósito: o botão "voltar" do navegador precisa trazer a pessoa
           de volta para cá se ela desistir do pagamento. */
        window.location.assign(corpo.urlPagamento);
        return;
      }

      /* Conta criada e sem link: ou o gateway falhou, ou a cobrança está em
         modo manual. Nos dois casos a conta é boa e o caminho é entrar — a
         tela de assinatura mostra o estado e o que fazer. */
      setSemLink(true);
    } catch {
      setErro('Não conseguimos falar com o servidor. Verifique sua conexão e tente de novo.');
    } finally {
      setEnviando(false);
    }
  }

  if (confirmarEmail) {
    return (
      <div className="rounded-lg border border-linha bg-superficie p-8 text-center">
        <h2 className="font-display text-lg font-semibold text-ink">Falta um passo: confirme seu e-mail</h2>
        <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted text-justify">
          Enviamos um link de confirmação para{' '}
          <strong className="text-ink">{confirmarEmail}</strong>. O pagamento abre depois do
          clique, e nada é cobrado antes disso.
        </p>
        <p className="mx-auto mt-3 max-w-sm text-[13px] leading-relaxed text-muted-2 text-justify">
          Não chegou em alguns minutos? Confira o spam, ou reenvie o link na página de
          confirmação. Digitou o e-mail errado? É só refazer o cadastro: o link vencido
          libera o CNPJ sozinho.
        </p>
        <a
          href="/confirmar-email"
          className="mt-6 inline-flex rounded-sm border border-linha px-6 py-3 font-semibold text-ink-2"
        >
          Não recebi o e-mail
        </a>
      </div>
    );
  }

  if (semLink) {
    return (
      <div className="rounded-lg border border-linha bg-superficie p-8 text-center">
        <h2 className="font-display text-lg font-semibold text-ink">Conta criada</h2>
        <p className="mx-auto mt-3 max-w-sm text-[15px] leading-relaxed text-muted text-justify">
          Não foi possível abrir o pagamento agora, mas a sua conta já existe. Entre com o e-mail
          e a senha que você cadastrou. A tela de assinatura mostra como concluir.
        </p>
        <a
          href="/login"
          className="mt-6 inline-flex rounded-sm bg-marca px-6 py-3 font-semibold text-white shadow-brilho"
        >
          Ir para o login
        </a>
      </div>
    );
  }

  /* `method="post"` num formulário que o JavaScript intercepta parece supérfluo
     — e não é. Sem o atributo, o padrão do HTML é GET: se alguém apertar Enter
     antes de a página hidratar, ou o script falhar, o navegador submete
     NATIVAMENTE e joga senha, e-mail, documento e telefone na BARRA DE
     ENDEREÇOS — de onde vão para o histórico, para o log do proxy e para o
     cabeçalho Referer da requisição seguinte.

     Não é teoria: foi assim que um pentest com OWASP ZAP encontrou este
     formulário, e o relatório traz a URL `/cadastro?...&senha=...` por extenso.
     O handler continua chamando `preventDefault`; o atributo só torna seguro o
     caminho degradado. Vale para os doze formulários do projeto. */
  return (
    <form method="post" onSubmit={enviar} className="rounded-lg border border-linha bg-superficie p-7 shadow-cartao">
      <div className="grid gap-5 sm:grid-cols-2">
        {CAMPOS.map(({ chave, rotulo, tipo, dica, autoComplete }) => (
          <div key={chave} className={chave === 'senha' ? 'sm:col-span-2' : ''}>
            <label htmlFor={chave} className="rotulo mb-1.5 block">
              {rotulo}
            </label>
            <input
              id={chave}
              name={chave}
              type={tipo ?? 'text'}
              required
              autoComplete={autoComplete}
              value={campos[chave]}
              onChange={(e) => setCampos((c) => ({ ...c, [chave]: e.target.value }))}
              className="w-full rounded-sm border border-linha bg-bg-2 px-3.5 py-2.5 text-[15px] text-ink outline-none transition-colors focus:border-marca-ciano"
            />
            {dica && <p className="mt-1.5 text-[12px] text-muted-2">{dica}</p>}
          </div>
        ))}
      </div>

      {erro && (
        <p
          role="alert"
          className="mt-5 rounded-sm border border-erro/30 bg-erro/10 p-3 text-[13px] leading-relaxed text-erro text-justify"
        >
          {erro}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="mt-7 flex w-full items-center justify-center rounded-sm bg-marca px-6 py-3.5 font-semibold text-white shadow-brilho transition-transform hover:scale-[1.01] disabled:opacity-60 disabled:hover:scale-100"
      >
        {enviando ? 'Criando sua conta…' : 'Continuar para o pagamento'}
      </button>

      {/* O ACEITE precisa estar ONDE se aceita. Documento legal linkado só no
          rodapé da landing não vincula quem assinou pelo formulário — o
          consentimento tem que estar no gesto, e o gesto é este botão. */}
      <p className="mt-3 text-center text-[12px] leading-relaxed text-muted-2 text-justify">
        Ao criar a conta, você declara ter lido e aceito os{' '}
        <a href="/termos" target="_blank" rel="noopener" className="underline hover:text-ink">
          Termos de Uso
        </a>{' '}
        e a{' '}
        <a href="/privacidade" target="_blank" rel="noopener" className="underline hover:text-ink">
          Política de Privacidade
        </a>
        .
      </p>

      <p className="mt-2 text-center text-[12px] leading-relaxed text-muted-2 text-justify">
        O acesso à carteira abre depois que o pagamento for confirmado.
      </p>
    </form>
  );
}
