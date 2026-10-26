import { FilaService } from './fila.service';

/**
 * O `jobId` que o BullMQ ACEITA.
 *
 * ── POR QUE ESTE TESTE EXISTE ──
 *
 * `jobId: 'importacao:<uuid>'` derrubava toda importação com um 503. O BullMQ
 * recusa id customizado com `:` — exceto quando ele parte em exatamente três
 * pedaços, uma compatibilidade com jobs repetíveis que o TODO deles diz que vai
 * sair. Dois pedaços estouram: "Custom Id cannot contain :".
 *
 * Nenhum teste pegava isso. Os de integração usam um dublê de fila, que aceita
 * qualquer coisa; a validação mora dentro do BullMQ de verdade. Foi preciso
 * clicar no navegador para descobrir — e é exatamente por isso que a regra vira
 * asserção aqui: o dublê continua não validando, mas a FORMA do id passa a ter
 * um guarda.
 *
 * A regra do BullMQ está reproduzida abaixo, e não importada: importar a
 * validação deles faria o teste passar por construção, provando só que o código
 * é igual a si mesmo.
 */
function bullMqAceitaria(jobId: string): boolean {
  return !jobId.includes(':') || jobId.split(':').length === 3;
}

/** Um Queue mínimo que só registra o que recebeu. */
function filaEspia() {
  const chamadas: { nome: string; dados: unknown; opts?: { jobId?: string } }[] = [];
  return {
    chamadas,
    add: async (nome: string, dados: unknown, opts?: { jobId?: string }) => {
      chamadas.push({ nome, dados, opts });
      return { id: opts?.jobId ?? '1' };
    },
    addBulk: async (jobs: { name: string; data: unknown; opts?: { jobId?: string } }[]) => {
      jobs.forEach((j) => chamadas.push({ nome: j.name, dados: j.data, opts: j.opts }));
      return jobs.map((_, i) => ({ id: String(i) }));
    },
  };
}

describe('FilaService — a forma do jobId', () => {
  it('a importação não usa dois-pontos, e o BullMQ aceitaria o id', async () => {
    const espia = filaEspia();
    const servico = new FilaService(espia as never, espia as never, {} as never);

    await servico.enfileirarImportacao('a1b2c3d4-0000-4000-8000-000000000000');

    const { opts, dados } = espia.chamadas[0];
    expect(opts?.jobId).toBe('importacao-a1b2c3d4-0000-4000-8000-000000000000');
    expect(opts?.jobId).not.toContain(':');
    expect(bullMqAceitaria(opts!.jobId!)).toBe(true);
    /* O job carrega SÓ o id: tudo o mais o worker relê do banco, para uma
       retentativa depois de um deploy não rodar com a forma antiga do dado — e
       para CPF e nome não irem parar no Redis, fora do alcance da exclusão do
       titular. */
    expect(dados).toEqual({ importacaoId: 'a1b2c3d4-0000-4000-8000-000000000000' });
  });

  it('o mesmo id de importação gera o MESMO jobId — clique duplo não processa duas vezes', async () => {
    const espia = filaEspia();
    const servico = new FilaService(espia as never, espia as never, {} as never);

    await servico.enfileirarImportacao('mesma-importacao');
    await servico.enfileirarImportacao('mesma-importacao');

    expect(espia.chamadas[0].opts?.jobId).toBe(espia.chamadas[1].opts?.jobId);
  });

  it('o jobId do enriquecimento também passa pela regra do BullMQ', async () => {
    const espia = filaEspia();
    const servico = new FilaService(espia as never, espia as never, {} as never);

    await servico.enfileirarLote([{ pessoaId: 'p1' }], 'importacao');

    const jobId = espia.chamadas[0].opts?.jobId ?? '';
    /* Agora sem `:` nenhum, como a importação — não depende mais da
       compatibilidade de três pedaços que o BullMQ marca para remover. */
    expect(jobId).not.toContain(':');
    expect(bullMqAceitaria(jobId)).toBe(true);
  });

  /**
   * ── A INVARIANTE QUE ESTE ARQUIVO EXISTE PARA DEFENDER ──
   *
   * O `jobId` vira CHAVE no Redis, e chave é listável sem ler valor: um
   * `KEYS *`, uma tela de monitoramento ou um dump de memória expunha CPF em
   * claro. O corpo do job tinha o mesmo CPF de novo.
   *
   * O caso montado é o realista: um chamador que AINDA passa o `cpf` junto —
   * porque o tipo dele não mudou, ou porque alguém o repôs "para evitar uma ida
   * ao banco". O serviço monta a carga campo a campo, e não por espalhamento,
   * então o CPF morre aqui. Esta asserção é o que impede que um espalhamento
   * inocente reabra o buraco.
   */
  it('nem a chave nem a carga do job carregam o CPF', async () => {
    const espia = filaEspia();
    const servico = new FilaService(espia as never, espia as never, {} as never);
    const CPF = '52998224725';

    await servico.enfileirarLote([{ pessoaId: 'p1', cpf: CPF } as never], 'importacao');

    expect(JSON.stringify(espia.chamadas)).not.toContain(CPF);
    expect(espia.chamadas[0].dados).toEqual({ pessoaId: 'p1', origem: 'importacao' });
    expect(espia.chamadas[0].opts?.jobId).toContain('p1');
  });

  it('duas pessoas distintas geram jobIds distintos, e a mesma pessoa colapsa', async () => {
    const espia = filaEspia();
    const servico = new FilaService(espia as never, espia as never, {} as never);

    await servico.enfileirarLote([{ pessoaId: 'p1' }, { pessoaId: 'p2' }, { pessoaId: 'p1' }]);

    /* `Pessoa.cpf` é único, então deduplicar por pessoa é exatamente deduplicar
       por CPF: a idempotência diária não mudou ao trocar a chave. */
    expect(espia.chamadas).toHaveLength(2);
    expect(espia.chamadas[0].opts?.jobId).not.toBe(espia.chamadas[1].opts?.jobId);
  });
});
