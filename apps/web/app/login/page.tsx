'use client';

import { AvisoCookies } from '@/components/aviso-cookies';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  ShieldAlert,
  Smartphone,
} from 'lucide-react';
import { Logo } from '@/components/logo';
import { LoginHero } from '@/components/login-hero';
import { LuzCinematica } from '@/components/luz-cinematica';
import { cn } from '@/lib/utils';

import { API_URL as API } from '@/lib/config';

/**
 * Por que a pessoa foi parar aqui — os códigos que `lib/api.ts` põe na URL.
 *
 * O texto mora no front porque é redação de tela; o CÓDIGO é o contrato, e ele
 * vem do campo `erro` da API (`token.service.ts`). Motivo desconhecido não
 * inventa explicação: some.
 */
const MOTIVO_DA_QUEDA: Record<string, string> = {
  OUTRA_SESSAO:
    'Sua conta foi aberta em outro dispositivo. Cada pessoa usa um perfil — se a equipe cresceu, o gestor pode criar mais perfis em Equipe.',
  SESSAO_ENCERRADA: 'Sua sessão foi encerrada. Entre novamente.',
  /* Só aparece quando a aba pausada TENTOU voltar e o servidor recusou — a
     pausa por si não manda ninguém para cá; ela volta com um clique. */
  inatividade: 'Sua sessão expirou depois de um tempo parada. Entre novamente.',
  /* Vem do SERVIDOR, quando a sessão passa do teto de horas paradas — diferente
     do `inatividade` acima, que é a aba se pausando sozinha. */
  SESSAO_OCIOSA: 'Sua sessão expirou por falta de uso. Entre novamente.',
};

/** Entrada em cascata — nada aparece de uma vez. */
const surgir = {
  oculto: { opacity: 0, y: 24, filter: 'blur(6px)' },
  visivel: (i: number) => ({
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { delay: 0.1 + i * 0.09, duration: 0.7, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [verSenha, setVerSenha] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  /**
   * O login virou de duas etapas para quem tem segundo fator.
   *
   * `desafio` guarda o bilhete devolvido pelo passo 1 e é o que decide qual
   * painel aparece. Ele NÃO é uma sessão — a API o recusa em qualquer rota
   * protegida —, então não vai para o sessionStorage: se a aba for recarregada,
   * o certo é recomeçar pela senha.
   */
  const [desafio, setDesafio] = useState<string | null>(null);
  const [codigo, setCodigo] = useState('');

  /**
   * O aviso de por que a sessão anterior acabou.
   *
   * Lido de `window.location.search` num efeito, e NÃO de `useSearchParams()`:
   * o hook obriga a página inteira a viver dentro de um `<Suspense>` — sem ele
   * o `next build` recusa a rota — e não há nada a suspender aqui, porque o
   * dado já chegou com a URL.
   *
   * O parâmetro é apagado da barra logo em seguida: recarregar a tela de login
   * não pode ressuscitar a explicação de uma queda que já foi lida.
   */
  const [avisoDeQueda, setAvisoDeQueda] = useState<string | null>(null);

  /** O retorno do gateway depois de pagar (callback do Asaas). */
  const [pagamentoConfirmado, setPagamentoConfirmado] = useState(false);

  useEffect(() => {
    const busca = new URLSearchParams(window.location.search);
    const motivo = busca.get('motivo');
    const pagamento = busca.get('pagamento');
    if (!motivo && !pagamento) return;
    if (motivo) setAvisoDeQueda(MOTIVO_DA_QUEDA[motivo] ?? null);
    /* O gateway devolve quem pagou para cá (callback do Asaas). O banner fecha
       a jornada: "pagou → está dentro" precisa de uma frase dizendo isso. */
    if (pagamento === 'confirmado') setPagamentoConfirmado(true);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  /** Guarda o access e entra. Comum aos dois caminhos. */
  function concluir(accessToken: string) {
    /* Só o access. O refresh veio no cookie httpOnly e este código não o vê —
       que é o ponto: um XSS não consegue levá-lo embora. */
    sessionStorage.setItem('miner.access', accessToken);
    router.push('/dashboard');
  }

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      const r = await fetch(`${API}/v1/auth/login`, {
        method: 'POST',
        /* `include` é o que faz o navegador ACEITAR o Set-Cookie do refresh —
           a API está noutra origem, e o padrão do fetch é `same-origin`. Sem
           isto o login pareceria funcionar e a sessão morreria em 15 minutos. */
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErro(r.status === 401 ? 'E-mail ou senha inválidos.' : (d?.mensagem ?? 'Não foi possível entrar.'));
        return;
      }

      /* Senha certa não basta: falta o segundo fator. Nenhum token chegou. */
      if (d.mfaRequerido) {
        setDesafio(d.desafio);
        return;
      }

      concluir(d.accessToken);
    } catch {
      setErro('Servidor indisponível. Verifique se a API está no ar.');
    } finally {
      setCarregando(false);
    }
  }

  async function verificar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setCarregando(true);
    try {
      const r = await fetch(`${API}/v1/auth/mfa/verificar`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desafio, codigo }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        /* O desafio vale 5 minutos. Expirado, insistir no código não leva a
           lugar nenhum — volta para a senha, dizendo por quê. */
        if (/expirado/i.test(d?.mensagem ?? '')) {
          setDesafio(null);
          setCodigo('');
          setErro('A verificação expirou. Entre com a senha novamente.');
          return;
        }
        setErro(d?.mensagem ?? 'Código inválido.');
        setCodigo('');
        return;
      }
      concluir(d.accessToken);
    } catch {
      setErro('Servidor indisponível. Verifique se a API está no ar.');
    } finally {
      setCarregando(false);
    }
  }

  function voltarParaSenha() {
    setDesafio(null);
    setCodigo('');
    setErro(null);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-bg">
      {/* Quem cai direto no login (favorito, link de e-mail) também nunca viu o
          aviso; é o outro ponto de entrada público além do site. */}
      <AvisoCookies />
      {/* ── Camada 1: auroras ── */}
      <div className="pointer-events-none absolute inset-0">
        <motion.div
          className="absolute -left-40 -top-40 h-[46rem] w-[46rem] rounded-full opacity-[0.22] blur-[130px]"
          style={{ background: 'radial-gradient(circle,#6366f1,transparent 68%)' }}
          animate={{ x: [0, 60, 0], y: [0, 40, 0], scale: [1, 1.12, 1] }}
          transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -right-52 top-1/4 h-[40rem] w-[40rem] rounded-full opacity-[0.2] blur-[130px]"
          style={{ background: 'radial-gradient(circle,#22d3ee,transparent 68%)' }}
          animate={{ x: [0, -50, 0], y: [0, 60, 0], scale: [1, 1.16, 1] }}
          transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut', delay: 3 }}
        />
        <motion.div
          className="absolute bottom-0 left-1/3 h-[34rem] w-[34rem] rounded-full opacity-[0.16] blur-[130px]"
          style={{ background: 'radial-gradient(circle,#8b5cf6,transparent 68%)' }}
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 30, repeat: Infinity, ease: 'easeInOut', delay: 6 }}
        />
      </div>

      {/* ── Camada 2: grade técnica ── */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(150,175,235,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(150,175,235,.055) 1px,transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: 'radial-gradient(ellipse 90% 70% at 50% 40%,#000 30%,transparent 78%)',
        }}
      />

      {/* ── Camada 3: luz cinematográfica ── */}
      <LuzCinematica />

      {/* ── Conteúdo ── */}
      <div className="relative mx-auto grid min-h-screen max-w-[1560px] items-center gap-12 px-6 pb-12 pt-24 lg:grid-cols-[1.55fr_27rem] lg:px-12">
        {/* Hero com mapa protagonista */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
            className="absolute left-6 top-8 z-10 lg:left-12"
          >
            <Logo tamanho="md" />
          </motion.div>
          <LoginHero />
        </div>

        {/* Painel de acesso */}
        <motion.section
          initial={{ opacity: 0, y: 32, filter: 'blur(10px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ delay: 0.35, duration: 0.85, ease: [0.16, 1, 0.3, 1] }}
          className="w-full lg:w-[27rem]"
        >
          <div className="relative">
            {/* borda com gradiente vivo */}
            <div
              className="absolute -inset-px rounded-[22px] opacity-60"
              style={{ background: 'linear-gradient(140deg,rgba(139,92,246,.55),rgba(59,130,246,.25) 45%,rgba(34,211,238,.45))' }}
            />
            <div className="relative rounded-[21px] border border-white/[0.07] bg-bg-2/70 p-8 shadow-elevado backdrop-blur-2xl sm:p-9">
              {desafio ? (
                <PainelCodigo
                  codigo={codigo}
                  onCodigo={setCodigo}
                  onSubmit={verificar}
                  onVoltar={voltarParaSenha}
                  carregando={carregando}
                  erro={erro}
                />
              ) : (
              <>
              <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">
                Acessar o sistema
              </h2>
              <p className="mt-1.5 text-sm text-muted">Entre com suas credenciais corporativas.</p>

              {/* `method="post"` mesmo com o JavaScript interceptando: sem ele o
                  padrão do HTML é GET, e um Enter dado antes da hidratação
                  mandaria E-MAIL E SENHA para a barra de endereços. A nota longa
                  está em `components/site/formulario-cadastro.tsx`. */}
              <form method="post" onSubmit={entrar} className="mt-8 space-y-5" noValidate>
                <Campo
                  id="email"
                  rotulo="E-mail"
                  Icone={Mail}
                  type="email"
                  value={email}
                  onChange={setEmail}
                  placeholder="voce@leaoamorim.com.br"
                  autoComplete="username"
                />

                <div>
                  <label htmlFor="senha" className="rotulo mb-2.5 block">
                    Senha
                  </label>
                  <div className="group relative">
                    <Lock className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2 transition-colors group-focus-within:text-marca-ciano" />
                    <input
                      id="senha"
                      type={verSenha ? 'text' : 'password'}
                      value={senha}
                      onChange={(e) => setSenha(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      className="h-[52px] w-full rounded-[14px] border border-white/[0.08] bg-white/[0.03] pl-11 pr-12 text-sm text-ink outline-none transition-all placeholder:text-muted-2 hover:border-white/[0.14] focus:border-marca-ciano/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
                    />
                    <button
                      type="button"
                      onClick={() => setVerSenha((v) => !v)}
                      aria-label={verSenha ? 'Ocultar senha' : 'Mostrar senha'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-2 text-muted-2 transition-colors hover:text-ink-2"
                    >
                      {verSenha ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <label className="flex cursor-pointer select-none items-center gap-2.5 text-[13px] text-ink-2">
                    <span className="relative flex h-[18px] w-[18px] items-center justify-center">
                      <input type="checkbox" className="peer h-[18px] w-[18px] cursor-pointer appearance-none rounded-[6px] border border-white/[0.14] bg-white/[0.04] transition-colors checked:border-transparent checked:bg-aurora-4" />
                      <svg className="pointer-events-none absolute h-3 w-3 scale-0 text-white transition-transform peer-checked:scale-100" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6.2l2.3 2.3 4.7-4.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    Lembrar de mim
                  </label>
                  {/* Até 20/08/2026 isto era um <button> sem handler: parecia
                      clicável e não levava a lugar nenhum. Botão que promete e
                      não entrega é pior que botão ausente — quem esquecia a
                      senha ficava sem caminho, e o suporte resolvia no banco. */}
                  <a
                    href="/esqueci-senha"
                    className="text-[13px] text-aurora-3 transition-colors hover:text-marca-ciano"
                  >
                    Esqueceu sua senha?
                  </a>
                </div>

                {/* ── POR QUE VOCÊ CAIU AQUI ──
                    Âmbar, e não vermelho: não é falha de quem está lendo. E
                    acima do erro de propósito — quem foi derrubado e erra a
                    senha na volta precisa das duas informações, na ordem em que
                    aconteceram. */}
                {pagamentoConfirmado && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="flex items-start gap-2.5 rounded-[14px] border border-ok/25 bg-ok/[0.08] px-4 py-3 text-sm text-ok"
                    role="status"
                  >
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      Pagamento confirmado! Entre com seu e-mail e senha — sua carteira já está
                      sendo preparada.
                    </span>
                  </motion.div>
                )}

                {avisoDeQueda && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="flex items-start gap-2.5 rounded-[14px] border border-alerta/25 bg-alerta/[0.08] px-4 py-3 text-sm text-alerta"
                    role="status"
                  >
                    <Info className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{avisoDeQueda}</span>
                  </motion.div>
                )}

                {erro && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    className="flex items-start gap-2.5 rounded-[14px] border border-erro/25 bg-erro/[0.08] px-4 py-3 text-sm text-erro"
                    role="alert"
                  >
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{erro}</span>
                  </motion.div>
                )}

                <motion.button
                  type="submit"
                  disabled={carregando || !email || !senha}
                  whileHover={{ scale: 1.012 }}
                  whileTap={{ scale: 0.988 }}
                  className={cn(
                    'group relative flex h-[52px] w-full items-center justify-center gap-2.5 overflow-hidden rounded-[14px]',
                    'font-display text-[15px] font-semibold text-white',
                    'transition-shadow duration-300 disabled:cursor-not-allowed disabled:opacity-40',
                    /* Sombra por classe, não inline: estilo inline vence classe sem
                       !important, então um boxShadow no style matava o hover. E o
                       hover repete o anel ciano de propósito — utilitário shadow-*
                       reescreve a propriedade inteira, não soma à anterior. */
                    'shadow-[0_0_0_1px_rgba(38,213,238,.28),0_8px_30px_-10px_rgba(38,213,238,.4)]',
                    'hover:shadow-[0_0_0_1px_rgba(38,213,238,.5),0_0_80px_-20px_rgba(99,102,241,.65)]',
                  )}
                  /* O gradiente vivo terminava em #22d3ee, onde o texto branco caía
                     para 1,81:1 — bem abaixo do mínimo de 4,5:1 (15px semibold não
                     conta como "texto grande"). Estas paradas ficam entre 6,3:1 e
                     9,9:1. O ciano da marca migrou para a aura externa, que não
                     carrega texto e por isso não tem exigência de contraste. */
                  style={{ background: 'linear-gradient(120deg,#4f46e5,#4338ca 55%,#3730a3)' }}
                >
                  {/* varredura de luz no hover */}
                  <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
                  {carregando ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Entrando…
                    </>
                  ) : (
                    <>
                      Entrar <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
                    </>
                  )}
                </motion.button>
              </form>
              </>
              )}

              <div className="mt-7 flex items-start gap-2.5 border-t border-linha pt-6 text-[11px] leading-relaxed text-muted-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <span>
                  Acessos são registrados para fins de auditoria e proteção de dados,
                  conforme a LGPD.
                </span>
              </div>
            </div>
          </div>

          <p className="mt-6 text-center text-[11px] text-muted-2">
            © {new Date().getFullYear()} Leão Amorim Tecnologia
          </p>
        </motion.section>
      </div>
    </main>
  );
}

/**
 * Segunda etapa: o código do app autenticador.
 *
 * Aceita TAMBÉM um código de recuperação — e o campo diz isso, porque quem está
 * sem o telefone precisa descobrir a saída na hora em que ela é necessária, e
 * não num artigo de ajuda. Por isso `inputMode="text"` e nenhum limite de 6
 * caracteres: travar o campo em seis dígitos deixaria o código de recuperação
 * impossível de digitar.
 */
function PainelCodigo({
  codigo,
  onCodigo,
  onSubmit,
  onVoltar,
  carregando,
  erro,
}: {
  codigo: string;
  onCodigo: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onVoltar: () => void;
  carregando: boolean;
  erro: string | null;
}) {
  return (
    <>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/[0.08] bg-white/[0.04]">
          <Smartphone className="h-[18px] w-[18px] text-marca-ciano" />
        </span>
        <div>
          <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">
            Verificação em duas etapas
          </h2>
          <p className="text-sm text-muted">Abra seu aplicativo autenticador.</p>
        </div>
      </div>

      <form method="post" onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
        <div>
          <label htmlFor="codigo" className="rotulo mb-2.5 block">
            Código de verificação
          </label>
          <div className="group relative">
            <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2 transition-colors group-focus-within:text-marca-ciano" />
            <input
              id="codigo"
              value={codigo}
              onChange={(e) => onCodigo(e.target.value)}
              placeholder="000000"
              /* `one-time-code` é o que faz o iOS e o Android oferecerem o
                 preenchimento automático a partir do app autenticador. */
              autoComplete="one-time-code"
              inputMode="text"
              autoFocus
              className="h-[52px] w-full rounded-[14px] border border-white/[0.08] bg-white/[0.03] pl-11 pr-4 text-center font-mono text-lg tracking-[0.3em] text-ink outline-none transition-all placeholder:tracking-[0.3em] placeholder:text-muted-2 hover:border-white/[0.14] focus:border-marca-ciano/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
            />
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-muted-2">
            Sem o telefone? Use um dos seus <strong className="text-ink-2">códigos de
            recuperação</strong> — eles funcionam neste mesmo campo.
          </p>
        </div>

        {erro && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="flex items-start gap-2.5 rounded-[14px] border border-erro/25 bg-erro/[0.08] px-4 py-3 text-sm text-erro"
            role="alert"
          >
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{erro}</span>
          </motion.div>
        )}

        <motion.button
          type="submit"
          disabled={carregando || codigo.trim().length < 6}
          whileHover={{ scale: 1.012 }}
          whileTap={{ scale: 0.988 }}
          className={cn(
            'group relative flex h-[52px] w-full items-center justify-center gap-2.5 overflow-hidden rounded-[14px]',
            'font-display text-[15px] font-semibold text-white',
            'transition-shadow duration-300 disabled:cursor-not-allowed disabled:opacity-40',
            'shadow-[0_0_0_1px_rgba(38,213,238,.28),0_8px_30px_-10px_rgba(38,213,238,.4)]',
            'hover:shadow-[0_0_0_1px_rgba(38,213,238,.5),0_0_80px_-20px_rgba(99,102,241,.65)]',
          )}
          style={{ background: 'linear-gradient(120deg,#4f46e5,#4338ca 55%,#3730a3)' }}
        >
          <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
          {carregando ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Verificando…
            </>
          ) : (
            <>
              Verificar <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </>
          )}
        </motion.button>

        <button
          type="button"
          onClick={onVoltar}
          className="flex w-full items-center justify-center gap-1.5 text-[13px] text-muted transition-colors hover:text-ink-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Entrar com outra conta
        </button>
      </form>
    </>
  );
}

function Campo({
  id,
  rotulo,
  Icone,
  value,
  onChange,
  ...props
}: {
  id: string;
  rotulo: string;
  Icone: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <div>
      <label htmlFor={id} className="rotulo mb-2.5 block">
        {rotulo}
      </label>
      <div className="group relative">
        <Icone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2 transition-colors group-focus-within:text-marca-ciano" />
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-[52px] w-full rounded-[14px] border border-white/[0.08] bg-white/[0.03] pl-11 pr-4 text-sm text-ink outline-none transition-all placeholder:text-muted-2 hover:border-white/[0.14] focus:border-marca-ciano/50 focus:bg-white/[0.05] focus:shadow-[0_0_0_4px_rgba(38,213,238,.08)]"
          {...props}
        />
      </div>
    </div>
  );
}
