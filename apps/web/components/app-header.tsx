'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bell,
  ChevronRight,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { api, type EstadoFila } from '@/lib/api';
import { useUsuario } from '@/lib/usuario';
import { cn } from '@/lib/utils';
import { ToggleTema } from '@/components/toggle-tema';

/** Rótulo da rota atual para o breadcrumb. */
const TITULOS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/meu-dia': 'Meu dia',
  '/consulta': 'Consulta',
  '/importacao': 'Importação',
  '/fila': 'Fila de enriquecimento',
  '/auditoria': 'Auditoria',
  '/central-privacidade': 'Central de Privacidade',
  '/seguranca': 'Segurança',
};

function tituloDaRota(pathname: string): string {
  if (TITULOS[pathname]) return TITULOS[pathname];
  if (pathname.startsWith('/processo/')) return 'Processo';
  return 'Painel';
}

/** Iniciais a partir do e-mail — avatar sem foto, mas com identidade. */
function iniciais(email: string): string {
  const base = email.split('@')[0] ?? email;
  const partes = base.split(/[.\-_]+/).filter(Boolean);
  const letras = (partes[0]?.[0] ?? '') + (partes[1]?.[0] ?? partes[0]?.[1] ?? '');
  return letras.toUpperCase() || 'U';
}

const PAPEL_ROTULO: Record<string, string> = {
  ADMIN: 'Administrador',
  OPERADOR: 'Operador',
  CLIENTE: 'Cliente',
};

/**
 * Header enterprise, persistente em todas as telas do painel.
 *
 * A saúde da API e a contagem de atenção NÃO são enfeite: vêm de um ping real a
 * `/fila/estado`. Se a chamada responde, a API está operacional e o número de
 * jobs FALHOS vira o badge do sino — um sinal verdadeiro de que algo precisa de
 * olhar, não um "3" decorativo. Se a chamada falha, o indicador fica âmbar.
 */
export function AppHeader({
  pathname,
  usuario,
  colapsada,
  onColapsar,
  onAbrirGaveta,
  onSair,
}: {
  pathname: string;
  usuario: { email: string; papel: string } | null;
  colapsada: boolean;
  onColapsar: () => void;
  onAbrirGaveta: () => void;
  onSair: () => void;
}) {
  const router = useRouter();
  const { ehCliente } = useUsuario();
  const [busca, setBusca] = useState('');
  const [saude, setSaude] = useState<{ ok: boolean; falhos: number } | null>(null);
  const [menu, setMenu] = useState(false);
  const refMenu = useRef<HTMLDivElement>(null);

  /* Ping de saúde a cada 45s. Barato e verdadeiro: o mesmo endpoint que a fila
     usa. Sem intervalo agressivo — o header não precisa de tempo real, precisa
     de "está no ar?". */
  useEffect(() => {
    let vivo = true;
    const medir = async () => {
      try {
        /* O cliente não pode ler a fila. Pingar `/fila/estado` nele devolveria 403
           e o header acenderia "instável" — uma MENTIRA sobre um sistema saudável,
           e ainda por cima denunciando que existe uma fila. Para ele o ping é
           `/auth/eu`, que todo autenticado pode chamar, e o badge de falhas
           simplesmente não existe (falhos = 0). */
        if (ehCliente) {
          await api('/auth/eu');
          if (vivo) setSaude({ ok: true, falhos: 0 });
          return;
        }
        const e = await api<EstadoFila>('/fila/estado');
        if (vivo) setSaude({ ok: true, falhos: e.falhos });
      } catch {
        if (vivo) setSaude({ ok: false, falhos: 0 });
      }
    };
    void medir();
    const id = window.setInterval(medir, 45_000);
    return () => {
      vivo = false;
      window.clearInterval(id);
    };
  }, [ehCliente]);

  /* Fecha o menu de perfil ao clicar fora ou apertar Esc. */
  useEffect(() => {
    if (!menu) return;
    const aoClicar = (e: MouseEvent) => {
      if (refMenu.current && !refMenu.current.contains(e.target as Node)) setMenu(false);
    };
    const aoTeclar = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', aoClicar);
    document.addEventListener('keydown', aoTeclar);
    return () => {
      document.removeEventListener('mousedown', aoClicar);
      document.removeEventListener('keydown', aoTeclar);
    };
  }, [menu]);

  const buscar = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = busca.trim();
      /* A busca global leva à Consulta, que é a tela de busca de verdade. */
      router.push(q ? `/consulta?q=${encodeURIComponent(q)}` : '/consulta');
    },
    [busca, router],
  );

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-linha bg-bg-2/70 px-4 backdrop-blur-xl lg:px-6">
      {/* ── Abre menu (mobile) / recolhe barra (desktop) ── */}
      <button
        onClick={onAbrirGaveta}
        aria-label="Abrir menu"
        className="flex h-9 w-9 items-center justify-center rounded-sm border border-linha bg-superficie text-ink-2 transition-colors hover:text-ink lg:hidden"
      >
        <Menu className="h-[18px] w-[18px]" />
      </button>
      <button
        onClick={onColapsar}
        aria-label={colapsada ? 'Expandir barra lateral' : 'Recolher barra lateral'}
        className="hidden h-9 w-9 items-center justify-center rounded-sm border border-linha bg-superficie text-muted transition-colors hover:text-ink lg:flex"
      >
        {colapsada ? <PanelLeftOpen className="h-[18px] w-[18px]" /> : <PanelLeftClose className="h-[18px] w-[18px]" />}
      </button>

      {/* ── Breadcrumb ── */}
      <nav aria-label="Localização" className="hidden items-center gap-1.5 text-[13px] sm:flex">
        <span className="text-muted">Painel</span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-2" />
        <span className="font-medium text-ink">{tituloDaRota(pathname)}</span>
      </nav>

      {/* ── Busca global ── */}
      <form method="post" onSubmit={buscar} className="mx-auto flex w-full max-w-md items-center lg:mx-0 lg:ml-6">
        <div className="group relative w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted transition-colors group-focus-within:text-marca-ciano" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar por processo, CPF, nome…"
            aria-label="Busca global"
            className="h-9 w-full rounded-[11px] border border-linha bg-superficie pl-9 pr-14 text-[13px] text-ink placeholder:text-muted transition-colors hover:border-linha-2 focus:border-marca-ciano/40 focus:bg-bg-2 focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-linha bg-bg-2 px-1.5 py-0.5 text-[10px] font-medium text-muted lg:block">
            ⏎
          </kbd>
        </div>
      </form>

      {/* ── Cluster direito ── */}
      <div className="ml-auto flex items-center gap-2 lg:ml-4">
        {/* Status da API — real */}
        <span
          className="hidden items-center gap-2 rounded-full border border-linha bg-superficie px-3 py-1.5 md:flex"
          title={
            saude === null
              ? 'Verificando a API…'
              : saude.ok
                ? 'API operacional'
                : 'A API não respondeu ao último teste'
          }
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              saude === null ? 'bg-muted' : saude.ok ? 'bg-ok' : 'bg-alerta',
              saude?.ok && 'animate-pulsar',
            )}
          />
          <span className="text-[12px] text-ink-2">
            {saude === null ? 'Verificando' : saude.ok ? 'Operacional' : 'Instável'}
          </span>
        </span>

        {/* Notificações — badge = jobs falhos reais */}
        <button
          aria-label={
            saude && saude.falhos > 0 ? `${saude.falhos} alerta(s) na fila` : 'Sem alertas'
          }
          onClick={() => router.push('/fila')}
          className="relative flex h-9 w-9 items-center justify-center rounded-sm border border-linha bg-superficie text-ink-2 transition-colors hover:text-ink"
        >
          <Bell className="h-[18px] w-[18px]" />
          {saude && saude.falhos > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-erro px-1 text-[10px] font-semibold text-white">
              {saude.falhos > 9 ? '9+' : saude.falhos}
            </span>
          )}
        </button>

        <ToggleTema />

        {/* ── Perfil ── */}
        <div className="relative" ref={refMenu}>
          <button
            onClick={() => setMenu((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menu}
            className="flex items-center gap-2 rounded-full border border-linha bg-superficie py-1 pl-1 pr-1 transition-colors hover:border-linha-2 sm:pr-3"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-marca text-[11px] font-semibold text-[#05070f]">
              {usuario ? iniciais(usuario.email) : '—'}
            </span>
            <span className="hidden max-w-[9rem] truncate text-[12px] text-ink-2 sm:block">
              {usuario ? PAPEL_ROTULO[usuario.papel] ?? usuario.papel : '…'}
            </span>
          </button>

          <AnimatePresence>
            {menu && (
              <motion.div
                role="menu"
                initial={{ opacity: 0, y: -6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.97 }}
                transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                className="absolute right-0 top-[calc(100%+8px)] w-60 overflow-hidden rounded-[14px] border border-linha bg-bg-2/95 shadow-elevado backdrop-blur-xl"
              >
                <div className="border-b border-linha px-4 py-3">
                  <p className="truncate text-[13px] font-medium text-ink">{usuario?.email ?? '—'}</p>
                  {usuario && (
                    <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
                      <ShieldCheck className="h-3 w-3 text-marca-ciano" />
                      {PAPEL_ROTULO[usuario.papel] ?? usuario.papel}
                    </p>
                  )}
                </div>
                {/* Verificação em duas etapas. Fica no menu da conta porque é
                    ajuste PESSOAL — cada usuário cadastra o próprio segundo
                    fator; não é configuração da organização. */}
                <Link
                  role="menuitem"
                  href="/seguranca"
                  onClick={() => setMenu(false)}
                  className="flex w-full items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink-2 transition-colors hover:bg-superficie hover:text-ink"
                >
                  <ShieldCheck className="h-4 w-4" />
                  Segurança
                </Link>
                <button
                  role="menuitem"
                  onClick={onSair}
                  className="flex w-full items-center gap-2.5 border-t border-linha px-4 py-2.5 text-[13px] text-ink-2 transition-colors hover:bg-superficie hover:text-erro"
                >
                  <LogOut className="h-4 w-4" />
                  Sair
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
