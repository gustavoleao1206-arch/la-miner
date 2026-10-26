'use client';

import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Users,
  Plus,
  RefreshCw,
  Loader2,
  KeyRound,
  Copy,
  Check,
  ShieldCheck,
  RotateCcw,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUsuario } from '@/lib/usuario';
import { CARREGANDO, type Estado, BlocoErro, Vazio } from '@/components/estado';

interface Membro {
  id: string;
  nome: string;
  email: string;
  papel: 'ADMIN' | 'OPERADOR' | 'CLIENTE';
  gestor: boolean;
  ativo: boolean;
  ultimoLoginEm: string | null;
  criadoEm: string;
}

interface Acesso {
  email: string;
  senhaInicial: string;
  aviso: string;
}

/**
 * O teto de perfis do plano.
 *
 * `limite: null` = SEM TETO, e é o caso da operação interna, que não assina
 * plano nenhum. Não é o mesmo que zero, e a tela não pode imprimir "0 perfis"
 * onde o servidor disse "não se aplica".
 */
interface Assentos {
  usados: number;
  limite: number | null;
}

interface Equipe {
  usuarios: Membro[];
  assentos: Assentos;
}

const PAPEL_ROTULO: Record<Membro['papel'], string> = {
  ADMIN: 'Administrador',
  OPERADOR: 'Operador',
  CLIENTE: 'Usuário',
};

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : 'nunca';

export default function EquipePage() {
  const { usuario, ehCliente } = useUsuario();
  const [equipe, setEquipe] = useState<Estado<Equipe>>(CARREGANDO);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);
  const [acesso, setAcesso] = useState<Acesso | null>(null);
  const [copiado, setCopiado] = useState(false);

  const [abrirForm, setAbrirForm] = useState(false);
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [gestor, setGestor] = useState(false);
  /* Só o ADMIN da plataforma escolhe papel — para os demais o backend deriva do
     ator e ignora o que vier no corpo. Não ofereço um campo que seria ignorado. */
  const [papel, setPapel] = useState<'OPERADOR' | 'ADMIN'>('OPERADOR');

  const carregar = useCallback(async () => {
    try {
      setEquipe({ st: 'ok', dados: await api<Equipe>('/usuarios') });
    } catch (e) {
      setEquipe({ st: 'erro', msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function convidar() {
    if (!nome.trim() || !email.trim() || ocupado) return;
    setOcupado('criar');
    setAviso(null);
    setAcesso(null);
    try {
      const r = await api<{ usuario: Membro; acesso: Acesso }>('/usuarios', {
        method: 'POST',
        body: JSON.stringify({
          nome: nome.trim(),
          email: email.trim(),
          gestor,
          ...(ehCliente ? {} : { papel }),
        }),
      });
      setAcesso(r.acesso);
      setAviso({ tipo: 'ok', texto: `${r.usuario.nome} agora tem acesso.` });
      setNome('');
      setEmail('');
      setGestor(false);
      setAbrirForm(false);
      await carregar();
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function alternar(m: Membro, campo: 'ativo' | 'gestor') {
    if (ocupado) return;
    setOcupado(`${campo}-${m.id}`);
    setAviso(null);
    try {
      await api(`/usuarios/${m.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [campo]: !m[campo] }),
      });
      await carregar();
    } catch (e) {
      /* As travas de auto-trancamento chegam por aqui — a mensagem do servidor
         já explica o motivo, então ela vai inteira para a tela. */
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  async function redefinir(m: Membro) {
    if (ocupado) return;
    setOcupado(`senha-${m.id}`);
    setAviso(null);
    setAcesso(null);
    try {
      const r = await api<{ acesso: Acesso }>(`/usuarios/${m.id}/senha`, { method: 'POST' });
      setAcesso(r.acesso);
      setAviso({ tipo: 'ok', texto: `Senha de ${m.nome} redefinida.` });
    } catch (e) {
      setAviso({ tipo: 'erro', texto: (e as Error).message });
    } finally {
      setOcupado(null);
    }
  }

  const assentos = equipe.st === 'ok' ? equipe.dados.assentos : null;
  /* Só há lotação onde há teto: para a operação interna `limite` é null e o
     botão nunca trava. */
  const lotado = assentos !== null && assentos.limite !== null && assentos.usados >= assentos.limite;

  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="relative p-6 lg:p-9">
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-8 flex flex-wrap items-end justify-between gap-4"
        >
          <div>
            <p className="rotulo">Organização</p>
            <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
              Equipe
            </h1>
            {/* O saldo do plano, ao lado dos nomes que ele conta. Some para quem
                não tem teto — imprimir "3 de ∞" seria ruído. */}
            {assentos?.limite !== null && assentos !== null && (
              <p
                className={cn(
                  'mt-1.5 text-[12px]',
                  lotado ? 'text-alerta' : 'text-muted',
                )}
              >
                <span className="num">
                  {assentos.usados} de {assentos.limite}
                </span>{' '}
                perfis do seu plano
                {lotado && ' — desative alguém para abrir uma vaga'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void carregar()}
              className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Atualizar
            </button>
            <button
              type="button"
              onClick={() => setAbrirForm((v) => !v)}
              /* Desabilitado com MOTIVO no title: um botão cinza sem explicação
                 faria o gestor achar que a tela quebrou. A trava de verdade está
                 no servidor — esta é só a que evita digitar em vão. */
              disabled={lotado}
              title={
                lotado
                  ? `O seu plano permite ${assentos?.limite} perfis e todos estão em uso.`
                  : undefined
              }
              className="flex h-9 items-center gap-2 rounded-full bg-marca px-4 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Adicionar pessoa
            </button>
          </div>
        </motion.header>

        {aviso && (
          <div
            role="status"
            className={cn(
              'mb-5 rounded-[12px] border p-4 text-[12px]',
              aviso.tipo === 'ok'
                ? 'border-ok/30 bg-ok/10 text-ok'
                : 'border-erro/30 bg-erro/10 text-erro',
            )}
          >
            {aviso.texto}
          </div>
        )}

        {acesso && (
          <div className="mb-5 rounded-[12px] border border-marca-ciano/30 bg-marca-ciano/10 p-5">
            <p className="flex items-center gap-2 font-display text-[14px] font-medium text-ink">
              <KeyRound className="h-4 w-4 text-marca-ciano" aria-hidden />
              Credencial de acesso
            </p>
            <p className="mt-1.5 text-[12px] text-muted">{acesso.aviso}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="num rounded-[10px] border border-linha bg-superficie px-3 py-2 text-[13px] text-ink">
                {acesso.email}
              </code>
              <code className="num rounded-[10px] border border-linha bg-superficie px-3 py-2 text-[13px] text-ink">
                {acesso.senhaInicial}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(`${acesso.email} / ${acesso.senhaInicial}`)
                    .then(() => {
                      setCopiado(true);
                      setTimeout(() => setCopiado(false), 2000);
                    });
                }}
                className="flex h-9 items-center gap-2 rounded-full border border-linha px-4 text-[12px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink"
              >
                {copiado ? (
                  <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copiado ? 'Copiado' : 'Copiar'}
              </button>
              <button
                type="button"
                onClick={() => setAcesso(null)}
                className="text-[12px] text-muted underline-offset-4 hover:text-ink-2 hover:underline"
              >
                Já anotei, esconder
              </button>
            </div>
          </div>
        )}

        {abrirForm && (
          <motion.section
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="cartao mb-5 overflow-hidden p-6"
          >
            <h2 className="font-display text-[15px] font-medium text-ink">Nova pessoa</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="rotulo">Nome</span>
                <input
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  placeholder="Dra. Ana Silva"
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
                />
              </label>
              <label className="block">
                <span className="rotulo">E-mail</span>
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  placeholder="ana@escritorio.com.br"
                  className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none placeholder:text-muted-2 focus:border-marca-ciano"
                />
              </label>
              {!ehCliente && usuario?.papel === 'ADMIN' && (
                <label className="block">
                  <span className="rotulo">Papel</span>
                  <select
                    value={papel}
                    onChange={(e) => setPapel(e.target.value as 'OPERADOR' | 'ADMIN')}
                    className="mt-1.5 h-10 w-full rounded-[10px] border border-linha bg-superficie px-3 text-[13px] text-ink outline-none focus:border-marca-ciano"
                  >
                    <option value="OPERADOR">Operador</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                </label>
              )}
              <label className="flex items-end gap-2.5 pb-2.5">
                <input
                  type="checkbox"
                  checked={gestor}
                  onChange={(e) => setGestor(e.target.checked)}
                  className="h-4 w-4 accent-[rgb(var(--marca-ciano))]"
                />
                <span className="text-[12px] text-ink-2">Pode administrar a equipe</span>
              </label>
            </div>
            <p className="mt-3 text-[11px] text-muted">
              Uma senha é gerada e mostrada uma única vez — entregue à pessoa e peça a troca no
              primeiro acesso.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void convidar()}
                disabled={!nome.trim() || !email.trim() || ocupado !== null}
                className="flex h-9 items-center gap-2 rounded-full bg-marca px-5 text-[12px] font-medium text-[#05070f] transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                {ocupado === 'criar' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Adicionar
              </button>
              <button
                type="button"
                onClick={() => setAbrirForm(false)}
                className="text-[12px] text-muted underline-offset-4 hover:text-ink-2 hover:underline"
              >
                Cancelar
              </button>
            </div>
          </motion.section>
        )}

        {equipe.st === 'erro' && <BlocoErro msg={equipe.msg} />}
        {equipe.st === 'carregando' && (
          <div className="cartao p-6 text-[13px] text-muted">Carregando…</div>
        )}
        {equipe.st === 'ok' && equipe.dados.usuarios.length === 0 && (
          <div className="cartao">
            <Vazio Icone={Users} titulo="Ninguém por aqui ainda" />
          </div>
        )}

        {equipe.st === 'ok' && equipe.dados.usuarios.length > 0 && (
          <div className="cartao overflow-hidden">
            <ul className="divide-y divide-linha">
              {equipe.dados.usuarios.map((m) => {
                const euMesmo = m.id === usuario?.id;
                return (
                  <li key={m.id} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                    <div className="min-w-[200px] flex-1">
                      <p className="flex items-center gap-2 text-[13px] text-ink">
                        {m.nome}
                        {euMesmo && (
                          <span className="rounded-full border border-linha px-2 py-0.5 text-[10px] text-muted">
                            você
                          </span>
                        )}
                        {m.gestor && (
                          <span
                            className="flex items-center gap-1 text-[10px] text-marca-ciano"
                            title="Administra a equipe"
                          >
                            <ShieldCheck className="h-3 w-3" aria-hidden />
                            gestor
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-muted-2">
                        {m.email} · {PAPEL_ROTULO[m.papel]} · último acesso {quando(m.ultimoLoginEm)}
                      </p>
                    </div>

                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                        m.ativo
                          ? 'border-ok/30 bg-ok/10 text-ok'
                          : 'border-linha bg-superficie text-muted',
                      )}
                    >
                      {m.ativo ? 'Ativo' : 'Inativo'}
                    </span>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void alternar(m, 'gestor')}
                        disabled={ocupado !== null}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-linha px-3 text-[11px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
                      >
                        {ocupado === `gestor-${m.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <ShieldCheck className="h-3 w-3" aria-hidden />
                        )}
                        {m.gestor ? 'Remover gestão' : 'Tornar gestor'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void redefinir(m)}
                        disabled={ocupado !== null}
                        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-linha px-3 text-[11px] text-ink-2 transition-colors hover:border-linha-2 hover:text-ink disabled:opacity-45"
                        title="Gera uma nova senha e encerra as sessões abertas"
                      >
                        {ocupado === `senha-${m.id}` ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : (
                          <RotateCcw className="h-3 w-3" aria-hidden />
                        )}
                        Senha
                      </button>
                      <button
                        type="button"
                        onClick={() => void alternar(m, 'ativo')}
                        disabled={ocupado !== null}
                        className={cn(
                          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] transition-colors disabled:opacity-45',
                          m.ativo
                            ? 'border-linha text-ink-2 hover:border-erro/40 hover:text-erro'
                            : 'border-linha text-ink-2 hover:border-ok/40 hover:text-ok',
                        )}
                      >
                        {ocupado === `ativo-${m.id}` && (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        )}
                        {m.ativo ? 'Desativar' : 'Reativar'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
