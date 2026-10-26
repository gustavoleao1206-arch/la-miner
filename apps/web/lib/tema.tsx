'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/**
 * Tema claro/escuro, sem dependência externa.
 *
 * O modo vive numa classe `.dark` no <html>, que dirige todas as variáveis de
 * cor (ver globals.css). A preferência persiste em localStorage e é aplicada
 * ANTES do primeiro paint por um script inline no <head> (ver SCRIPT_ANTI_FOUC
 * no layout) — sem isso, a tela pisca no tema errado a cada carregamento.
 *
 * O provider apenas espelha em React o que o script já decidiu, para os
 * componentes (o toggle) saberem o estado atual sem causar mismatch de
 * hidratação.
 */
export type Tema = 'claro' | 'escuro';

export const CHAVE_TEMA = 'miner.tema';

type Ctx = { tema: Tema; definir: (t: Tema) => void; alternar: () => void };

const TemaContext = createContext<Ctx | null>(null);

function aplicar(tema: Tema) {
  const c = document.documentElement.classList;
  if (tema === 'escuro') c.add('dark');
  else c.remove('dark');
}

export function ProvedorTema({ children }: { children: React.ReactNode }) {
  /* Nasce lendo a classe que o script inline já pôs — nunca "chuta" escuro e
     corrige depois, o que faria o toggle piscar no primeiro render. */
  const [tema, setTema] = useState<Tema>('escuro');

  useEffect(() => {
    const atual: Tema = document.documentElement.classList.contains('dark') ? 'escuro' : 'claro';
    setTema(atual);
  }, []);

  const definir = useCallback((t: Tema) => {
    setTema(t);
    aplicar(t);
    try {
      localStorage.setItem(CHAVE_TEMA, t);
    } catch {
      /* modo privado / storage bloqueado: o tema ainda funciona na sessão */
    }
  }, []);

  const alternar = useCallback(() => {
    definir(document.documentElement.classList.contains('dark') ? 'claro' : 'escuro');
  }, [definir]);

  /* Sincroniza entre abas: trocar o tema numa aba reflete nas outras. */
  useEffect(() => {
    const aoMudar = (e: StorageEvent) => {
      if (e.key === CHAVE_TEMA && (e.newValue === 'claro' || e.newValue === 'escuro')) {
        setTema(e.newValue);
        aplicar(e.newValue);
      }
    };
    window.addEventListener('storage', aoMudar);
    return () => window.removeEventListener('storage', aoMudar);
  }, []);

  return <TemaContext.Provider value={{ tema, definir, alternar }}>{children}</TemaContext.Provider>;
}

export function useTema(): Ctx {
  const ctx = useContext(TemaContext);
  if (!ctx) throw new Error('useTema precisa estar dentro de <ProvedorTema>');
  return ctx;
}

/**
 * Script que roda ANTES do React, no <head>. Lê a preferência e aplica a classe
 * de forma síncrona, para a página já pintar no tema certo. Padrão: escuro.
 */
export const SCRIPT_ANTI_FOUC = `(function(){try{var t=localStorage.getItem('${CHAVE_TEMA}');var escuro=t?t==='escuro':true;var c=document.documentElement.classList;if(escuro)c.add('dark');else c.remove('dark');}catch(e){document.documentElement.classList.add('dark');}})();`;
