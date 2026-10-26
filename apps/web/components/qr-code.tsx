'use client';

import { useMemo } from 'react';
import { caminhoSvg, ladoComMargem, matrizQr } from '@/lib/qrcode';

/**
 * Um QR code desenhado em SVG.
 *
 * ── DUAS DECISÕES QUE PARECEM ESTÉTICAS E NÃO SÃO ──
 *
 * 1. FUNDO CLARO SEMPRE, mesmo no tema escuro. Um QR invertido (claro sobre
 *    escuro) é lido por parte dos aplicativos e ignorado por outra parte, e a
 *    pessoa não teria como saber que o problema é esse. A moldura branca fica,
 *    portanto, independente do tema — é o único elemento do painel que não
 *    acompanha o modo escuro, e é de propósito.
 *
 * 2. A ZONA DE SILÊNCIO faz parte do desenho, não da margem CSS. São os quatro
 *    módulos claros que o padrão exige em volta; sem eles o leitor não encontra
 *    a borda do símbolo. Como `padding` do CSS, qualquer ajuste de layout futuro
 *    poderia removê-la sem que nada aparentasse quebrado — até alguém tentar
 *    escanear.
 *
 * Acessibilidade: o `aria-label` NÃO carrega o conteúdo. Quem usa leitor de tela
 * não vai escanear coisa nenhuma; para essa pessoa o caminho é a chave em texto,
 * que a tela de cadastro mostra logo abaixo e que é o alternativo de verdade.
 */
export function QrCode({
  conteudo,
  tamanho = 200,
  rotulo,
}: {
  conteudo: string;
  tamanho?: number;
  rotulo: string;
}) {
  const desenho = useMemo(() => {
    try {
      const matriz = matrizQr(conteudo);
      return { caminho: caminhoSvg(matriz), lado: ladoComMargem(matriz) };
    } catch {
      /* Conteúdo longo demais para o maior símbolo suportado. Devolver nada é o
         certo: a tela continua funcionando pela chave digitada, que é o caminho
         alternativo que já existe. Um erro aqui derrubaria a página inteira e
         tiraria da pessoa também a saída manual. */
      return null;
    }
  }, [conteudo]);

  if (!desenho) return null;

  return (
    <div
      className="inline-flex rounded-xl bg-white p-3 shadow-cartao ring-1 ring-black/10"
      style={{ maxWidth: '100%' }}
    >
      <svg
        role="img"
        aria-label={rotulo}
        viewBox={`0 0 ${desenho.lado} ${desenho.lado}`}
        width={tamanho}
        height={tamanho}
        shapeRendering="crispEdges"
        className="h-auto w-full"
        style={{ maxWidth: tamanho }}
      >
        <rect width={desenho.lado} height={desenho.lado} fill="#ffffff" />
        <path d={desenho.caminho} fill="#0f172a" />
      </svg>
    </div>
  );
}
