import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type ConferenciaNome } from '@miner/database';

import { PrismaService } from '../../../prisma/prisma.service';
import { escopoGlobal } from '../../../prisma/sentinela-escopo';
import { conferirNome } from './conferencia-de-nome';
import { mapearRespostaContactra } from '../providers/contactra/contactra.mapper';

export interface ResultadoReconferencia {
  simular: boolean;
  analisadas: number;
  /** Tinha veredito, mas o payload guardado já não traz nome com que comparar. */
  semNomeNoPayload: number;
  inalteradas: number;
  alteradas: number;
  /** Quantas mudaram, por transição — é o que se lê antes de aplicar. */
  transicoes: Record<string, number>;
}

/**
 * REFAZ O VEREDITO DO CPF SEM CONSULTAR O PROVEDOR DE NOVO.
 *
 * ── POR QUE ISTO PRECISA EXISTIR ──
 *
 * `Pessoa.conferenciaNome` é dado DERIVADO: sai de `conferirNome(nome da
 * planilha, nome do provedor)`. Quando a regra muda — e ela mudou, ao passar a
 * conferir cada credor de uma célula com vários nomes em separado —, o veredito
 * gravado passa a ser resposta de uma pergunta que ninguém faz mais.
 *
 * Sem esta rotina, corrigir a regra só valeria para consultas FUTURAS, e o
 * único jeito de corrigir o passado seria pagar tudo de novo.
 *
 * ── O QUE TORNA ISSO POSSÍVEL, E DE GRAÇA ──
 *
 * `Enriquecimento.dadosBrutos` guarda a resposta crua do provedor por
 * `RETENCAO_DADOS_BRUTOS_DIAS` (180 por padrão). O nome do titular está lá. A
 * finalidade declarada dessa retenção é exatamente "reprocessar sem o arquivo",
 * e é isso que se faz aqui: zero chamadas ao provedor, zero crédito gasto.
 *
 * ⚠ Depois do corte de retenção o payload vira nulo e a reconferência deixa de
 * alcançar aquela pessoa — em silêncio, porque não há o que reprocessar. Por
 * isso o resultado devolve `semNomeNoPayload` em vez de somar tudo em
 * "inalteradas": as duas coisas parecem iguais no total e significam o oposto.
 *
 * ── POR QUE SÓ QUEM JÁ TEM VEREDITO ──
 *
 * O filtro exclui `NAO_CONFERIDO` de propósito, e a razão é grande: a carteira
 * dos TRFs INTEIRA está nesse estado (medido em 08/09/2026 — amostra de 1.925,
 * zero conferidos), porque foi enriquecida antes de a comparação existir.
 * Alcançá-la aqui daria veredito de uma vez só a 12.425 processos e, com a
 * trava de distribuição em vigor, qualquer DIVERGE novo sumiria do sorteio na
 * mesma madrugada.
 *
 * Isso pode até ser desejável, mas é DECISÃO DE PRODUTO com efeito comercial —
 * não efeito colateral de uma correção de regra. Esta rotina re-deriva o que já
 * foi julgado; estender o julgamento a quem nunca foi é outro pedido.
 */
@Injectable()
export class ReconferenciaService {
  private readonly logger = new Logger(ReconferenciaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reconferir(simular = true): Promise<ResultadoReconferencia> {
    const pessoas = await this.prisma.pessoa.findMany(
      /* Pessoa é global por desenho — a chave natural é o documento, e escopá-la
         partiria a trilha do art. 18. Não há `organizationId` que pudesse
         recortar esta consulta. */
      escopoGlobal('reconferencia: Pessoa e global por CPF, nao tem organizationId', {
        where: {
          conferenciaNome: { in: ['CONFERE', 'DIVERGE'] },
          enriquecimento: { some: { dadosBrutos: { not: Prisma.DbNull } } },
        },
        select: {
          id: true,
          nome: true,
          conferenciaNome: true,
          enriquecimento: {
            where: { dadosBrutos: { not: Prisma.DbNull }, provider: 'CONTACTRA' },
            /* O mais recente: é ele que produziu o veredito em vigor. */
            orderBy: { criadoEm: 'desc' },
            take: 1,
            select: { dadosBrutos: true },
          },
        },
        /* `satisfies` NÃO é enfeite aqui. `escopoGlobal` infere o tipo do
           literal que recebe, e sem tipo de contexto o TypeScript alarga
           `'desc'` para `string` e `'CONFERE'` para `string` — o Prisma recusa,
           e de quebra a inferência do `select` some, levando junto o
           `p.enriquecimento` lá embaixo. Com o `satisfies` o literal é
           contextualizado antes de entrar na função. */
      } satisfies Prisma.PessoaFindManyArgs),
    );

    const novos = new Map<ConferenciaNome, string[]>();
    const transicoes: Record<string, number> = {};
    let semNomeNoPayload = 0;
    let inalteradas = 0;

    for (const p of pessoas) {
      /* O MESMO mapeador que extraiu o nome quando a resposta chegou. Reescrever
         a extração aqui criaria uma segunda leitura do payload, livre para
         divergir da primeira — e a divergência apareceria como veredito que muda
         sozinho, sem ninguém ter mexido na regra. */
      const doProvedor = mapearRespostaContactra(p.enriquecimento[0]?.dadosBrutos)?.nome;
      if (!doProvedor) {
        semNomeNoPayload++;
        continue;
      }

      const veredito = conferirNome(p.nome, doProvedor);
      if (veredito === p.conferenciaNome) {
        inalteradas++;
        continue;
      }

      const chave = `${p.conferenciaNome} -> ${veredito}`;
      transicoes[chave] = (transicoes[chave] ?? 0) + 1;
      novos.set(veredito, [...(novos.get(veredito) ?? []), p.id]);
    }

    const alteradas = [...novos.values()].reduce((n, ids) => n + ids.length, 0);

    if (!simular) {
      /* Um UPDATE por veredito de destino, e não um por pessoa: são no máximo
         dois grupos, e a alternativa seriam centenas de idas ao banco para
         escrever uma coluna. */
      for (const [veredito, ids] of novos) {
        await this.prisma.pessoa.updateMany({
          where: { id: { in: ids } },
          data: { conferenciaNome: veredito },
        });
      }
      this.logger.log(
        `Reconferência aplicada: ${alteradas} de ${pessoas.length} vereditos mudaram ` +
          `(${JSON.stringify(transicoes)}). Nenhuma consulta ao provedor.`,
      );
    }

    return {
      simular,
      analisadas: pessoas.length,
      semNomeNoPayload,
      inalteradas,
      alteradas,
      transicoes,
    };
  }
}
