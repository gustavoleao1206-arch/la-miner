import { cn } from '@/lib/utils';

/**
 * Símbolo LLA — capitel jônico sobre o monograma que forma o escudo.
 *
 * É o arquivo original da Leão Amorim Tecnologia, não um redesenho: extraí o
 * traço do PNG 4K por luminância (o glow radial do fundo foi cortado, a aura
 * agora vem do CSS, que dá controle sobre intensidade e cor). Tentativas
 * anteriores de redesenhar em SVG erravam as volutas do capitel e a largura
 * do "A" — com o asset real, a marca é idêntica à institucional.
 *
 * O gradiente roxo → azul → ciano já vem embutido na arte. Para regerar (ou
 * mudar a paleta), a fonte é:
 *   CRM JURIDICO/Leao-Tecnologia/Simbolo-LLA-Tecnologia-4K-escuro.png
 */
export function SimboloLLA({ className }: { className?: string }) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/marca/simbolo-miner.png"
      alt=""
      aria-hidden="true"
      className={cn('w-auto select-none', className)}
      draggable={false}
    />
  );
}

type Tamanho = 'sm' | 'md' | 'lg';

const dims: Record<Tamanho, { s: string; nome: string; desc: string; gap: string }> = {
  sm: { s: 'h-8', nome: 'text-[13px] tracking-[0.11em]', desc: 'text-[7px] tracking-[0.44em]', gap: 'gap-2.5' },
  md: { s: 'h-11', nome: 'text-[17px] tracking-[0.12em]', desc: 'text-[9px] tracking-[0.48em]', gap: 'gap-3.5' },
  lg: { s: 'h-16', nome: 'text-[26px] tracking-[0.13em]', desc: 'text-[12px] tracking-[0.52em]', gap: 'gap-4' },
};

/**
 * Lockup do produto. Preserva a arquitetura de marca do institucional —
 * nome acima, descritor abaixo em caixa-alta espaçada — trocando TECNOLOGIA
 * por MINER. O descritor usa a mono, que é como "TECNOLOGIA" é composto na
 * marca-mãe e o que dá a leitura técnica.
 */
export function Logo({
  tamanho = 'md',
  className,
  mostrarDescritor = true,
}: {
  tamanho?: Tamanho;
  className?: string;
  mostrarDescritor?: boolean;
}) {
  const d = dims[tamanho];
  return (
    <div className={cn('flex items-center', d.gap, className)}>
      <SimboloLLA className={cn(d.s, 'shrink-0 drop-shadow-[0_0_16px_rgba(99,102,241,.5)]')} />
      <div className="leading-none">
        <div className={cn('font-display font-bold uppercase text-ink', d.nome)}>Leão Amorim</div>
        {mostrarDescritor && (
          /* tracking largo abre um vão à direita da última letra; o -mr compensa */
          <div className={cn('mt-[7px] font-mono font-medium uppercase text-marca-ciano', d.desc)}>
            <span className="-mr-[0.48em] inline-block">Miner</span>
          </div>
        )}
      </div>
    </div>
  );
}
