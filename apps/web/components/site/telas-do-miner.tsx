'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

/**
 * VEJA O MINER EM AÇÃO — quatro abas: a apresentação em vídeo e três telas
 * desenhadas em código.
 *
 * A PRIMEIRA aba é diferente das outras por natureza: é uma GRAVAÇÃO do
 * sistema real (dados pessoais ocultados na edição), e a legenda dela diz
 * isso. As demais continuam interface codificada: nítida em qualquer
 * densidade, ~0 KB de imagem, dados FICTÍCIOS declarados na legenda —
 * espelhando módulos que EXISTEM (carteira, processo, funil). Desenhar tela
 * que o produto não tem seria vender maquete.
 *
 * O alternador avança sozinho a cada 6s e PARA no primeiro toque humano —
 * autoplay que disputa com o dedo do visitante é carrossel que ninguém lê.
 *
 * Tradeoff assumido: trocar de aba com o vídeo rodando DESMONTA o player e
 * perde a posição. É escolha, não descuido — manter o iframe vivo escondido
 * deixaria áudio tocando por baixo de outra aba, que é pior. Se um dia a
 * retomada importar, o caminho é a IFrame Player API (getCurrentTime antes de
 * desmontar + start=N ao voltar).
 */
const CPF_FICTICIO = '***.472.881-**';

function TelaCarteira(_props: { aoInteragir?: () => void }) {
  const linhas = [
    /* Os tribunais variam de propósito: a demonstração mostrava só TRF1 e TRF5,
       e a carteira real alcança 42 tribunais das três justiças. */
    { nome: 'M. A. Cavalcanti', trf: 'TRF5', valor: 'R$ 214.380', status: 'NOVO', ouro: true },
    { nome: 'J. R. Figueiredo', trf: 'TJPE', valor: 'R$ 96.150', status: 'CONTATO', ouro: false },
    { nome: 'C. L. Sarmento', trf: 'TRF1', valor: 'R$ 187.925', status: 'NOVO', ouro: true },
    { nome: 'A. P. Nogueira', trf: 'TRT3', valor: 'R$ 45.600', status: 'PROPOSTA', ouro: false },
  ];
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
          CARTEIRA · 250 NOVOS ESTE CICLO
        </span>
        <span className="font-mono text-[10px]" style={{ color: 'var(--sonda)' }}>
          42 TRIBUNAIS
        </span>
      </div>
      <div className="mt-3 grid gap-1.5">
        {linhas.map((l) => (
          <div
            key={l.nome}
            className="flex items-center justify-between rounded-md border px-3 py-2.5"
            style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}
          >
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium" style={{ color: 'var(--texto-j)' }}>
                {l.nome}
              </p>
              <p className="font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>
                {l.trf} · {CPF_FICTICIO}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="font-mono text-[12px] tabular-nums"
                style={{ color: l.ouro ? 'var(--veio)' : 'var(--bruma)' }}
              >
                {l.valor}
              </span>
              <span
                className="rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wide"
                style={{ borderColor: 'var(--linha-j)', color: 'var(--bruma)' }}
              >
                {l.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TelaProcesso(_props: { aoInteragir?: () => void }) {
  return (
    <div className="p-4 sm:p-5">
      <span className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
        PROCESSO · TITULAR IDENTIFICADO
      </span>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border p-3.5" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}>
          <p className="font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>TITULAR</p>
          <p className="mt-1 text-[14px] font-semibold" style={{ color: 'var(--texto-j)' }}>M. A. Cavalcanti</p>
          <p className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--bruma)' }}>{CPF_FICTICIO}</p>
          <div className="mt-3 grid gap-1 font-mono text-[11px]" style={{ color: 'var(--bruma)' }}>
            <span>(81) 9****-**41 · conferido</span>
            <span>m*****@*****.com · conferido</span>
          </div>
        </div>
        <div className="rounded-md border p-3.5" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}>
          <p className="font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>PRECATÓRIO</p>
          <p className="mt-1 font-mono text-[12px]" style={{ color: 'var(--bruma)' }}>0801***-**.2024.4.05.****</p>
          <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>VALOR DO TITULAR</p>
          <p className="font-mono text-[19px] font-semibold tabular-nums" style={{ color: 'var(--veio)' }}>
            R$ 214.380,00
          </p>
          <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>
            TRF5 · INSS · EXERCÍCIO 2027
          </p>
        </div>
      </div>
      <div
        className="mt-3 rounded-md border px-3.5 py-2.5 font-mono text-[11px]"
        style={{ borderColor: 'rgba(42,212,232,.25)', color: 'var(--sonda)', background: 'rgba(42,212,232,.05)' }}
      >
        SALDO ATUALIZADO PELA CALCULADORA OFICIAL DO CNJ
      </div>
    </div>
  );
}

function TelaFunil(_props: { aoInteragir?: () => void }) {
  const colunas = [
    { nome: 'Novo', qtd: 12 },
    { nome: 'Contato', qtd: 7 },
    { nome: 'Proposta', qtd: 4 },
    { nome: 'Fechado', qtd: 2, ouro: true },
  ];
  return (
    <div className="p-4 sm:p-5">
      <span className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
        CRM · FUNIL DE NEGOCIAÇÃO
      </span>
      <div className="mt-3 grid grid-cols-4 gap-2">
        {colunas.map((c) => (
          <div key={c.nome} className="rounded-md border p-2.5" style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato-2)' }}>
            <p className="text-[11px] font-medium" style={{ color: 'var(--bruma)' }}>{c.nome}</p>
            <p
              className="mt-1 font-mono text-[18px] font-semibold tabular-nums"
              style={{ color: c.ouro ? 'var(--veio)' : 'var(--texto-j)' }}
            >
              {c.qtd}
            </p>
            <div className="mt-2 grid gap-1">
              {Array.from({ length: Math.min(c.qtd, 3) }).map((_, i) => (
                <span key={i} className="block h-1.5 rounded-full" style={{ background: 'var(--linha-j)' }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 font-mono text-[11px]" style={{ color: 'var(--bruma)' }}>
        Propostas, parcelamento e tarefas na mesma tela do lead, sem exportar planilha.
      </p>
    </div>
  );
}

const VIDEO_APRESENTACAO = 'a8Grs69FnKE';

/**
 * A APRESENTAÇÃO — o vídeo gravado do sistema real.
 *
 * Diferente das outras telas, isto NÃO é representação: é o produto em uso,
 * gravado da interface de verdade (dados pessoais ocultados na edição). Por
 * isso a legenda desta aba é outra — dizer "dados fictícios" sobre uma
 * gravação real seria mentir ao contrário.
 *
 * O iframe do YouTube só nasce DEPOIS do clique, e no domínio youtube-nocookie:
 * até o visitante decidir assistir, a página não fala com o Google — a mesma
 * postura de LGPD que o resto do site vende. O pôster é desenhado em código,
 * como tudo aqui: pesa zero e não depende da miniatura que o YouTube escolher.
 */
function TelaApresentacao({ aoInteragir }: { aoInteragir?: () => void }) {
  const [tocando, setTocando] = useState(false);

  if (tocando) {
    return (
      <div className="aspect-video w-full">
        <iframe
          className="h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${VIDEO_APRESENTACAO}?autoplay=1&rel=0`}
          title="Apresentação do Leão Amorim Miner"
          allow="autoplay; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setTocando(true);
        aoInteragir?.(); /* quem dá o play não quer o carrossel girando por baixo */
      }}
      aria-label="Assistir à apresentação do sistema"
      className="group relative block aspect-video w-full cursor-pointer text-left"
    >
      <span className="absolute left-4 top-4 font-mono text-[10px] tracking-[0.2em] sm:left-5 sm:top-5" style={{ color: 'var(--bruma-2)' }}>
        APRESENTAÇÃO · GRAVADA DO SISTEMA
      </span>
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-4">
        <span
          className="flex h-16 w-16 items-center justify-center rounded-full border transition-transform group-hover:scale-105"
          style={{
            borderColor: 'rgba(79,124,255,.45)',
            background: 'rgba(79,124,255,.10)',
            boxShadow: '0 0 40px rgba(79,124,255,.15)',
          }}
        >
          <span
            aria-hidden
            className="ml-1 block h-0 w-0"
            style={{
              borderTop: '11px solid transparent',
              borderBottom: '11px solid transparent',
              borderLeft: '18px solid var(--veio)',
            }}
          />
        </span>
        <span className="px-6 text-center text-[14px]" style={{ color: 'var(--bruma)' }}>
          Do login ao funil, no sistema de verdade — sem roteiro de maquete.
        </span>
        <span className="font-mono text-[10px] tracking-[0.2em]" style={{ color: 'var(--bruma-2)' }}>
          YOUTUBE · CARREGA SÓ AO TOCAR
        </span>
      </span>
    </button>
  );
}

const TELAS = [
  { id: 'apresentacao', rotulo: 'Apresentação', Comp: TelaApresentacao, legenda: 'GRAVAÇÃO DO SISTEMA REAL · DADOS PESSOAIS OCULTADOS' },
  { id: 'carteira', rotulo: 'Carteira', Comp: TelaCarteira, legenda: 'REPRESENTAÇÃO ILUSTRATIVA · DADOS FICTÍCIOS' },
  { id: 'processo', rotulo: 'Processo', Comp: TelaProcesso, legenda: 'REPRESENTAÇÃO ILUSTRATIVA · DADOS FICTÍCIOS' },
  { id: 'funil', rotulo: 'Funil do CRM', Comp: TelaFunil, legenda: 'REPRESENTAÇÃO ILUSTRATIVA · DADOS FICTÍCIOS' },
] as const;

export function TelasDoMiner() {
  const [ativa, setAtiva] = useState(0);
  const [pausado, setPausado] = useState(false);
  /* O gate do carrossel e um REF checado dentro do proprio tick, alem do
     estado que desliga o efeito. Sem isso havia uma corrida de milissegundos:
     um tick de 6s vencido entre o clique no play e a limpeza do intervalo
     (que so roda na fase de efeitos, depois do paint) trocava de aba e
     desmontava o iframe no instante em que ele nascia. */
  const pausadoRef = useRef(false);
  const semMovimento = useReducedMotion();

  useEffect(() => {
    if (pausado || semMovimento) return;
    const t = setInterval(() => {
      if (!pausadoRef.current) setAtiva((a) => (a + 1) % TELAS.length);
    }, 6000);
    return () => clearInterval(t);
  }, [pausado, semMovimento]);

  const Tela = TELAS[ativa].Comp;
  /* O play do vídeo é interação tão humana quanto clicar numa aba: o
     carrossel morre nas duas. Sem isto, o autoplay trocava de aba aos 6s
     com o vídeo rodando por baixo — áudio sem imagem. */
  const pausar = () => {
    pausadoRef.current = true; /* sincrono: mata ate tick ja enfileirado */
    setPausado(true);
  };

  return (
    <div>
      <div role="tablist" aria-label="Telas do produto" className="flex flex-wrap gap-2">
        {TELAS.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={i === ativa}
            onClick={() => {
              setAtiva(i);
              pausadoRef.current = true;
              setPausado(true); /* o dedo humano manda; o autoplay morre aqui */
            }}
            className="cursor-pointer rounded-full border px-4 py-1.5 text-[13px] transition-colors"
            style={{
              borderColor: i === ativa ? 'var(--sonda)' : 'var(--linha-j)',
              color: i === ativa ? 'var(--sonda)' : 'var(--bruma)',
              background: i === ativa ? 'rgba(42,212,232,.07)' : 'transparent',
            }}
          >
            {t.rotulo}
          </button>
        ))}
      </div>

      <div
        className="mt-4 overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--linha-j)', background: 'var(--estrato)', minHeight: 280 }}
      >
        {/* A barra de janela: o sinal universal de "isto é uma interface". */}
        <div className="flex items-center gap-1.5 border-b px-4 py-2.5" style={{ borderColor: 'var(--linha-j)' }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-2 w-2 rounded-full" style={{ background: 'var(--linha-j)' }} />
          ))}
          <span className="ml-2 font-mono text-[10px]" style={{ color: 'var(--bruma-2)' }}>
            app.laminer.com.br
          </span>
        </div>
        <AnimatePresence mode="wait">
          <motion.div
            key={TELAS[ativa].id}
            initial={semMovimento ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={semMovimento ? undefined : { opacity: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Tela aoInteragir={pausar} />
          </motion.div>
        </AnimatePresence>
      </div>

      <p className="mt-2.5 font-mono text-[10px] tracking-[0.16em]" style={{ color: 'var(--bruma-2)' }}>
        {TELAS[ativa].legenda}
      </p>
    </div>
  );
}
