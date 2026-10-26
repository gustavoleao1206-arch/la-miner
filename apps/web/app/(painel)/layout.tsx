"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard,
  Sun,
  Search,
  Upload,
  Filter,
  Hourglass,
  ListChecks,
  ListFilter,
  ScrollText,
  ShieldCheck,
  Building2,
  Receipt,
  CreditCard,
  Users,
  X,
} from "lucide-react";
import { Logo, SimboloLLA } from "@/components/logo";
import { SeletorLote } from "@/components/seletor-lote";
import { AppHeader } from "@/components/app-header";
import { QueryProvider } from "@/components/query-provider";
import { encerrarSessao } from "@/lib/api";
import { ProvedorInatividade } from "@/lib/inatividade";
import { ProvedorLote } from "@/lib/lote";
import { ProvedorUsuario, useUsuario } from "@/lib/usuario";
import { cn } from "@/lib/utils";

/**
 * Quem vê cada item.
 *
 * Não é enfeite de menu: esconder a infraestrutura é a promessa do produto ao
 * cliente. A trava DE VERDADE está na API (cada rota declara seus papéis);
 * esconder aqui evita que alguém clique num lugar que responderia 403 — e evita
 * a pergunta "que fila é essa?", que já entrega o jogo.
 *
 *  todos   — qualquer usuário autenticado
 *  cliente — só o assinante
 *  interno — a operação Leão Amorim (ADMIN e OPERADOR)
 *  admin   — só ADMIN, porque os controllers de distribuição e cobrança são
 *            @Papeis('ADMIN'): mostrar ao OPERADOR seria oferecer um 403.
 *  gestor  — quem administra a PRÓPRIA organização. Atravessa a divisa
 *            interno×cliente de propósito: o assinante também gerencia a
 *            equipe dele, cada um dentro do seu tenant.
 */
type QuemVe = "todos" | "cliente" | "interno" | "admin" | "gestor";

const NAV: { href: string; rotulo: string; Icone: typeof LayoutDashboard; quem: QuemVe }[] = [
  { href: "/dashboard", rotulo: "Dashboard", Icone: LayoutDashboard, quem: "todos" },
  /* Segundo item, e não último: é a tela que o operador abre primeiro no dia. */
  { href: "/meu-dia", rotulo: "Meu dia", Icone: Sun, quem: "todos" },
  /* Trabalhar a lista × achar uma pessoa: perguntas diferentes, telas
     diferentes. A Carteira vem antes porque é a rotina; a Consulta é o
     desvio de quando alguém liga perguntando pelo próprio precatório. */
  { href: "/carteira", rotulo: "Carteira", Icone: ListFilter, quem: "todos" },
  /* Logo DEPOIS da carteira, e não junto do dashboard: o funil é a mesma
     carteira vista de cima, e quem chega nele vem de lá. Para "todos" porque a
     operação interna também trabalha um funil — o que ela não tem é safra, e a
     tela diz isso em vez de mostrar um bloco vazio. */
  { href: "/funil", rotulo: "Funil", Icone: Filter, quem: "todos" },
  /* DEPOIS da Carteira e do Funil, e para "todos": e o mesmo funil um estagio
     antes, e quem recebe esses processos no sorteio e o cliente. Tela propria
     porque o recorte da carteira (tribunal + exercicio) nao alcanca quem nao
     tem exercicio — ver a nota da rota `pre-precatorios` na API. */
  { href: "/pre-precatorios", rotulo: "Pré-precatórios", Icone: Hourglass, quem: "todos" },
  { href: "/consulta", rotulo: "Consulta", Icone: Search, quem: "todos" },
  { href: "/assinatura", rotulo: "Minha assinatura", Icone: CreditCard, quem: "cliente" },
  { href: "/importacao", rotulo: "Importação", Icone: Upload, quem: "interno" },
  { href: "/fila", rotulo: "Fila", Icone: ListChecks, quem: "interno" },
  { href: "/clientes", rotulo: "Clientes", Icone: Building2, quem: "admin" },
  { href: "/cobranca", rotulo: "Cobrança", Icone: Receipt, quem: "admin" },
  { href: "/equipe", rotulo: "Equipe", Icone: Users, quem: "gestor" },
  { href: "/auditoria", rotulo: "Auditoria", Icone: ScrollText, quem: "interno" },
  /* `/central-privacidade`, e NÃO `/privacidade`: aquele caminho já é a POLÍTICA
     pública, no grupo (site). Duas páginas resolvendo para a mesma rota é erro
     de build no Next — foi assim que descobri, e o rótulo do menu pode continuar
     curto porque quem lê o menu do painel não vê a landing. */
  { href: "/central-privacidade", rotulo: "Privacidade", Icone: ShieldCheck, quem: "admin" },
];

const CHAVE_SIDEBAR = "miner.sidebar";
const PAPEL_ROTULO: Record<string, string> = {
  ADMIN: "Administrador",
  OPERADOR: "Operador",
  CLIENTE: "Cliente",
};

function iniciais(email: string): string {
  const base = email.split("@")[0] ?? email;
  const p = base.split(/[.\-_]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? p[0]?.[1] ?? "")).toUpperCase() || "U";
}

/** Navegação — compartilhada entre a barra fixa e a gaveta. `colapsada` some com
 *  os rótulos e deixa só os ícones, com o nome no `title` para tooltip. */
function Navegacao({
  pathname,
  aoNavegar,
  id,
  colapsada = false,
}: {
  pathname: string;
  aoNavegar?: () => void;
  id: string;
  colapsada?: boolean;
}) {
  const { ehCliente, usuario, podeGerirEquipe } = useUsuario();
  const ehAdmin = usuario?.papel === "ADMIN";
  const itens = NAV.filter((i) => {
    if (i.quem === "todos") return true;
    if (i.quem === "cliente") return ehCliente;
    if (i.quem === "admin") return !ehCliente && ehAdmin;
    if (i.quem === "gestor") return podeGerirEquipe;
    return !ehCliente; // "interno"
  });

  return (
    <nav className="flex-1 space-y-1">
      {itens.map(({ href, rotulo, Icone }) => {
        const ativo = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            onClick={aoNavegar}
            aria-current={ativo ? "page" : undefined}
            title={colapsada ? rotulo : undefined}
            className={cn(
              "group relative flex items-center gap-3 rounded-[11px] px-3 py-2.5 text-sm transition-colors",
              colapsada && "justify-center px-0",
              ativo
                ? "bg-superficie-2 font-medium text-ink"
                : "text-muted hover:bg-superficie hover:text-ink-2",
            )}
          >
            {ativo && (
              <motion.span
                layoutId={`nav-ativo-${id}`}
                className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-marca"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <Icone className={cn("h-[18px] w-[18px] shrink-0", ativo && "text-marca-ciano")} />
            {!colapsada && rotulo}
          </Link>
        );
      })}
    </nav>
  );
}

/** Bloco de perfil no rodapé da lateral — quem está logado, sempre à vista. */
function PerfilLateral({
  usuario,
  colapsada,
}: {
  usuario: { email: string; papel: string } | null;
  colapsada: boolean;
}) {
  const avatar = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-marca text-[11px] font-semibold text-[#05070f]">
      {usuario ? iniciais(usuario.email) : "—"}
    </span>
  );
  if (colapsada) {
    return <div className="flex justify-center pt-1" title={usuario?.email}>{avatar}</div>;
  }
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] border border-linha bg-superficie px-3 py-2.5">
      {avatar}
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium text-ink">{usuario?.email ?? "…"}</p>
        <p className="flex items-center gap-1 text-[11px] text-muted">
          <ShieldCheck className="h-3 w-3 text-marca-ciano" />
          {usuario ? PAPEL_ROTULO[usuario.papel] ?? usuario.papel : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * O layout em si. Separado do componente exportado porque precisa CONSUMIR o
 * `ProvedorUsuario` — um componente não lê o contexto que ele próprio fornece.
 */
function Painel({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { usuario, ehCliente } = useUsuario();
  const [pronto, setPronto] = useState(false);
  const [gaveta, setGaveta] = useState(false);
  const [colapsada, setColapsada] = useState(false);

  useEffect(() => {
    if (!sessionStorage.getItem("miner.access")) {
      router.replace("/login");
      return;
    }
    setPronto(true);
    /* Preferência de barra recolhida sobrevive ao reload. */
    setColapsada(localStorage.getItem(CHAVE_SIDEBAR) === "1");
  }, [router]);

  const alternarColapso = useCallback(() => {
    setColapsada((v) => {
      const proximo = !v;
      try {
        localStorage.setItem(CHAVE_SIDEBAR, proximo ? "1" : "0");
      } catch {
        /* storage bloqueado: ainda funciona na sessão */
      }
      return proximo;
    });
  }, []);

  /* A gaveta fecha ao trocar de rota. */
  useEffect(() => setGaveta(false), [pathname]);

  /* Esc fecha; e com a gaveta aberta o corpo não rola por trás dela. */
  useEffect(() => {
    if (!gaveta) return;
    const aoTeclar = (e: KeyboardEvent) => e.key === "Escape" && setGaveta(false);
    const overflowAnterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", aoTeclar);
    return () => {
      document.body.style.overflow = overflowAnterior;
      window.removeEventListener("keydown", aoTeclar);
    };
  }, [gaveta]);

  /* Avisa o servidor antes de sair. Limpar só o storage deixaria a família do
     refresh válida e o cookie httpOnly vivo no navegador — apenas o servidor
     consegue apagá-lo. `encerrarSessao` nunca lança, então o redirecionamento
     acontece mesmo com a API fora do ar. */
  const sair = useCallback(async () => {
    await encerrarSessao();
    router.replace("/login");
  }, [router]);

  if (!pronto) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-7 w-7 animate-pulsar rounded-full bg-marca" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* ── Barra lateral fixa (≥ lg), recolhível ── */}
      <aside
        className={cn(
          "hidden shrink-0 flex-col border-r border-linha bg-bg-2/50 p-4 transition-[width] duration-300 ease-[cubic-bezier(.16,1,.3,1)] lg:flex",
          colapsada ? "w-[74px]" : "w-60",
        )}
      >
        <div className={cn("mb-6 flex h-8 items-center", colapsada ? "justify-center" : "px-1")}>
          {colapsada ? (
            <SimboloLLA className="h-8 drop-shadow-[0_0_16px_rgba(99,102,241,.5)]" />
          ) : (
            <Logo tamanho="sm" />
          )}
        </div>

        {/* O seletor de lote é recorte de EXIBIÇÃO da operação interna. Para o
            cliente, a carteira é uma só — a que foi liberada a ele. */}
        {!colapsada && !ehCliente && <SeletorLote className="mb-6" />}

        <Navegacao pathname={pathname} id="lateral" colapsada={colapsada} />

        <div className="mt-4">
          <PerfilLateral usuario={usuario} colapsada={colapsada} />
        </div>
      </aside>

      {/* ── Coluna de conteúdo ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          pathname={pathname}
          usuario={usuario}
          colapsada={colapsada}
          onColapsar={alternarColapso}
          onAbrirGaveta={() => setGaveta(true)}
          onSair={sair}
        />
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {/* ── Gaveta (< lg) ── */}
      <AnimatePresence>
        {gaveta && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25 }}
              onClick={() => setGaveta(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Menu de navegação"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[82vw] flex-col border-r border-linha bg-bg-2 p-5 shadow-elevado"
            >
              <div className="mb-6 flex items-center justify-between">
                <Logo tamanho="sm" />
                <button
                  onClick={() => setGaveta(false)}
                  aria-label="Fechar menu"
                  className="flex h-9 w-9 items-center justify-center rounded-sm text-muted transition-colors hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {!ehCliente && <SeletorLote className="mb-6" />}
              <Navegacao pathname={pathname} id="gaveta" aoNavegar={() => setGaveta(false)} />
              <div className="mt-4">
                <PerfilLateral usuario={usuario} colapsada={false} />
              </div>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function PainelLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      {/* POR FORA de tudo, e dentro do QueryProvider: o cadeado precisa cobrir
          a tela inteira — cabeçalho, barra lateral e conteúdo —, e a pausa
          precisa valer para as consultas que o React Query repete sozinho. Só
          o painel: as telas públicas (login, cadastro) não têm o que pausar. */}
      <ProvedorInatividade>
        <ProvedorUsuario>
          <ProvedorLote>
            <Painel>{children}</Painel>
          </ProvedorLote>
        </ProvedorUsuario>
      </ProvedorInatividade>
    </QueryProvider>
  );
}
