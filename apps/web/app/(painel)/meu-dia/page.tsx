'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  AlertTriangle,
  BellRing,
  CalendarCheck2,
  CalendarClock,
  Check,
  ChevronRight,
  Inbox,
  ListChecks,
  Loader2,
  RotateCw,
  Sun,
  UserPlus,
} from 'lucide-react';
import {
  crm,
  type Agenda,
  type Prioridade,
  type TarefaDaAgenda,
  type TipoTarefa,
} from '@/lib/api';
import { cn, diaISO, diaLegivel, hojeISO, somarDias } from '@/lib/utils';
import { Esqueleto } from '@/components/metricas';
import { BlocoErro, CARREGANDO, Vazio, type Estado } from '@/components/estado';

type IconeDecorativo = React.ComponentType<{ className?: string }>;

/**
 * Os baldes da agenda, do mais urgente ao mais folgado.
 *
 * A classificação é feita AQUI, no cliente, e não no servidor: "hoje" depende
 * do fuso de quem lê, e o servidor não sabe qual é. Ele devolve as pendências
 * ordenadas por prazo; quem decide o que é atraso é o relógio do operador.
 */
type Balde = 'ATRASADA' | 'HOJE' | 'SEMANA' | 'DEPOIS' | 'SEM_PRAZO';

const BALDES: { chave: Balde; titulo: string; Icone: IconeDecorativo; cor: string }[] = [
  { chave: 'ATRASADA', titulo: 'Em atraso', Icone: AlertTriangle, cor: 'text-erro' },
  { chave: 'HOJE', titulo: 'Hoje', Icone: Sun, cor: 'text-alerta' },
  { chave: 'SEMANA', titulo: 'Próximos 7 dias', Icone: CalendarClock, cor: 'text-marca-ciano' },
  { chave: 'DEPOIS', titulo: 'Mais adiante', Icone: CalendarCheck2, cor: 'text-muted' },
  { chave: 'SEM_PRAZO', titulo: 'Sem prazo', Icone: Inbox, cor: 'text-muted' },
];

const TIPO: Record<TipoTarefa, { rotulo: string; Icone: IconeDecorativo }> = {
  TAREFA: { rotulo: 'Tarefa', Icone: ListChecks },
  FOLLOW_UP: { rotulo: 'Follow-up', Icone: BellRing },
};

/** Só as prioridades que mudam a conduta aparecem; NORMAL e BAIXA são ruído aqui. */
const PRIORIDADE_VISIVEL: Partial<Record<Prioridade, { rotulo: string; cor: string }>> = {
  URGENTE: { rotulo: 'Urgente', cor: 'border-erro/30 bg-erro/10 text-erro' },
  ALTA: { rotulo: 'Alta', cor: 'border-alerta/30 bg-alerta/10 text-alerta' },
};

function classificar(t: TarefaDaAgenda, hoje: string, limiteSemana: string): Balde {
  if (!t.prazo) return 'SEM_PRAZO';
  const dia = diaISO(t.prazo);
  if (dia < hoje) return 'ATRASADA';
  if (dia === hoje) return 'HOJE';
  return dia <= limiteSemana ? 'SEMANA' : 'DEPOIS';
}

export default function MeuDiaPage() {
  const [agenda, setAgenda] = useState<Estado<Agenda>>(CARREGANDO);
  const [ocupada, setOcupada] = useState<string | null>(null);
  const [erroAcao, setErroAcao] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setAgenda(CARREGANDO);
    try {
      setAgenda({ st: 'ok', dados: await crm.minhasTarefas() });
    } catch (e) {
      setAgenda({ st: 'erro', msg: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function concluir(t: TarefaDaAgenda) {
    setOcupada(t.id);
    setErroAcao(null);
    try {
      await crm.editarTarefa(t.processo.id, t.id, { concluida: true });
      /* Sai da lista em vez de virar item riscado: esta tela é a fila do que
         FALTA. Item concluído continuar visível aqui empurraria para baixo o que
         ainda precisa de atenção — o oposto do que a página existe para fazer. */
      setAgenda((a) =>
        a.st === 'ok'
          ? {
              st: 'ok',
              dados: {
                ...a.dados,
                tarefas: a.dados.tarefas.filter((x) => x.id !== t.id),
                total: a.dados.total - 1,
              },
            }
          : a,
      );
    } catch (e) {
      setErroAcao((e as Error).message);
    } finally {
      setOcupada(null);
    }
  }

  const hoje = hojeISO();
  const limiteSemana = somarDias(hoje, 7);
  const tarefas = agenda.st === 'ok' ? agenda.dados.tarefas : [];

  const porBalde = new Map<Balde, TarefaDaAgenda[]>();
  for (const t of tarefas) {
    const b = classificar(t, hoje, limiteSemana);
    porBalde.set(b, [...(porBalde.get(b) ?? []), t]);
  }
  const atrasadas = porBalde.get('ATRASADA')?.length ?? 0;
  const deHoje = porBalde.get('HOJE')?.length ?? 0;
  const semDono = tarefas.filter((t) => !t.responsavel).length;

  return (
    <div className="relative min-h-screen">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <motion.div
          className="absolute -right-40 -top-40 h-[36rem] w-[36rem] rounded-full opacity-[0.13] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#6366f1,transparent 68%)' }}
          animate={{ x: [0, -40, 0], y: [0, 40, 0] }}
          transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.div
          className="absolute -left-32 top-1/3 h-[30rem] w-[30rem] rounded-full opacity-[0.1] blur-[120px]"
          style={{ background: 'radial-gradient(circle,#22d3ee,transparent 68%)' }}
          animate={{ x: [0, 40, 0], y: [0, -30, 0] }}
          transition={{ duration: 24, repeat: Infinity, ease: 'easeInOut', delay: 4 }}
        />
      </div>

      <div className="relative p-6 lg:p-9">
        <motion.header
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-7"
        >
          <p className="rotulo">Carteira</p>
          <h1 className="mt-1.5 font-display text-[28px] font-semibold tracking-tight text-ink">
            Meu dia
          </h1>
          {agenda.st === 'ok' && (
            <p className="mt-2 text-[13px] text-muted" role="status">
              {atrasadas > 0 && (
                <span className="font-medium text-erro">
                  <span className="num">{atrasadas}</span> em atraso
                </span>
              )}
              {atrasadas > 0 && (deHoje > 0 || tarefas.length > 0) && ' · '}
              {deHoje > 0 && (
                <span className="font-medium text-alerta">
                  <span className="num">{deHoje}</span> para hoje
                </span>
              )}
              {deHoje > 0 && ' · '}
              <span className="num">{agenda.dados.total}</span>{' '}
              {agenda.dados.total === 1 ? 'pendência aberta' : 'pendências abertas'}
              {semDono > 0 && (
                <>
                  {' · '}
                  <span className="num">{semDono}</span> sem responsável
                </>
              )}
            </p>
          )}
        </motion.header>

        {erroAcao && <BlocoErro msg={erroAcao} className="mb-4" />}

        {agenda.st === 'erro' && (
          <div className="cartao border-erro/25 p-6" role="alert">
            <BlocoErro msg={`Não foi possível carregar sua agenda: ${agenda.msg}`} />
            <button
              type="button"
              onClick={() => void carregar()}
              className="mt-4 flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
            >
              <RotateCw aria-hidden className="h-3.5 w-3.5" />
              Tentar novamente
            </button>
          </div>
        )}

        {agenda.st === 'carregando' && (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <Esqueleto key={i} className="h-[74px] rounded" />
            ))}
          </div>
        )}

        {agenda.st === 'ok' && tarefas.length === 0 && (
          <div className="cartao">
            <Vazio
              Icone={CalendarCheck2}
              titulo="Nada pendente"
              descricao="Nenhuma tarefa ou follow-up aberto atribuído a você — nem solto esperando alguém assumir."
              acao={
                <Link
                  href="/consulta"
                  className="flex h-9 items-center gap-2 rounded-[11px] border border-linha px-3.5 text-[13px] text-ink-2 transition-colors hover:border-linha-2 hover:bg-superficie"
                >
                  Ir para a consulta
                </Link>
              }
            />
          </div>
        )}

        {agenda.st === 'ok' && tarefas.length > 0 && (
          <div className="space-y-6">
            {BALDES.map(({ chave, titulo, Icone, cor }, iBalde) => {
              const doBalde = porBalde.get(chave) ?? [];
              if (doBalde.length === 0) return null;

              return (
                <motion.section
                  key={chave}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: 0.6,
                    delay: 0.08 + iBalde * 0.06,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  aria-labelledby={`balde-${chave}`}
                >
                  <div className="mb-2.5 flex items-center gap-2">
                    <Icone aria-hidden className={cn('h-3.5 w-3.5', cor)} />
                    <h2
                      id={`balde-${chave}`}
                      className={cn('font-display text-sm font-semibold', cor)}
                    >
                      {titulo}
                    </h2>
                    <span className="rotulo num">{doBalde.length}</span>
                  </div>

                  <ul className="space-y-2">
                    {doBalde.map((t, i) => (
                      <ItemAgenda
                        key={t.id}
                        tarefa={t}
                        indice={i}
                        balde={chave}
                        ocupada={ocupada === t.id}
                        aoConcluir={() => void concluir(t)}
                      />
                    ))}
                  </ul>
                </motion.section>
              );
            })}

            {agenda.dados.truncado && (
              <p className="text-[11px] text-muted" role="status">
                Mostrando <span className="num">{tarefas.length}</span> de{' '}
                <span className="num">{agenda.dados.total}</span> pendências. Conclua as mais
                urgentes para ver o resto.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ItemAgenda({
  tarefa: t,
  indice,
  balde,
  ocupada,
  aoConcluir,
}: {
  tarefa: TarefaDaAgenda;
  indice: number;
  balde: Balde;
  ocupada: boolean;
  aoConcluir: () => void;
}) {
  const meta = TIPO[t.tipo] ?? TIPO.TAREFA;
  const prioridade = PRIORIDADE_VISIVEL[t.processo.prioridade];
  const semDono = !t.responsavel;

  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: Math.min(indice, 10) * 0.03, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'cartao flex items-start gap-3 p-4',
        balde === 'ATRASADA' && 'border-erro/25',
      )}
    >
      <button
        type="button"
        onClick={aoConcluir}
        disabled={ocupada}
        role="checkbox"
        aria-checked={false}
        aria-label={`Concluir ${t.titulo}`}
        className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border border-linha-2 text-transparent transition-colors hover:border-ok/50 hover:bg-ok/10 hover:text-ok disabled:opacity-40"
      >
        {ocupada ? (
          <Loader2 aria-hidden className="h-3 w-3 animate-spin text-muted" />
        ) : (
          <Check aria-hidden className="h-3 w-3" />
        )}
      </button>

      <div className="min-w-0 flex-1">
        <p className="break-words text-[13px] leading-snug text-ink-2">{t.titulo}</p>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <span className="flex items-center gap-1 text-muted">
            <meta.Icone aria-hidden className="h-3 w-3" />
            {meta.rotulo}
          </span>

          {t.prazo && (
            <span
              className={cn(
                'num flex items-center gap-1',
                balde === 'ATRASADA'
                  ? 'font-medium text-erro'
                  : balde === 'HOJE'
                    ? 'font-medium text-alerta'
                    : 'text-muted',
              )}
            >
              <CalendarClock aria-hidden className="h-3 w-3" />
              {diaLegivel(t.prazo)}
            </span>
          )}

          {/* Quem não tem dono é o que some no dia a dia: sinalizado, não sutil. */}
          {semDono && (
            <span className="flex items-center gap-1 rounded-full border border-marca-violeta/30 bg-marca-violeta/10 px-2 py-0.5 font-medium text-marca-violeta">
              <UserPlus aria-hidden className="h-3 w-3" />
              sem responsável
            </span>
          )}

          {prioridade && (
            <span className={cn('rounded-full border px-2 py-0.5 font-medium', prioridade.cor)}>
              {prioridade.rotulo}
            </span>
          )}
        </div>

        {/* O processo é o contexto sem o qual a tarefa não significa nada. */}
        <Link
          href={`/processo/${t.processo.id}`}
          className="group mt-2 inline-flex items-center gap-1.5 text-[11px] text-muted transition-colors hover:text-marca-ciano"
        >
          <span className="num">{t.processo.numeroPrecatorio}</span>
          {t.processo.entidadeDevedora && <span>· {t.processo.entidadeDevedora}</span>}
          <ChevronRight
            aria-hidden
            className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </motion.li>
  );
}
