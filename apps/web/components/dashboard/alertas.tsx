'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { CheckCircle2, ChevronRight, Clock, PackageOpen, ShieldAlert, UserX, XCircle } from 'lucide-react';
import type { EstadoFila, Folego, PainelCarteira } from '@/lib/api';
import { Esqueleto } from '@/components/metricas';
import { cn } from '@/lib/utils';

/**
 * Alertas — só sinais REAIS, do que já é buscado (operação + fila).
 *
 * Nada de "3 alertas" decorativo: cada linha é uma condição verdadeira com
 * contagem verdadeira (processos sem responsável, tarefas atrasadas, falhas na
 * fila). Se não há o que apontar, a carta diz isso — "nada exige atenção" é uma
 * informação, não um vazio. Cada alerta leva à tela onde se resolve.
 */
type Severidade = 'grave' | 'atencao';

type Alerta = {
  chave: string;
  sev: Severidade;
  Icone: React.ComponentType<{ className?: string }>;
  texto: string;
  n: number;
  href: string;
};

const ESTILO: Record<Severidade, { caixa: string; icone: string; badge: string }> = {
  grave: { caixa: 'border-erro/25 bg-erro/[0.07]', icone: 'text-erro', badge: 'bg-erro/15 text-erro' },
  atencao: {
    caixa: 'border-alerta/25 bg-alerta/[0.07]',
    icone: 'text-alerta',
    badge: 'bg-alerta/15 text-alerta',
  },
};

export function Alertas({
  operacao,
  fila,
  folego,
  carregando,
}: {
  operacao: PainelCarteira['operacao'] | null;
  fila: EstadoFila | null;
  /** Fôlego das assinaturas. Só a operação interna recebe — ver a nota abaixo. */
  folego: Folego | null;
  carregando?: boolean;
}) {
  const alertas: Alerta[] = [];

  /**
   * A BASE ESGOTOU PARA UM CLIENTE — o alerta que vem antes do prejuízo.
   *
   * Fica no TOPO e como `grave` porque é o único aqui em que o dinheiro já está
   * errado: o cliente pagou a mensalidade e não recebeu processo nenhum. Os
   * outros alertas são trabalho acumulado; este é uma cobrança sem entrega.
   *
   * Separado em dois: quem JÁ esgotou (cobrando sem entregar hoje) e quem está
   * perto (ainda dá tempo de importar carteira nova). Somar os dois num número
   * só faria a urgência de um se dissolver na tolerância do outro.
   */
  const esgotados = folego?.clientes.filter(
    (c) => c.status === 'ATIVA' && (c.situacao === 'ESGOTADA' || c.situacao === 'ULTIMO_CICLO'),
  ).length;
  const perto = folego?.clientes.filter(
    (c) => c.status === 'ATIVA' && c.situacao === 'PERTO_DO_FIM',
  ).length;

  if (esgotados) {
    alertas.push({
      chave: 'base-esgotada',
      sev: 'grave',
      Icone: PackageOpen,
      texto: 'Clientes sem base para o próximo ciclo',
      n: esgotados,
      href: '/clientes',
    });
  }
  if (perto) {
    alertas.push({
      chave: 'base-acabando',
      sev: 'atencao',
      Icone: PackageOpen,
      texto: 'Clientes com menos de 4 ciclos de base',
      n: perto,
      href: '/clientes',
    });
  }

  if (fila?.falhos && fila.falhos > 0) {
    alertas.push({
      chave: 'falhos',
      sev: 'grave',
      Icone: XCircle,
      texto: 'Consultas com falha na fila',
      n: fila.falhos,
      href: '/fila',
    });
  }
  if (operacao?.tarefasAtrasadas && operacao.tarefasAtrasadas > 0) {
    alertas.push({
      chave: 'atrasadas',
      sev: 'grave',
      Icone: Clock,
      texto: 'Tarefas atrasadas',
      n: operacao.tarefasAtrasadas,
      href: '/meu-dia',
    });
  }
  if (fila?.atrasados && fila.atrasados > 0) {
    alertas.push({
      chave: 'jobs-atrasados',
      sev: 'atencao',
      Icone: Clock,
      texto: 'Jobs aguardando há tempo demais',
      n: fila.atrasados,
      href: '/fila',
    });
  }
  if (operacao?.processosSemResponsavel && operacao.processosSemResponsavel > 0) {
    alertas.push({
      chave: 'sem-responsavel',
      sev: 'atencao',
      Icone: UserX,
      texto: 'Processos sem responsável',
      n: operacao.processosSemResponsavel,
      href: '/meu-dia',
    });
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.62, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      aria-labelledby="titulo-alertas"
      className="cartao flex flex-col p-6"
    >
      <div className="mb-5 flex items-center gap-2.5">
        <ShieldAlert aria-hidden className="h-4 w-4 text-alerta" />
        <h2 id="titulo-alertas" className="font-display text-sm font-semibold text-ink">
          Alertas
        </h2>
        {!carregando && alertas.length > 0 && (
          <span className="num ml-auto rounded-full bg-alerta/15 px-2 py-0.5 text-[11px] font-medium text-alerta">
            {alertas.length}
          </span>
        )}
      </div>

      {carregando ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Esqueleto key={i} className="h-14 rounded-[12px]" />
          ))}
        </div>
      ) : alertas.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-[13px] border border-ok/25 bg-ok/10">
            <CheckCircle2 className="h-5 w-5 text-ok" />
          </span>
          <p className="text-[13px] font-medium text-ink-2">Nada exige atenção agora</p>
          <p className="mt-1 text-[12px] text-muted">Fila, tarefas e responsáveis em dia.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {alertas.map((a, i) => {
            const e = ESTILO[a.sev];
            return (
              <motion.li
                key={a.chave}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.66 + i * 0.06, duration: 0.45 }}
              >
                <Link
                  href={a.href}
                  className={cn(
                    'group flex items-center gap-3 rounded-[12px] border px-3.5 py-3 transition-colors',
                    e.caixa,
                    'hover:border-linha-2',
                  )}
                >
                  <a.Icone className={cn('h-4 w-4 shrink-0', e.icone)} />
                  <span className="flex-1 text-[13px] text-ink-2">{a.texto}</span>
                  <span className={cn('num rounded-full px-2 py-0.5 text-[12px] font-semibold', e.badge)}>
                    {a.n.toLocaleString('pt-BR')}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5" />
                </Link>
              </motion.li>
            );
          })}
        </ul>
      )}
    </motion.section>
  );
}
