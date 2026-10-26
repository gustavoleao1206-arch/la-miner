import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  brl,
  cpfFormatado,
  compacto,
  hojeISO,
  diaISO,
  diaLegivel,
  somarDias,
  dataCalendario,
} from '@/lib/utils';

describe('brl — dinheiro em pt-BR', () => {
  it('formata número e string', () => {
    expect(brl(1234.56)).toBe('R$ 1.234,56');
    // A API devolve Decimal como string; brl aceita as duas formas.
    expect(brl('919542.51')).toBe('R$ 919.542,51');
  });

  it('null, undefined e NaN viram travessão, não "R$ 0,00"', () => {
    /* A distinção importa: R$ 0,00 é uma AFIRMAÇÃO sobre o valor; ausência é
       outra coisa, e mostrar zero onde não há dado engana quem lê o agregado. */
    expect(brl(null)).toBe('—');
    expect(brl(undefined)).toBe('—');
    expect(brl('não é número')).toBe('—');
  });

  it('zero é um valor de verdade e aparece', () => {
    expect(brl(0)).toBe('R$ 0,00');
  });
});

describe('cpfFormatado', () => {
  it('põe a máscara nos 11 dígitos', () => {
    expect(cpfFormatado('52998224725')).toBe('529.982.247-25');
  });

  it('limpa o que já vem com máscara antes de reformatar', () => {
    expect(cpfFormatado('529.982.247-25')).toBe('529.982.247-25');
  });

  it('comprimento errado devolve o que veio, sem inventar máscara', () => {
    expect(cpfFormatado('123')).toBe('123');
    expect(cpfFormatado(null)).toBe('—');
  });
});

describe('compacto', () => {
  it('abrevia em pt-BR', () => {
    // "mil" em pt-BR compact.
    expect(compacto(1500)).toBe('1,5 mil');
    expect(compacto(2_000_000)).toBe('2 mi');
  });
});

/**
 * As funções de DATA — o coração do bug de fuso que já custou uma correção
 * (nascimento aparecendo um dia antes). Testadas sob fusos DIFERENTES via
 * TZ mockado, porque o defeito só aparece longe de UTC.
 */
describe('datas de calendário', () => {
  const tzOriginal = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tzOriginal;
    vi.useRealTimers();
  });

  describe('diaISO / diaLegivel — recorte de string, sem Date', () => {
    it('extrai o dia dos 10 primeiros caracteres', () => {
      expect(diaISO('2026-07-25T00:00:00.000Z')).toBe('2026-07-25');
    });

    /**
     * O ponto todo: um DATE que chega como meia-noite UTC NÃO pode virar o dia
     * anterior. `diaLegivel` recorta a string em vez de passar por `new Date()`,
     * então dá o mesmo resultado em qualquer fuso.
     */
    it('1968-03-14 continua 14/03/1968 — nunca 13/03', () => {
      expect(diaLegivel('1968-03-14T00:00:00.000Z')).toBe('14/03/1968');
    });

    it('é imune ao fuso: idêntico em Recife e em Tóquio', () => {
      const iso = '1968-03-14T00:00:00.000Z';
      process.env.TZ = 'America/Recife'; // UTC-3
      const emRecife = diaLegivel(iso);
      process.env.TZ = 'Asia/Tokyo'; // UTC+9
      const emTokyo = diaLegivel(iso);
      expect(emRecife).toBe('14/03/1968');
      expect(emTokyo).toBe('14/03/1968');
    });
  });

  describe('dataCalendario — formata em UTC de propósito', () => {
    it('mostra o dia do campo, não o dia local', () => {
      expect(dataCalendario('2015-11-03T00:00:00.000Z')).toBe('03/11/2015');
    });

    it('nulo e data inválida viram travessão', () => {
      expect(dataCalendario(null)).toBe('—');
      expect(dataCalendario('não é data')).toBe('—');
    });

    /**
     * A regressão direta do bug: sem `timeZone: 'UTC'`, meia-noite UTC lida em
     * Brasília cai no dia anterior. Com o fuso forçado, o dia é estável.
     */
    it('não retrocede um dia em UTC-3', () => {
      process.env.TZ = 'America/Sao_Paulo';
      expect(dataCalendario('1968-03-14T00:00:00.000Z')).toBe('14/03/1968');
    });
  });

  describe('hojeISO — hoje no fuso de quem lê', () => {
    /**
     * Às 21h de São Paulo (UTC-3) já é o dia SEGUINTE em UTC. `hojeISO` tem de
     * devolver o dia LOCAL, senão tudo que vence amanhã aparece como atrasado
     * nas últimas 3 horas de cada dia. Este teste fixa 20/07 23:30 local e
     * exige "2026-07-20", não "2026-07-21".
     */
    it('devolve o dia local, não o dia UTC, à noite', () => {
      process.env.TZ = 'America/Sao_Paulo';
      // 2026-07-20 23:30 em São Paulo = 2026-07-21 02:30 UTC.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-21T02:30:00.000Z'));
      expect(hojeISO()).toBe('2026-07-20');
    });
  });

  describe('somarDias — aritmética em UTC', () => {
    it('soma dias sem drift', () => {
      expect(somarDias('2026-07-20', 7)).toBe('2026-07-27');
      expect(somarDias('2026-07-20', 0)).toBe('2026-07-20');
    });

    it('atravessa a virada de mês e de ano', () => {
      expect(somarDias('2026-07-30', 5)).toBe('2026-08-04');
      expect(somarDias('2026-12-30', 3)).toBe('2027-01-02');
    });

    it('aceita subtração', () => {
      expect(somarDias('2026-07-20', -1)).toBe('2026-07-19');
    });

    /**
     * O horário de verão brasileiro acabou, mas a aritmética é 100% UTC de
     * propósito para nunca "pular" um dia numa transição de DST. Somar 1 dia
     * sobre a antiga data de virada nunca deve dar 2 nem 0.
     */
    it('não pula dia numa data que já foi virada de DST', () => {
      process.env.TZ = 'America/Sao_Paulo';
      // 2018-11-04 foi início do horário de verão (relógio pulou 00→01).
      expect(somarDias('2018-11-03', 1)).toBe('2018-11-04');
      expect(somarDias('2018-11-04', 1)).toBe('2018-11-05');
    });
  });
});
