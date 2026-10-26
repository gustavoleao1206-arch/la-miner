'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface UsuarioAtual {
  id: string;
  email: string;
  papel: 'ADMIN' | 'OPERADOR' | 'CLIENTE';
  organizationId: string;
  tipo: 'INTERNA' | 'CLIENTE';
  /** Administra a própria organização (convida colegas, ativa/desativa acesso). */
  gestor: boolean;
}

interface Contexto {
  usuario: UsuarioAtual | null;
  /** A org de quem olha é assinante (não a operação Leão Amorim). */
  ehCliente: boolean;
  /** Pode administrar a equipe da própria organização. */
  podeGerirEquipe: boolean;
  /**
   * Pode registrar que uma parcela foi paga ao titular.
   *
   * Hoje a expressão é IDÊNTICA à de `podeGerirEquipe`, e é de propósito que
   * são dois campos: as perguntas são diferentes — uma é sobre administrar
   * pessoas, a outra sobre confirmar saída de dinheiro. Se um dia o dono
   * quiser um financeiro que dá baixa sem mexer na equipe, muda-se só esta
   * linha. Fundir as duas agora economiza uma linha e cobra a fatura no dia
   * em que elas divergirem.
   */
  podeDarBaixa: boolean;
  /** Já sabemos QUEM é? Antes disso não dá para decidir o que buscar. */
  carregado: boolean;
}

const Ctx = createContext<Contexto>({
  usuario: null,
  ehCliente: false,
  podeGerirEquipe: false,
  podeDarBaixa: false,
  carregado: false,
});

/**
 * Quem está logado, resolvido UMA vez para o painel inteiro.
 *
 * `ehCliente` sai do TIPO DA ORG, não do papel. São perguntas diferentes: a org
 * decide o que a pessoa VÊ (a base inteira ou só a carteira liberada); o papel
 * decide o que ela pode FAZER dentro do próprio tenant. Confundir os dois é como
 * se abre a porta errada no dia em que existir um "admin do cliente" — ele teria
 * papel ADMIN e ainda assim não pode ver a base alheia.
 *
 * `carregado` existe para o dashboard não disparar as consultas administrativas
 * no intervalo entre montar e saber quem é: sem ele, todo cliente começaria a
 * sessão com uma salva de 403 no console.
 */
export function ProvedorUsuario({ children }: { children: React.ReactNode }) {
  const [usuario, setUsuario] = useState<UsuarioAtual | null>(null);
  const [carregado, setCarregado] = useState(false);

  useEffect(() => {
    let vivo = true;
    api<UsuarioAtual>('/auth/eu')
      .then((u) => {
        if (vivo) setUsuario(u);
      })
      .catch(() => undefined) // falha silenciosa: a interface funciona, só sem o nome
      .finally(() => {
        if (vivo) setCarregado(true);
      });
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <Ctx.Provider
      value={{
        /* Espelha o `ehEscopoCliente` do backend: o mais restritivo dos dois
           sinais. Um papel CLIENTE dentro da org interna (config legada) também
           não pode ver menu administrativo — a API já o trata como cliente, e a
           tela precisa concordar, ou ele veria itens que respondem 403. */
        usuario,
        ehCliente: usuario?.tipo === 'CLIENTE' || usuario?.papel === 'CLIENTE',
        /* Espelha o `podeGerenciarEquipe` do backend. Como sempre, a trava real é
           lá; aqui é só para não oferecer um menu que responderia 403. */
        podeGerirEquipe: usuario?.papel === 'ADMIN' || usuario?.gestor === true,
        /* Espelha o `exigirGestorOuAdmin` do serviço de negociação. A trava real
           é lá — aqui só decidimos se vale a pena desenhar o botão. */
        podeDarBaixa: usuario?.papel === 'ADMIN' || usuario?.gestor === true,
        carregado,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useUsuario = () => useContext(Ctx);
