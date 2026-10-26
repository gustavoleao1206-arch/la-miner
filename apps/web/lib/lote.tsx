'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, type TribunalCatalogo } from '@/lib/api';
import { useUsuario } from '@/lib/usuario';

/**
 * Lote em foco: qual tribunal e qual exercício as telas estão mostrando.
 *
 * Vive num contexto do painel inteiro, e não em cada página, porque é ESCOPO e
 * não filtro: trocar o tribunal no dashboard e voltar à consulta ainda no lote
 * anterior daria dois recortes ativos ao mesmo tempo, com números que não
 * fecham entre si — exatamente o problema que criou o conceito de lote.
 *
 * Guardado em `sessionStorage` junto com os tokens: sobrevive ao F5 e morre com
 * a sessão. Em `localStorage` sobreviveria à troca de usuário, e o operador
 * seguinte abriria a carteira no recorte de quem usou a máquina antes.
 */
export interface Lote {
  tribunal: string;
  exercicio: number;
}

const CHAVE = 'miner.lote';

interface Contexto {
  /** `null` enquanto o catálogo não chegou — as telas usam o padrão da API. */
  lote: Lote | null;
  /** `null` LIMPA o recorte — é como o cliente volta a ver a carteira inteira. */
  definir: (l: Lote | null) => void;
  catalogo: TribunalCatalogo[];
  carregando: boolean;
  /** Query string pronta (`?tribunal=..&exercicio=..`), ou '' antes de resolver. */
  query: string;
}

const LoteContext = createContext<Contexto>({
  lote: null,
  definir: () => {},
  catalogo: [],
  carregando: true,
  query: '',
});

function lerGuardado(): Lote | null {
  if (typeof window === 'undefined') return null;
  try {
    const cru = sessionStorage.getItem(CHAVE);
    if (!cru) return null;
    const l = JSON.parse(cru) as Lote;
    return typeof l?.tribunal === 'string' && Number.isInteger(l?.exercicio) ? l : null;
  } catch {
    /* JSON corrompido não pode derrubar o painel: cai no padrão. */
    return null;
  }
}

export function ProvedorLote({ children }: { children: React.ReactNode }) {
  const [lote, setLote] = useState<Lote | null>(null);
  const [catalogo, setCatalogo] = useState<TribunalCatalogo[]>([]);
  const [carregando, setCarregando] = useState(true);

  const { ehCliente, carregado } = useUsuario();

  useEffect(() => {
    /* ESPERA saber quem está olhando. Decidir antes cairia sempre no ramo do
       operador (`ehCliente` nasce false), que é justamente o que precisamos
       evitar — e o efeito rodaria uma vez só, com a resposta errada. */
    if (!carregado) return;
    let vivo = true;
    api<TribunalCatalogo[]>('/carteira/tribunais')
      .then((cat) => {
        if (!vivo) return;
        setCatalogo(cat);

        /* Só aceita o lote guardado se ele AINDA existe na carteira. Um recorte
           salvo que perdeu os processos deixaria a tela permanentemente vazia,
           e o operador não teria como saber que o culpado é a sessão anterior. */
        const guardado = lerGuardado();
        const valido =
          guardado &&
          cat.some(
            (t) =>
              t.sigla === guardado.tribunal &&
              t.exercicios.some((e) => e.exercicio === guardado.exercicio),
          );

        if (valido) {
          /* Escolha DELE, guardada da sessão: vale para qualquer um. O cliente
             pode filtrar por tribunal se quiser — o que não pode é receber um
             filtro que nunca pediu. */
          setLote(guardado);
        } else if (!ehCliente) {
          /* Padrão: o maior lote que a organização tem de fato. Abrir no que
             tem mais processos é o palpite certo para quase todo escritório, e
             não depende de constante no código do servidor. */
          const maior = cat
            .flatMap((t) => t.exercicios.map((e) => ({ tribunal: t.sigla, ...e })))
            .sort((a, b) => b.processos - a.processos)[0];
          if (maior) setLote({ tribunal: maior.tribunal, exercicio: maior.exercicio });
        }
        /* ── CLIENTE FICA SEM LOTE, E ISSO É O CONSERTO ──
           Escolher "o maior" para o assinante escondia o resto do que ele
           comprou: com 250 processos sorteados do país inteiro, 158 caíram no
           TRF1 e 92 no TRF5 — e a tela abria no TRF1, mostrando 158 de 250.
           Pior, o back já tinha sido consertado para não recortar o cliente;
           o front continuava PEDINDO o recorte, e pedido explícito manda.
           Sem lote, a query sai vazia e ele vê a carteira inteira. */
      })
      .catch(() => {
        /* Sem catálogo, as telas seguem com o padrão da API. Falhar aqui não
           pode impedir o operador de trabalhar. */
      })
      .finally(() => vivo && setCarregando(false));
    return () => {
      vivo = false;
    };
    /* Depende de quem está olhando: com `[]` o efeito rodava UMA vez, antes de
       o usuário ser conhecido, e a decisão saía errada para todo cliente. */
  }, [carregado, ehCliente]);

  const definir = useCallback((l: Lote | null) => {
    setLote(l);
    try {
      /* Limpar precisa APAGAR o guardado: deixá-lo lá faria o recorte
         ressuscitar no próximo F5, e o cliente veria a carteira encolher
         sozinha sem ter mexido em nada. */
      if (l) sessionStorage.setItem(CHAVE, JSON.stringify(l));
      else sessionStorage.removeItem(CHAVE);
    } catch {
      /* Modo privado sem storage: o lote vale só para esta navegação. */
    }
  }, []);

  const valor = useMemo<Contexto>(
    () => ({
      lote,
      definir,
      catalogo,
      carregando,
      query: lote ? `tribunal=${encodeURIComponent(lote.tribunal)}&exercicio=${lote.exercicio}` : '',
    }),
    [lote, definir, catalogo, carregando],
  );

  return <LoteContext.Provider value={valor}>{children}</LoteContext.Provider>;
}

export const useLote = () => useContext(LoteContext);

/**
 * UFs oferecidas no filtro de endereço, derivadas do tribunal em foco.
 *
 * Substitui a lista fixa `['AL','BA','CE','PB','PE','PI','RN','SE']`, que era um
 * "Nordeste" ad-hoc — nem batia com a jurisdição do TRF5, que não inclui BA nem
 * PI. Sem tribunal resolvido, devolve as 27: melhor oferecer demais que esconder
 * o estado onde o requerente mora.
 */
export function useUfsDoLote(): string[] {
  const { lote, catalogo } = useLote();
  return useMemo(() => {
    const t = catalogo.find((x) => x.sigla === lote?.tribunal);
    /* Jurisdição é onde o TRIBUNAL julga; o filtro é onde a PESSOA mora, e as
       duas coisas divergem (requerente do TRF5 morando em SP existe). Por isso
       a lista da jurisdição vem primeiro, mas as demais continuam disponíveis. */
    const jurisdicao = t?.ufsJurisdicao ?? [];
    const resto = TODAS_UFS.filter((uf) => !jurisdicao.includes(uf));
    return [...jurisdicao, ...resto];
  }, [lote, catalogo]);
}

/** As 27 unidades federativas, em ordem alfabética. */
export const TODAS_UFS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
];
