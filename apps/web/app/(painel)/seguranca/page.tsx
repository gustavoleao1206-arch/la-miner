'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Smartphone,
} from 'lucide-react';
import {
  confirmarMfa,
  desativarMfa,
  exportarMinhaConta,
  iniciarMfa,
  renovarCodigosMfa,
  situacaoMfa,
  type SituacaoMfa,
} from '@/lib/api';
import { QrCode } from '@/components/qr-code';
import { cn } from '@/lib/utils';

/**
 * Verificação em duas etapas.
 *
 * Esta tela é o destino do 403 `MFA_OBRIGATORIO`: quando a política do ambiente
 * exige o segundo fator e o usuário ainda não cadastrou, o cliente da API o traz
 * para cá com `?obrigatorio=1`. É por isso que ela precisa funcionar para quem
 * está bloqueado em todo o resto do sistema — as rotas que ela usa são as únicas
 * isentas da política, do lado da API.
 */
export default function SegurancaPage() {
  const qc = useQueryClient();
  const { data: situacao, isLoading } = useQuery<SituacaoMfa>({
    queryKey: ['mfa'],
    queryFn: situacaoMfa,
  });

  const [cadastro, setCadastro] = useState<{ segredo: string; uri: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [codigos, setCodigos] = useState<string[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const bloqueado =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('obrigatorio');

  async function comErro(fn: () => Promise<void>) {
    setErro(null);
    setOcupado(true);
    try {
      await fn();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  }

  const comecar = () =>
    comErro(async () => {
      setCadastro(await iniciarMfa());
      setCodigo('');
    });

  const confirmar = () =>
    comErro(async () => {
      const { codigos } = await confirmarMfa(codigo);
      setCodigos(codigos);
      setCadastro(null);
      setCodigo('');
      await qc.invalidateQueries({ queryKey: ['mfa'] });
    });

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">Segurança</h1>
        <p className="mt-1 text-sm text-muted">
          Verificação em duas etapas para a sua conta.
        </p>
      </header>

      {bloqueado && !situacao?.habilitado && (
        <Aviso tom="alerta" Icone={AlertTriangle}>
          Este ambiente exige verificação em duas etapas para o seu perfil. Conclua o cadastro
          abaixo para voltar a usar o sistema.
        </Aviso>
      )}

      {erro && (
        <Aviso tom="erro" Icone={AlertTriangle}>
          {erro}
        </Aviso>
      )}

      {/* ── Os códigos, logo após confirmar. Aparecem UMA vez. ── */}
      {codigos && <CodigosDeRecuperacao codigos={codigos} aoFechar={() => setCodigos(null)} />}

      <section className="rounded-2xl border border-linha bg-bg-2/60 p-6">
        {situacao?.habilitado ? (
          <Ativo
            situacao={situacao}
            ocupado={ocupado}
            aoRenovar={(c) =>
              comErro(async () => {
                const { codigos } = await renovarCodigosMfa(c);
                setCodigos(codigos);
                await qc.invalidateQueries({ queryKey: ['mfa'] });
              })
            }
            aoDesativar={(senha) =>
              comErro(async () => {
                await desativarMfa(senha);
                await qc.invalidateQueries({ queryKey: ['mfa'] });
              })
            }
          />
        ) : cadastro ? (
          <Cadastro
            segredo={cadastro.segredo}
            uri={cadastro.uri}
            codigo={codigo}
            onCodigo={setCodigo}
            onConfirmar={confirmar}
            ocupado={ocupado}
          />
        ) : (
          <Inativo
            pendente={situacao?.cadastroPendente ?? false}
            obrigatorio={situacao?.obrigatorio ?? false}
            ocupado={ocupado}
            aoComecar={comecar}
          />
        )}
      </section>

      <MeusDados />
    </div>
  );
}

/**
 * PORTABILIDADE — o cliente leva os próprios dados sem pedir a ninguém.
 *
 * A auditoria de LGPD apontou que o assinante não tinha como exportar o que era
 * dele: ele é titular de dados também (cadastro, usuários, financeiro), e o
 * art. 18, V fala em portabilidade. A rota existia só para o titular de
 * precatório; faltava esta ponta.
 *
 * ── O QUE O BOTÃO NÃO TRAZ, E POR QUE O TEXTO DIZ ISSO ANTES DO CLIQUE ──
 *
 * A carteira e os contatos dos titulares ficam de fora, por decisão do dono. O
 * aviso vem ANTES do clique, e não numa nota de rodapé do arquivo: quem baixa
 * esperando a agenda e descobre depois tem razão em reclamar, e o momento certo
 * de gerenciar essa expectativa é aqui.
 */
function MeusDados() {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function baixar() {
    setOcupado(true);
    setErro(null);
    try {
      const dados = await exportarMinhaConta();
      /* Blob + link temporário: o arquivo nasce no navegador e nunca toca o
         nosso disco. Não há endpoint servindo arquivo, então não há arquivo
         nosso para vazar, expirar ou esquecer de apagar. */
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = `meus-dados-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não foi possível gerar o arquivo.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <section className="rounded-2xl border border-linha bg-bg-2/60 p-6">
      <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink">
        <Download className="h-4 w-4 text-marca-ciano" />
        Seus dados
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
        Baixe um arquivo com o cadastro do escritório, os usuários, a assinatura, as faturas e o
        histórico de ciclos recebidos. É o seu direito de portabilidade, e não depende de pedir
        nada a ninguém.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        O arquivo <strong>não inclui</strong> a carteira de processos nem os contatos dos
        titulares: são dados de pessoas que não contrataram este serviço, e reuni-los num arquivo
        único criaria um risco que não é seu. Cada titular pede os próprios dados pelo canal de
        privacidade.
      </p>

      {erro && (
        <p role="alert" className="mt-3 text-sm text-erro">
          {erro}
        </p>
      )}

      <button
        onClick={() => void baixar()}
        disabled={ocupado}
        className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-marca px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
        Baixar meus dados
      </button>
    </section>
  );
}

// ── Estados ────────────────────────────────────────────────

function Inativo({
  pendente,
  obrigatorio,
  ocupado,
  aoComecar,
}: {
  pendente: boolean;
  obrigatorio: boolean;
  ocupado: boolean;
  aoComecar: () => void;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-linha bg-white/[0.03]">
        <ShieldOff className="h-5 w-5 text-muted" />
      </span>
      <div className="flex-1">
        <h2 className="font-display text-base font-semibold text-ink">
          Verificação em duas etapas desativada
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Com ela ligada, entrar passa a exigir também um código de seis dígitos gerado no seu
          telefone — quem descobrir sua senha ainda não entra.
          {obrigatorio && ' A política deste ambiente exige esta proteção para o seu perfil.'}
        </p>
        {pendente && (
          <p className="mt-2 text-[13px] text-alerta">
            Há um cadastro começado e não concluído. Recomeçar gera uma chave nova.
          </p>
        )}
        <button
          onClick={aoComecar}
          disabled={ocupado}
          className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-aurora-4 px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          {pendente ? 'Recomeçar cadastro' : 'Ativar'}
        </button>
      </div>
    </div>
  );
}

function Cadastro({
  segredo,
  uri,
  codigo,
  onCodigo,
  onConfirmar,
  ocupado,
}: {
  segredo: string;
  uri: string;
  codigo: string;
  onCodigo: (v: string) => void;
  onConfirmar: () => void;
  ocupado: boolean;
}) {
  /* Em grupos de quatro: é assim que se confere ao digitar numa tela pequena, e
     o decodificador Base32 da API ignora os espaços de propósito. */
  const legivel = segredo.replace(/(.{4})/g, '$1 ').trim();

  return (
    <div>
      <h2 className="font-display text-base font-semibold text-ink">
        1. Leia o código no aplicativo
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        No Google Authenticator, Microsoft Authenticator, 1Password ou Authy, escolha adicionar uma
        conta e aponte a câmera para o código abaixo.
      </p>

      <div className="mt-4 flex flex-col items-start gap-5 sm:flex-row sm:items-center">
        <QrCode
          conteudo={uri}
          rotulo="Código QR para cadastrar a verificação em duas etapas no seu aplicativo autenticador"
        />

        {/* A chave por extenso continua VISÍVEL, e não escondida atrás de um
            "mostrar". Ela é o caminho de quem lê a tela com leitor de tela (que
            não escaneia nada), de quem usa o gerenciador de senhas no mesmo
            aparelho e não tem uma segunda câmera para apontar, e de quem
            simplesmente não conseguiu o foco. Esconder o alternativo é esconder
            a saída de quem já está com dificuldade. */}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-2">Não consegue escanear?</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            No aplicativo, escolha{' '}
            <strong className="text-ink-2">inserir uma chave de configuração</strong> e use:
          </p>
          <div className="mt-2.5 rounded-xl border border-linha bg-white/[0.02] p-3">
            <code className="block select-all break-all font-mono text-[14px] tracking-wider text-ink">
              {legivel}
            </code>
            <div className="mt-2.5">
              <BotaoCopiar valor={segredo} />
            </div>
          </div>
        </div>
      </div>

      {/* O QR e a chave são a MESMA coisa: o segredo da conta. Quem fotografar a
          tela leva o segundo fator junto — por isso o aviso fala dos dois. */}
      <p className="mt-3 flex items-start gap-2 text-[12px] leading-relaxed text-muted-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        O código e a chave são o segredo da sua conta — quem os vir consegue gerar os seus códigos.
        Não os compartilhe nem fotografe esta tela; depois de cadastrados no aplicativo, não
        precisam mais existir em lugar nenhum.
      </p>

      <h2 className="mt-7 font-display text-base font-semibold text-ink">
        2. Confirme com o código que apareceu
      </h2>
      <p className="mt-1.5 text-sm text-muted">
        A confirmação existe para provar que o aplicativo leu a chave corretamente — sem ela, um
        cadastro malfeito só apareceria no próximo login, com você do lado de fora.
      </p>

      <div className="mt-4 flex gap-3">
        <input
          value={codigo}
          onChange={(e) => onCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          className="h-11 w-40 rounded-xl border border-linha bg-white/[0.03] px-4 text-center font-mono text-lg tracking-[0.25em] text-ink outline-none focus:border-marca-ciano/50"
        />
        <button
          onClick={onConfirmar}
          disabled={ocupado || codigo.length !== 6}
          className="inline-flex h-11 items-center gap-2 rounded-xl bg-aurora-4 px-5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {ocupado ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Confirmar
        </button>
      </div>
    </div>
  );
}

function Ativo({
  situacao,
  ocupado,
  aoRenovar,
  aoDesativar,
}: {
  situacao: SituacaoMfa;
  ocupado: boolean;
  aoRenovar: (codigo: string) => void;
  aoDesativar: (senha: string) => void;
}) {
  const [codigo, setCodigo] = useState('');
  const [senha, setSenha] = useState('');
  const [desativando, setDesativando] = useState(false);

  return (
    <div className="space-y-7">
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-ok/25 bg-ok/[0.08]">
          <ShieldCheck className="h-5 w-5 text-ok" />
        </span>
        <div>
          <h2 className="font-display text-base font-semibold text-ink">
            Verificação em duas etapas ativa
          </h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-sm text-muted">
            <Smartphone className="h-3.5 w-3.5" />
            Entrar exige o código do seu aplicativo autenticador.
          </p>
        </div>
      </div>

      {/* ── Códigos restantes ── */}
      <div className="rounded-xl border border-linha bg-white/[0.02] p-4">
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <KeyRound className="h-4 w-4 text-muted" />
          <strong className="font-medium">{situacao.codigosDisponiveis}</strong> de 10 códigos de
          recuperação disponíveis
        </div>
        {situacao.codigosDisponiveis <= 3 && (
          <p className="mt-2 text-[13px] text-alerta">
            Restam poucos. Emita um jogo novo enquanto ainda tem acesso ao aplicativo — sem código
            e sem telefone, só o administrador consegue devolver a conta.
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <input
            value={codigo}
            onChange={(e) => setCodigo(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            inputMode="numeric"
            className="h-10 w-32 rounded-lg border border-linha bg-white/[0.03] px-3 text-center font-mono tracking-widest text-ink outline-none focus:border-marca-ciano/50"
          />
          <button
            onClick={() => {
              aoRenovar(codigo);
              setCodigo('');
            }}
            disabled={ocupado || codigo.length !== 6}
            className="h-10 rounded-lg border border-linha px-4 text-sm text-ink-2 transition-colors hover:bg-white/[0.04] disabled:opacity-40"
          >
            Emitir novos
          </button>
        </div>
      </div>

      {/* ── Desativar ── */}
      <div className="border-t border-linha pt-6">
        {!desativando ? (
          <button
            onClick={() => setDesativando(true)}
            disabled={situacao.obrigatorio}
            title={
              situacao.obrigatorio
                ? 'A política deste ambiente exige a verificação em duas etapas para o seu perfil.'
                : undefined
            }
            className="text-sm text-erro transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:text-muted-2 disabled:opacity-100"
          >
            Desativar verificação em duas etapas
          </button>
        ) : (
          <div>
            <p className="text-sm text-ink-2">
              Confirme com a sua <strong>senha</strong>.
            </p>
            {/* Pede a senha, e não um código: o cenário a proteger é o telefone
                perdido com a sessão aberta — quem o achou tem o autenticador. */}
            <p className="mt-1 text-[12px] text-muted-2">
              Pedimos a senha, e não um código do aplicativo, porque quem está com o seu telefone
              teria o aplicativo em mãos.
            </p>
            <div className="mt-3 flex gap-2">
              <input
                type="password"
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                placeholder="Sua senha"
                autoComplete="current-password"
                className="h-10 w-56 rounded-lg border border-linha bg-white/[0.03] px-3 text-sm text-ink outline-none focus:border-marca-ciano/50"
              />
              <button
                onClick={() => {
                  aoDesativar(senha);
                  setSenha('');
                  setDesativando(false);
                }}
                disabled={ocupado || !senha}
                className="h-10 rounded-lg bg-erro px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Desativar
              </button>
              <button
                onClick={() => {
                  setDesativando(false);
                  setSenha('');
                }}
                className="h-10 rounded-lg border border-linha px-4 text-sm text-muted transition-colors hover:text-ink-2"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Os códigos aparecem UMA vez.
 *
 * Não há como reexibi-los: o banco só tem o hash. Por isso o bloco é insistente
 * — quem fechar sem guardar terá de emitir um jogo novo, e quem perder o
 * telefone antes disso fica dependendo do administrador.
 */
function CodigosDeRecuperacao({ codigos, aoFechar }: { codigos: string[]; aoFechar: () => void }) {
  return (
    <section className="rounded-2xl border border-alerta/30 bg-alerta/[0.06] p-6">
      <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink">
        <KeyRound className="h-4 w-4 text-alerta" />
        Guarde estes códigos agora
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-2">
        Eles são a sua saída se você perder o telefone. Cada um serve <strong>uma vez</strong>, e
        esta é a <strong>única vez</strong> que aparecem — o sistema guarda apenas um resumo
        criptográfico deles, e não consegue mostrá-los de novo.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-2">
        {codigos.map((c) => (
          <code
            key={c}
            className="select-all rounded-lg border border-linha bg-bg/60 px-3 py-2 text-center font-mono text-sm tracking-wider text-ink"
          >
            {c}
          </code>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <BotaoCopiar valor={codigos.join('\n')} rotulo="Copiar todos" />
        <button
          onClick={aoFechar}
          className="h-10 rounded-lg border border-linha px-4 text-sm text-ink-2 transition-colors hover:bg-white/[0.04]"
        >
          Já guardei
        </button>
      </div>
    </section>
  );
}

// ── Peças ──────────────────────────────────────────────────

function BotaoCopiar({ valor, rotulo }: { valor: string; rotulo?: string }) {
  const [copiado, setCopiado] = useState(false);

  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(valor);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch {
          /* Sem permissão de área de transferência: o texto é `select-all`, e dá
             para copiar à mão. Falhar em silêncio é melhor que um alerta que não
             ajuda a resolver. */
        }
      }}
      className={cn(
        'inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-linha px-3 text-sm transition-colors',
        copiado ? 'text-ok' : 'text-ink-2 hover:bg-white/[0.04]',
      )}
    >
      {copiado ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {copiado ? 'Copiado' : (rotulo ?? 'Copiar')}
    </button>
  );
}

function Aviso({
  tom,
  Icone,
  children,
}: {
  tom: 'alerta' | 'erro';
  Icone: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm',
        tom === 'erro'
          ? 'border-erro/25 bg-erro/[0.08] text-erro'
          : 'border-alerta/30 bg-alerta/[0.07] text-alerta',
      )}
    >
      <Icone className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
