import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function brl(v: number | string | null | undefined): string {
  const n = typeof v === 'string' ? Number(v) : v;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function cpfFormatado(cpf: string | null | undefined): string {
  const d = (cpf ?? '').replace(/\D/g, '');
  if (d.length !== 11) return cpf ?? '—';
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

export function compacto(n: number): string {
  return n.toLocaleString('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
}

/* ── Datas de CALENDÁRIO ──────────────────────────────────────────────────────
 *
 * Moram aqui, e não na tela que as usa, porque já custaram um bug: a página do
 * processo formatava data de nascimento com `toLocaleDateString` sem fuso e
 * mostrava 13/03 para quem nasceu em 14/03 — meia-noite UTC lida em Brasília
 * cai no dia anterior. Duas telas precisam disso agora (prazo de tarefa e
 * nascimento); uma terceira cópia seria a próxima ocorrência do mesmo erro.
 *
 * A regra: DATA (nascimento, prazo, autuação) é dia e se trata em UTC. INSTANTE
 * (criação, conclusão, sincronização) é momento e se exibe no fuso do leitor.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * Hoje no fuso de QUEM LÊ, em AAAA-MM-DD.
 *
 * Montado campo a campo em vez de `toISOString().slice(0,10)`: às 21h de
 * Brasília o ISO já aponta para o dia seguinte em UTC, e o que vence amanhã
 * apareceria como atrasado nas últimas 3 horas de todo dia.
 */
export function hojeISO(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/**
 * O dia de um campo DATE, direto dos 10 primeiros caracteres do ISO.
 *
 * A coluna é DATE e sempre chega como meia-noite UTC, então recortar a string é
 * exato. Comparar dois AAAA-MM-DD como TEXTO dá o mesmo resultado que comparar
 * como data, sem passar por `new Date()` e sem chance de o fuso deslocar o dia.
 */
export const diaISO = (iso: string): string => iso.slice(0, 10);

/** AAAA-MM-DD → DD/MM/AAAA, sem construir Date (ver acima). */
export function diaLegivel(iso: string): string {
  const [ano, mes, dia] = diaISO(iso).split('-');
  return `${dia}/${mes}/${ano}`;
}

/** Soma dias a um AAAA-MM-DD. Aritmética 100% em UTC, então não pula por DST. */
export function somarDias(iso: string, n: number): string {
  const d = new Date(`${diaISO(iso)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Data de calendário formatada para exibição. `timeZone: 'UTC'` é o ponto todo.
 *
 * NÃO use para instante: evento e sincronização têm de aparecer no fuso de quem
 * lê, e forçá-los a UTC mostraria 3 horas a menos para o Brasil inteiro.
 */
export function dataCalendario(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Limiar único de criticidade do consumo diário do provedor.
 *
 * O dashboard usava 85 e a tela de Fila usava 80: entre 80% e 85% uma dizia
 * "normal" e a outra "crítico" sobre exatamente o mesmo número. Vale o valor
 * mais conservador — quem paga por consulta prefere o alerta cedo.
 */
export const LIMIAR_CONSUMO_CRITICO = 80;
