import type { Job } from 'bullmq';

import { EnriquecimentoProcessor } from './enriquecimento.processor';

/**
 * A VAGA DE DEDUPLICAÇÃO, DEVOLVIDA POR QUEM NÃO GASTOU.
 *
 * ── O DEFEITO QUE ESTES CASOS TRANCAM ──
 *
 * O `jobId` é `enr-<pessoaId>-<dia>` e serve a uma coisa só: impedir que a mesma
 * pessoa seja PAGA duas vezes no mesmo dia. Jobs concluídos ficam no Redis por
 * 24h, então o id continua ocupado depois de rodar.
 *
 * Com `SYNC_DRY_RUN=true` isso virava armadilha: o job concluía sem tocar no
 * provedor, sem gastar um centavo — e ainda assim segurava a vaga. Ligar o modo
 * real no mesmo dia não adiantava: o `add` reencontrava o id, o Redis o ignorava
 * em silêncio, e a API respondia "N enfileiradas" porque conta o que TENTOU
 * enviar.
 *
 * Aconteceu em 06/09/2026: 1.137 pré-precatórios importados enfileiraram 1.137
 * jobs que rodaram em dry-run; a rodada real logo depois foi engolida inteira,
 * com os contadores parados em zero e nenhum erro em lugar nenhum.
 *
 * ── O QUE ESTES CASOS FIXAM ──
 *
 * Que a devolução é decidida pelo RESULTADO do job, e que ela alcança o
 * `DRY_RUN` e mais nada. Cada um dos outros retornos precoces mantém a vaga por
 * um motivo próprio, e trocar isso por um "não gastou, então libera" genérico
 * reabriria caminhos que existem para ficar fechados.
 */
describe('EnriquecimentoProcessor — a vaga de deduplicação', () => {
  /** As quatro dependências não são tocadas por `aoCompletar`. */
  function processor() {
    return new EnriquecimentoProcessor(
      {} as never,
      { get: (_c: string, padrao?: unknown) => padrao } as never,
      { nome: 'CONTACTRA' } as never,
      {} as never,
    );
  }

  /** Um job que registra se foi removido. */
  function jobFalso(erroAoRemover?: string) {
    const estado = { removido: 0 };
    const job = {
      id: 'enr-abc-2026-09-06',
      remove: async () => {
        estado.removido += 1;
        if (erroAoRemover) throw new Error(erroAoRemover);
      },
    } as unknown as Job;
    return { job, estado };
  }

  it('⚠ DRY_RUN devolve a vaga — ele não pagou nada', async () => {
    const { job, estado } = jobFalso();

    await processor().aoCompletar(job, { status: 'DRY_RUN' });

    expect(estado.removido).toBe(1);
  });

  it('⚠ SUCESSO MANTÉM a vaga — aqui houve consulta cobrada', async () => {
    /* O caso que impede a correção de virar o defeito oposto. Liberar aqui
       deixaria a mesma pessoa ser paga de novo no mesmo dia, que é exatamente o
       que o `jobId` existe para impedir. */
    const { job, estado } = jobFalso();

    await processor().aoCompletar(job, { status: 'SUCESSO' });

    expect(estado.removido).toBe(0);
  });

  it('SEM_DADOS mantém a vaga — a Contactra cobra por consultar, não por achar', async () => {
    const { job, estado } = jobFalso();

    await processor().aoCompletar(job, { status: 'SEM_DADOS' });

    expect(estado.removido).toBe(0);
  });

  it('TITULAR_EXCLUIDO mantém a vaga, e isso é deliberado', async () => {
    /* Não gastou nada, e mesmo assim fica. Repetir seria ir buscar telefone e
       endereço de quem acabou de mandar apagar — a vaga ocupada é uma proteção,
       não um resto. */
    const { job, estado } = jobFalso();

    await processor().aoCompletar(job, { status: 'TITULAR_EXCLUIDO' });

    expect(estado.removido).toBe(0);
  });

  it('JA_SINCRONIZADO_HOJE e PESSOA_INEXISTENTE mantêm a vaga', async () => {
    for (const status of ['JA_SINCRONIZADO_HOJE', 'PESSOA_INEXISTENTE']) {
      const { job, estado } = jobFalso();
      await processor().aoCompletar(job, { status });
      expect(estado.removido).toBe(0);
    }
  });

  it('resultado ausente não derruba nada', async () => {
    /* O tipo do evento não garante corpo: um job antigo, de uma versão que
       devolvia outra coisa, chegaria aqui como `undefined`. */
    const { job, estado } = jobFalso();

    await expect(processor().aoCompletar(job, undefined)).resolves.toBeUndefined();
    expect(estado.removido).toBe(0);
  });

  it('⚠ falha ao remover NÃO propaga — o pior caso é voltar ao comportamento antigo', async () => {
    /* `job.remove()` recusa se o job estiver travado, e o Redis pode estar fora.
       Deixar a exceção subir mataria o processamento por causa da FAXINA, que é
       a parte menos importante do trabalho. */
    const { job, estado } = jobFalso('Could not remove job: it is locked');

    await expect(processor().aoCompletar(job, { status: 'DRY_RUN' })).resolves.toBeUndefined();
    expect(estado.removido).toBe(1);
  });
});
