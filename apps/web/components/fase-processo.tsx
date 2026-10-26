import { cn, compacto } from '@/lib/utils';

import type { FaseProcesso } from '@/lib/api';

/**
 * O ESTÁGIO DO CRÉDITO, dito na tela.
 *
 * ── POR QUE ISTO EXISTE ──
 *
 * Até 04/09/2026 a carteira era só de precatórios na fila orçamentária, e não
 * havia o que distinguir. Com os pré-precatórios na mesma lista, dois itens de
 * valor parecido podem estar a anos de distância um do outro — e sem um sinal
 * na tela eles ficam idênticos: mesmo número, mesma linha, mesmo formato.
 *
 * A decisão de incluí-los no sorteio dos 250 tornou isto obrigatório, e não
 * cosmético. A landing foi corrigida em 07/09/2026 e passou a vender "250
 * créditos — precatórios expedidos e pré-precatórios", mas isso resolve a
 * promessa, não o ITEM: sem o selo, dois créditos de valor parecido continuam
 * idênticos na tela estando a anos de distância um do outro. Entregar
 * oportunidade ainda não exigível sem dizer qual é qual é o terreno do art. 37,
 * §1º do CDC — e o comprador é advogado, que percebe.
 *
 * ── O QUE A COR DIZ, E O QUE ELA NÃO DIZ ──
 *
 * Só `PRECATORIO_EXPEDIDO` tem exigibilidade formada; ele é o neutro, sem
 * destaque, porque é o esperado. Os demais recebem âmbar — atenção, não erro.
 * Nenhuma fase é ruim: a própria fonte observa que a fase 2 pode valer MAIS que
 * a 4, porque ali o valor já está fixado nos autos e o credor ainda não foi
 * procurado. A cor sinaliza "confira o estágio", nunca "isto presta menos".
 *
 * A cor tampouco é o único canal: o rótulo é texto legível, e o `title` traz a
 * frase inteira. Quem enxerga só o âmbar não fica sem a informação.
 */
const FASES: Record<FaseProcesso, { curto: string; explica: string; exigivel: boolean }> = {
  TRANSITO_EM_JULGADO: {
    curto: 'Trânsito em julgado',
    explica: 'Ganhou e não cabe mais recurso. O valor ainda não foi apurado nos autos.',
    exigivel: false,
  },
  CALCULOS_HOMOLOGADOS: {
    curto: 'Cálculos homologados',
    explica: 'O valor já está fixado nos autos, mas o pagamento ainda não foi requisitado.',
    exigivel: false,
  },
  REQUISITORIO_EXPEDIDO: {
    curto: 'Requisitório expedido',
    explica: 'O juízo requisitou o pagamento ao tribunal. O precatório ainda não foi autuado.',
    exigivel: false,
  },
  PRECATORIO_AUTUADO: {
    curto: 'Precatório autuado',
    explica: 'O tribunal autuou o precatório. Ainda não entrou na fila orçamentária.',
    exigivel: false,
  },
  PRECATORIO_EXPEDIDO: {
    curto: 'Precatório expedido',
    explica: 'Na fila orçamentária do tribunal — o estágio com exigibilidade formada.',
    exigivel: true,
  },
};

/**
 * ESTE CRÉDITO JÁ É EXIGÍVEL?
 *
 * `undefined` quando a fase não é conhecida por este mapa, e a distinção é o
 * ponto: quem agrega precisa poder deixar de fora o que não sabe classificar, em
 * vez de empurrá-lo para um dos dois lados. Um `!FASES[f].exigivel` contaria uma
 * fase nova do enum como "ainda não exigível" sem ninguém ter decidido isso.
 *
 * Existe para o AGREGADO reusar a mesma régua do SELO. Enquanto a base era só
 * precatório expedido, a régua só era necessária no item; com os pré-precatórios
 * na mesma carteira, o dashboard precisa dela também — e duas definições de
 * "isto é exigível" seriam duas que divergem na próxima fase que entrar.
 */
export function faseExigivel(fase: FaseProcesso): boolean | undefined {
  return FASES[fase]?.exigivel;
}

/**
 * O nome e a explicação do estágio, para quem precisa do TEXTO e não do selo.
 *
 * Existe para a folha impressa da proposta: ali não há cor, não há `title` para
 * passar o mouse e não há como voltar e perguntar — é papel, e o titular assina.
 * A explicação por extenso vai impressa ao lado do nome do estágio.
 *
 * `undefined` para fase desconhecida, pela mesma razão de `faseExigivel`: quem
 * chama decide o que fazer com o que não sabe nomear, em vez de receber um
 * rótulo inventado.
 */
export function descricaoDaFase(
  fase: FaseProcesso,
): { curto: string; explica: string } | undefined {
  const f = FASES[fase];
  return f ? { curto: f.curto, explica: f.explica } : undefined;
}

export function SeloFase({ fase, className }: { fase: FaseProcesso; className?: string }) {
  const f = FASES[fase];
  /* Fase desconhecida NÃO é renderizada como "normal": um valor novo no enum do
     banco que o front ainda não conheça apareceria como selo vazio, e vazio
     lê-se como "precatório comum". Melhor mostrar o valor cru. */
  if (!f) {
    return (
      <span className={cn('rounded px-1.5 py-0.5 text-[11px] text-alerta', className)}>{fase}</span>
    );
  }

  return (
    <span
      title={f.explica}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium leading-tight',
        f.exigivel
          ? 'bg-ink/[0.06] text-ink/70'
          : 'bg-alerta/10 text-alerta ring-1 ring-inset ring-alerta/25',
        className,
      )}
    >
      {f.curto}
    </span>
  );
}

/**
 * O valor que veio de texto, e não de campo.
 *
 * A fonte documenta: "NENHUMA fonte pública tem campo de valor. Todo número foi
 * extraído do texto (…) é palpite — pode ser honorário, custas ou valor da
 * causa. Confirme na consulta pública."
 *
 * Mostrar esse número com a mesma cara do valor apurado seria o pior dos dois
 * mundos: o advogado decide a abordagem por ele e descobre depois. O til e o
 * rótulo existem para que a dúvida viaje junto do número.
 */
export function ValorIndicativo({
  valor,
  className,
  compacto: curto = false,
}: {
  valor: string | null;
  className?: string;
  /**
   * "~R$ 1,2 mi" em vez de "~R$ 1.234.567". É a forma de LISTA, onde o olho
   * compara magnitudes descendo a coluna; o número inteiro vai no `title`, e o
   * til e o "estimado" continuam — a dúvida viaja junto do número nas duas formas.
   */
  compacto?: boolean;
}) {
  if (valor === null) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;

  const inteiro = n.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
  const aviso =
    'Valor extraído do texto da publicação — indicativo, não apurado. Confirme na consulta pública do tribunal.';

  return (
    <span
      title={curto ? `${inteiro} · ${aviso}` : aviso}
      className={cn('whitespace-nowrap text-ink/60', className)}
    >
      ~{curto ? `R$ ${compacto(n)}` : inteiro}
      {/* Na forma de lista o rótulo desce para a linha de baixo: ao lado do
          número ele estourava a coluna e encostava na borda do cartão. */}
      <span
        className={cn(
          'text-[10px] uppercase tracking-wide text-alerta',
          curto ? 'mt-0.5 block font-body font-medium' : 'ml-1',
        )}
      >
        estimado
      </span>
    </span>
  );
}

/**
 * ── O AVISO DE CONFERÊNCIA DO CPF FOI REMOVIDO EM 20/09/2026 ──
 *
 * Aqui morava `AvisoConferenciaCpf`, o selo "CPF a conferir" / "CPF não
 * conferido" que aparecia colado ao nome do titular na fila, no quadro, na
 * página do processo e na lista de pré-precatórios. O dono mandou tirá-lo de
 * TODAS as telas, inclusive as da operação interna.
 *
 * ── O QUE NÃO MUDOU, E É O QUE IMPORTA ──
 *
 * O veredito continua sendo apurado no enriquecimento e gravado em
 * `Pessoa.conferenciaNome`. Ele continua com dentes onde decide alguma coisa:
 *
 *   • `DIVERGE` não entra no sorteio (`PROCESSO_DISTRIBUIVEL`);
 *   • pré-precatório `NAO_CONFERIDO` também não, desde 20/09/2026;
 *   • a operação interna filtra por veredito na tela de pré-precatórios, e só
 *     ela — o assinante nem recebe a contagem (ver `resumoDaFila`).
 *
 * Ou seja: o que o selo avisava virou regra, em vez de texto na tela. Quem
 * quiser ressuscitá-lo acha o componente inteiro, com o raciocínio dos dois
 * pesos, em `git log -S AvisoConferenciaCpf`.
 */
