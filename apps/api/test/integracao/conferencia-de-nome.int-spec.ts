import { EnriquecimentoProcessor } from '../../src/modules/fila/enriquecimento.processor';
import { prisma, limparDados, encerrar } from './ambiente';

/**
 * A CONFERÊNCIA DO CPF, ponta a ponta.
 *
 * ── O QUE ELA RESOLVE ──
 *
 * Nos pré-precatórios o CPF é extraído do TEXTO da publicação. Dígito
 * verificador válido prova que o número é bem formado, não que ele seja daquele
 * credor — e a própria fonte avisa que "documento errado ao lado de um nome é
 * pior que documento nenhum".
 *
 * O enriquecimento já resolvia isso e jogava fora: a Contactra devolve o nome de
 * quem realmente tem o CPF, e o processor recebia esse nome sem usá-lo. A
 * comparação custa zero — a consulta já é paga.
 *
 * O motor da comparação tem spec própria (`conferencia-de-nome.spec.ts`, 14
 * casos). O que estes casos defendem é o CICLO: que o veredito chega ao banco, e
 * que o nome da planilha sobrevive.
 */
describe('Conferência do CPF pelo nome', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /** Um provedor que devolve o nome que o caso quiser. */
  function provedorQueDevolve(nome: string | undefined) {
    return {
      nome: 'CONTACTRA',
      consultarPorCpf: async () => ({
        status: 'SUCESSO' as const,
        pessoa: {
          nome,
          telefones: [{ ddd: '81', numero: '999998888' as string }],
          emails: [],
          enderecos: [],
        },
        custoCreditos: 0.2,
      }),
    };
  }

  function processorCom(nomeDoProvedor: string | undefined) {
    return new EnriquecimentoProcessor(
      prisma as never,
      { get: (_c: string, padrao?: unknown) => padrao } as never,
      provedorQueDevolve(nomeDoProvedor) as never,
      { garantirDisponibilidade: async () => undefined } as never,
    );
  }

  async function pessoaChamada(nome: string) {
    return prisma.pessoa.create({
      data: { cpf: '52998224725', nome, nomeNormalizado: nome },
      select: { id: true },
    });
  }

  const estado = (id: string) =>
    prisma.pessoa.findUniqueOrThrow({
      where: { id },
      select: { conferenciaNome: true, nome: true },
    });

  it('nasce NAO_CONFERIDO — ninguém conferiu ainda, e isso é a verdade', async () => {
    /* Ao contrário de `Processo.fase`, aqui o default FICA. A diferença é o que
       a ausência significa: fase ausente seria palpite sobre o que o crédito É;
       conferência ausente é fato. */
    const p = await pessoaChamada('MARIA DE SOUZA');
    expect((await estado(p.id)).conferenciaNome).toBe('NAO_CONFERIDO');
  });

  it('nome do provedor bate → CONFERE', async () => {
    const p = await pessoaChamada('MARIA DE SOUZA SANTOS');

    await processorCom('Maria de Souza Santos').process({
      data: { pessoaId: p.id },
      id: 'j1',
    } as never);

    expect((await estado(p.id)).conferenciaNome).toBe('CONFERE');
  });

  it('nome do provedor é de OUTRA pessoa → DIVERGE', async () => {
    /* É o caso que a conferência existe para pegar: o CPF colhido do mesmo
       despacho, pertencente a outro credor do polo ativo. */
    const p = await pessoaChamada('JOAO PEREIRA SILVA');

    await processorCom('MARIA SANTOS COSTA').process({
      data: { pessoaId: p.id },
      id: 'j2',
    } as never);

    expect((await estado(p.id)).conferenciaNome).toBe('DIVERGE');
  });

  it('⚠ o nome da PLANILHA sobrevive ao enriquecimento', async () => {
    /**
     * A asserção que sustenta as outras.
     *
     * Se o enriquecimento sobrescrevesse `Pessoa.nome` com o do provedor, a
     * evidência que permite a comparação desapareceria — e na execução seguinte
     * TUDO passaria a conferir, inclusive o que não confere. A conferência viraria
     * um carimbo que sempre diz sim.
     */
    const p = await pessoaChamada('JOAO PEREIRA SILVA');

    await processorCom('MARIA SANTOS COSTA').process({
      data: { pessoaId: p.id },
      id: 'j3',
    } as never);

    expect((await estado(p.id)).nome).toBe('JOAO PEREIRA SILVA');

    /* E rodar de novo continua acusando — não "aprende" a aceitar. */
    await prisma.enriquecimento.deleteMany({ where: { pessoaId: p.id } });
    await processorCom('MARIA SANTOS COSTA').process({
      data: { pessoaId: p.id },
      id: 'j4',
    } as never);
    expect((await estado(p.id)).conferenciaNome).toBe('DIVERGE');
  });

  it('provedor sem nome não muda o veredito — ausência não é evidência', async () => {
    /* A Contactra nem sempre devolve nome. Marcar DIVERGE aí acusaria o inocente;
       marcar CONFERE afirmaria o que ninguém verificou. O estado anterior fica. */
    const p = await pessoaChamada('MARIA DE SOUZA');

    await processorCom(undefined).process({ data: { pessoaId: p.id }, id: 'j5' } as never);

    expect((await estado(p.id)).conferenciaNome).toBe('NAO_CONFERIDO');
  });
});
