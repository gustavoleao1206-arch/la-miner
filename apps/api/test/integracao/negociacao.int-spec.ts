import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { FaseProcesso } from '@miner/database';
import { NegociacaoService } from '../../src/modules/negociacao/negociacao.service';
import {
  prisma,

  observador,
  limparDados,
  semearOrganizacao,
  semearCliente,
  semearProcesso,
  liberarProcesso,
  encerrar,
} from './ambiente';

const negociacao = new NegociacaoService(prisma as never);

/** Um processo com partes de valor conhecido — a base sai da SOMA delas. */
async function processoComPartes(
  organizationId: string,
  valores: (number | null)[],
  /* Sem isto nenhum caso conseguia produzir a folha de um PRÉ-precatório — que é
     exatamente o documento em que o rótulo antigo mentia. */
  opcoes?: { fase?: FaseProcesso; exercicio?: number | null },
) {
  const processo = await semearProcesso({
    organizationId,
    valor: valores[0] ?? null,
    ...opcoes,
  });
  for (const [i, v] of valores.entries()) {
    const pessoa = await prisma.pessoa.create({
      data: {
        cpf: `${Date.now()}${i}`.slice(-11),
        nome: `TITULAR ${i}`,
        nomeNormalizado: `TITULAR ${i}`,
      },
      select: { id: true },
    });
    await prisma.processoPessoa.create({
      data: { processoId: processo.id, pessoaId: pessoa.id, valorIndividual: v },
    });
  }
  return processo;
}

describe('Negociação — rodadas e dinheiro do negócio', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('a base sai da SOMA das partes, e diz de onde veio', async () => {
    /**
     * `Processo.valor` PARECE o total do precatório mas é alimentado pela mesma
     * célula que alimenta `valorIndividual` (ver timeline-processo.ts). Num
     * processo com mais de uma parte, usá-lo erraria a base por ordem de
     * grandeza — e o deságio sairia errado no papel entregue ao titular.
     */
    const { org, autor } = await semearOrganizacao();
    const uma = await processoComPartes(org.id, [500000]);
    const tres = await processoComPartes(org.id, [500000, 300000, 200000]);

    const p1 = await negociacao.criar(uma.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '350000.00',
    });
    const p2 = await negociacao.criar(tres.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '700000.00',
    });

    expect(p1.baseValor).toBe('500000');
    expect(p1.baseOrigem).toBe('PARTE_UNICA');
    expect(p2.baseValor).toBe('1000000');
    expect(p2.baseOrigem).toBe('SOMA_DAS_PARTES');
  });

  it('o deságio é CALCULADO, e some quando não há base', async () => {
    const { org, autor } = await semearOrganizacao();
    const comBase = await processoComPartes(org.id, [500000]);
    const semBase = await processoComPartes(org.id, [null]);

    const a = await negociacao.criar(comBase.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '350000.00',
    });
    const b = await negociacao.criar(semBase.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '350000.00',
    });

    expect(a.desagioPercentual).toBe('30');
    /* NULO, e não 100%: a diferença entre "não sei a margem" e "a margem é
       total" é o que separa um campo vazio de uma mentira na tela do sócio. */
    expect(b.desagioPercentual).toBeNull();
    expect(b.baseValor).toBeNull();
  });

  it('a base fica CONGELADA: reimportar o valor não reescreve a proposta antiga', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [500000]);
    const antes = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '350000.00',
    });

    /* A reimportação corrige o valor da parte de 500 mil para 620 mil. */
    await prisma.processoPessoa.updateMany({
      where: { processoId: processo.id },
      data: { valorIndividual: 620000 },
    });

    const r = await negociacao.resumo(processo.id, autor);

    expect(r.rodadas[0].baseValor).toBe('500000');
    expect(r.rodadas[0].desagioPercentual).toBe(antes.desagioPercentual);
    /* E a tela consegue AVISAR que mudou, porque recebe a base atual junto. */
    expect(r.baseAtual).toBe('620000');
  });

  it('ajustar uma proposta APRESENTADA cria a rodada seguinte, sem apagar a anterior', async () => {
    /**
     * É a razão de a tabela guardar rodadas em vez de um campo de valor: a
     * contraproposta do titular é o número que explica onde se chegou.
     */
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);

    const r1 = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });
    await negociacao.enviar(processo.id, r1.id, autor);

    /* O titular pediu mais: entra como contraproposta DELE. */
    const r2 = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      origem: 'TITULAR',
      valorProposto: '400000.00',
    });

    const r = await negociacao.resumo(processo.id, autor);
    expect(r.rodadas).toHaveLength(2);
    expect(r.rodadas[0].rodada).toBe(2);
    expect(r.rodadas[0].origem).toBe('TITULAR');
    expect(r.rodadas[1].status).toBe('SUBSTITUIDA');
    /* O número de onde se saiu continua lá. */
    expect(r.rodadas[1].valorProposto).toBe('300000');
    expect(r.viva?.id).toBe(r2.id);
  });

  it('rascunho abandonado NÃO vira histórico', async () => {
    /* Guardar rascunhos encheria a linha do tempo de números que ninguém
       chegou a ver — e o histórico existe para contar a negociação de verdade. */
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);

    await negociacao.criar(processo.id, autor, { modalidade: 'CESSAO', valorProposto: '100000.00' });
    await negociacao.criar(processo.id, autor, { modalidade: 'CESSAO', valorProposto: '200000.00' });

    const r = await negociacao.resumo(processo.id, autor);
    expect(r.rodadas).toHaveLength(1);
    expect(r.rodadas[0].valorProposto).toBe('200000');
  });

  it('proposta apresentada não se edita — 409, e não 400', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });

    await negociacao.ajustar(processo.id, p.id, autor, { valorProposto: '310000.00' });
    await negociacao.enviar(processo.id, p.id, autor);

    /* 409 porque o pedido está bem formado e o ESTADO é que não permite: a tela
       precisa dizer "crie a rodada seguinte", não "dados inválidos". */
    await expect(
      negociacao.ajustar(processo.id, p.id, autor, { valorProposto: '320000.00' }),
    ).rejects.toThrow(ConflictException);
  });

  it('apresentar move o funil para PROPOSTA, e o evento NÃO carrega o valor', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });

    await negociacao.enviar(processo.id, p.id, autor);

    const overlay = await prisma.carteiraProcesso.findUniqueOrThrow({
      where: { organizationId_processoId: { organizationId: org.id, processoId: processo.id } },
    });
    expect(overlay.estagio).toBe('PROPOSTA');

    /* EventoProcesso é append-only e não se apaga a pedido do titular:
       registrar "proposta de R$ 300 mil" deixaria para sempre quanto foi
       oferecido a uma pessoa identificável. */
    const eventos = await observador.eventoProcesso.findMany({ where: { processoId: processo.id } });
    const cru = JSON.stringify(eventos);
    expect(cru).toContain('Proposta apresentada');
    expect(cru).not.toContain('300000');
    expect(cru).not.toMatch(/R\$/);
  });

  it('aceitar fecha o funil; recusar NÃO mexe no estágio', async () => {
    const { org, autor } = await semearOrganizacao();
    const aceito = await processoComPartes(org.id, [1000000]);
    const recusado = await processoComPartes(org.id, [1000000]);

    for (const p of [aceito, recusado]) {
      const r = await negociacao.criar(p.id, autor, {
        modalidade: 'CESSAO',
        valorProposto: '300000.00',
      });
      await negociacao.enviar(p.id, r.id, autor);
    }

    const vivaA = (await negociacao.resumo(aceito.id, autor)).viva!;
    const vivaR = (await negociacao.resumo(recusado.id, autor)).viva!;
    await negociacao.decidir(aceito.id, vivaA.id, autor, 'ACEITA');
    await negociacao.decidir(recusado.id, vivaR.id, autor, 'RECUSADA');

    const estagio = async (id: string) =>
      (
        await prisma.carteiraProcesso.findUniqueOrThrow({
          where: { organizationId_processoId: { organizationId: org.id, processoId: id } },
        })
      ).estagio;

    expect(await estagio(aceito.id)).toBe('FECHADO');
    /* Recusar uma proposta não encerra a negociação: mandar para PERDIDO aqui
       tiraria da mesa um titular que talvez aceite a rodada seguinte. */
    expect(await estagio(recusado.id)).toBe('PROPOSTA');
  });

  it('cessão pede quantia; honorários pedem percentual — e um exclui o outro', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);

    await expect(
      negociacao.criar(processo.id, autor, {
        modalidade: 'CESSAO',
        honorarioPercentual: '20.00',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      negociacao.criar(processo.id, autor, {
        modalidade: 'HONORARIOS',
        valorProposto: '300000.00',
      }),
    ).rejects.toThrow(BadRequestException);

    /* E não se apresenta uma cessão sem dizer quanto se ofereceu. */
    const vazia = await negociacao.criar(processo.id, autor, { modalidade: 'CESSAO' });
    await expect(negociacao.enviar(processo.id, vazia.id, autor)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('o líquido ao titular desconta as custas SÓ quando são dele', async () => {
    const { org, autor } = await semearOrganizacao();
    const doEscritorio = await processoComPartes(org.id, [1000000]);
    const doTitular = await processoComPartes(org.id, [1000000]);

    const a = await negociacao.criar(doEscritorio.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
      custasEstimadas: '5000.00',
      custasPorContaDe: 'ESCRITORIO',
    });
    const b = await negociacao.criar(doTitular.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
      custasEstimadas: '5000.00',
      custasPorContaDe: 'TITULAR',
    });

    expect(a.liquidoAoTitular).toBe('300000');
    expect(b.liquidoAoTitular).toBe('295000');
  });

  it('dinheiro sai como TEXTO, com os centavos intactos', async () => {
    /* `number` em JSON é float: centavo em conta encadeada não sobrevive, e a
       conta encadeada aqui é o deságio. */
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [4018773.35]);

    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '2811141.34',
    });

    expect(typeof p.valorProposto).toBe('string');
    expect(p.baseValor).toBe('4018773.35');
    expect(p.valorProposto).toBe('2811141.34');
  });
});

describe('Parcelamento da cessão', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /** Um rascunho de cessão de R$ 300.000,00, pronto para receber cronograma. */
  async function comRascunho(gestor = true) {
    const { org, autor, user } = await semearOrganizacao();
    /* O ADMIN do fixture já passa pela trava; para provar a RECUSA é preciso um
       usuário que não seja nem ADMIN nem gestor. */
    await prisma.user.update({ where: { id: user.id }, data: { gestor } });
    const processo = await processoComPartes(org.id, [1000000]);
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });
    return { org, autor, user, processo, propostaId: p.id };
  }

  async function comContratoFechado() {
    const r = await comRascunho();
    await negociacao.enviar(r.processo.id, r.propostaId, r.autor);
    await negociacao.decidir(r.processo.id, r.propostaId, r.autor, 'ACEITA');
    return r;
  }

  it('o cronograma nasce JÁ NO RASCUNHO, e a soma fecha no centavo', async () => {
    /* Decisão do dono: "recebo em 6 vezes" é parte do que o titular aceita, e as
       parcelas saem impressas na folha que ele assina. */
    const { autor, processo, propostaId } = await comRascunho();

    const c = await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      entrada: '50000.00',
      parcelas: 6,
      primeiroVencimento: '2026-09-10',
    });

    expect(c.parcelas).toHaveLength(7);
    expect(c.parcelas[0]).toMatchObject({ numero: 0, entrada: true, valor: '50000.00' });
    expect(c.total).toBe('300000.00');
  });

  it('refazer o cronograma substitui, e não acumula', async () => {
    const { autor, processo, propostaId } = await comRascunho();

    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 6,
      primeiroVencimento: '2026-09-10',
    });
    const c = await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 3,
      primeiroVencimento: '2026-10-05',
    });

    expect(c.parcelas).toHaveLength(3);
    expect(c.total).toBe('300000.00');
    expect(await observador.parcelaCessao.count({ where: { propostaId } })).toBe(3);
  });

  it('em HONORÁRIOS não se parcela, e a recusa explica por quê', async () => {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'HONORARIOS',
      honorarioPercentual: '20.00',
    });

    await expect(
      negociacao.gerarCronograma(processo.id, p.id, autor, {
        parcelas: 3,
        primeiroVencimento: '2026-09-10',
      }),
    ).rejects.toThrow(/projeção disfarçada de dívida/);
  });

  it('só GESTOR ou ADMIN registra que o dinheiro saiu', async () => {
    /**
     * Decisão do dono. E "gestor" aqui não é papel: é uma marca no usuário que
     * convive com o papel CLIENTE — um escritório cliente tem gestor e não tem
     * ADMIN. Por isso a trava mora no serviço, e não num @Papeis.
     */
    const { autor, user, processo, propostaId } = await comContratoFechado();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 2,
      primeiroVencimento: '2026-09-10',
    });

    /* Tira a marca de gestor E o papel de ADMIN: sobra um operador comum. */
    await prisma.user.update({ where: { id: user.id }, data: { gestor: false } });
    const comum = { ...autor, papel: 'OPERADOR' as const };

    await expect(negociacao.baixar(processo.id, propostaId, 1, comum)).rejects.toThrow(
      ForbiddenException,
    );

    /* Devolvida a marca, o mesmo usuário passa. */
    await prisma.user.update({ where: { id: user.id }, data: { gestor: true } });
    await expect(negociacao.baixar(processo.id, propostaId, 1, comum)).resolves.toMatchObject({
      alterado: true,
    });
  });

  it('a baixa é idempotente e NÃO reescreve a data da primeira', async () => {
    /* O duplo clique moveria a data do pagamento para o instante do segundo
       clique — e a data do pagamento é o que vale numa conferência. */
    const { autor, processo, propostaId } = await comContratoFechado();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 2,
      primeiroVencimento: '2026-09-10',
    });

    const primeira = await negociacao.baixar(processo.id, propostaId, 1, autor);
    const quando = primeira.parcelas.find((p) => p.numero === 1)!.pagoEm;

    const segunda = await negociacao.baixar(processo.id, propostaId, 1, autor);

    expect(primeira.alterado).toBe(true);
    expect(segunda.alterado).toBe(false);
    expect(segunda.parcelas.find((p) => p.numero === 1)!.pagoEm).toEqual(quando);
  });

  it('desfazer a baixa devolve a parcela ao aberto', async () => {
    const { autor, processo, propostaId } = await comContratoFechado();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 2,
      primeiroVencimento: '2026-09-10',
    });
    await negociacao.baixar(processo.id, propostaId, 1, autor);

    const r = await negociacao.desfazerBaixa(processo.id, propostaId, 1, autor);

    expect(r.alterado).toBe(true);
    expect(r.parcelas.find((p) => p.numero === 1)!.pagoEm).toBeNull();
  });

  it('não se dá baixa antes de o contrato estar fechado', async () => {
    const { autor, processo, propostaId } = await comRascunho();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 2,
      primeiroVencimento: '2026-09-10',
    });

    await expect(negociacao.baixar(processo.id, propostaId, 1, autor)).rejects.toThrow(
      ConflictException,
    );
  });

  it('depois que uma parcela é paga, o cronograma CONGELA', async () => {
    /* Nem refazer, nem apagar: dinheiro que saiu não se reescreve. */
    const { autor, processo, propostaId } = await comContratoFechado();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 3,
      primeiroVencimento: '2026-09-10',
    });
    await negociacao.baixar(processo.id, propostaId, 1, autor);

    await expect(
      negociacao.gerarCronograma(processo.id, propostaId, autor, {
        parcelas: 5,
        primeiroVencimento: '2026-10-10',
      }),
    ).rejects.toThrow(/já foi paga/);
    await expect(negociacao.removerCronograma(processo.id, propostaId, autor)).rejects.toThrow(
      /já foi paga/,
    );
  });

  it('"vencida" é calculada na leitura, e não dispara nada', async () => {
    const { autor, processo, propostaId } = await comContratoFechado();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 2,
      primeiroVencimento: '2020-01-10',
    });

    const c = await negociacao.cronograma(processo.id, propostaId, autor);
    expect(c.parcelas.every((p) => p.vencida)).toBe(true);

    /* A assinatura do cliente NÃO é tocada: o escritório atrasar o pagamento ao
       titular DELE não é motivo para tirar o acesso dele ao sistema. */
    const assinaturas = await observador.assinatura.findMany();
    expect(assinaturas.every((a) => a.status !== 'SUSPENSA')).toBe(true);

    /* E paga deixa de ser vencida, mesmo com o vencimento no passado. */
    await negociacao.baixar(processo.id, propostaId, 1, autor);
    const depois = await negociacao.cronograma(processo.id, propostaId, autor);
    expect(depois.parcelas.find((p) => p.numero === 1)!.vencida).toBe(false);
  });

  it('o cronograma de A é invisível e intocável para B', async () => {
    const { org } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    await liberarProcesso(a.org.id, processo.id);
    await liberarProcesso(b.org.id, processo.id);
    await prisma.user.update({ where: { id: b.user.id }, data: { gestor: true } });

    const p = await negociacao.criar(processo.id, a.autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });
    await negociacao.gerarCronograma(processo.id, p.id, a.autor, {
      parcelas: 2,
      primeiroVencimento: '2026-09-10',
    });

    /* B enxerga o PROCESSO — é o que torna o caso perigoso — mas 404 na proposta
       alheia, mesmo sabendo o id e o número da parcela. */
    await expect(negociacao.cronograma(processo.id, p.id, b.autor)).rejects.toThrow(
      NotFoundException,
    );
    await expect(negociacao.baixar(processo.id, p.id, 1, b.autor)).rejects.toThrow(
      NotFoundException,
    );

    const intactas = await observador.parcelaCessao.findMany({ where: { propostaId: p.id } });
    expect(intactas.every((x) => x.pagoEm === null)).toBe(true);
  });

  it('descartar o rascunho leva o cronograma junto', async () => {
    /* A chave estrangeira é CASCADE justamente para isso: rascunho descartado
       não deixa parcelas órfãs de um contrato que nunca existiu. */
    const { autor, processo, propostaId } = await comRascunho();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 4,
      primeiroVencimento: '2026-09-10',
    });

    await negociacao.remover(processo.id, propostaId, autor);

    expect(await observador.parcelaCessao.count({ where: { propostaId } })).toBe(0);
  });

  it('as parcelas saem na folha — nos DOIS destinos', async () => {
    /* É o que o titular assina: um documento que não diz quando ele recebe não
       serve para o que foi feito. */
    const { autor, processo, propostaId } = await comRascunho();
    await negociacao.gerarCronograma(processo.id, propostaId, autor, {
      parcelas: 3,
      primeiroVencimento: '2026-09-10',
    });
    await negociacao.enviar(processo.id, propostaId, autor);

    const doTitular = await negociacao.relatorio(processo.id, propostaId, autor, 'TITULAR');
    const interna = await negociacao.relatorio(processo.id, propostaId, autor, 'INTERNO');

    expect(doTitular.pagamento?.parcelas).toHaveLength(3);
    expect(interna.pagamento?.parcelas).toHaveLength(3);
    /* E a folha do titular continua sem a margem. */
    expect(doTitular).not.toHaveProperty('interno');
  });
});

describe('Negociação — a folha impressa', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  async function comProposta() {
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
      observacao: 'titular pediu para decidir com a filha',
    });
    await negociacao.enviar(processo.id, p.id, autor);
    return { org, autor, processo, propostaId: p.id };
  }

  it('a folha do TITULAR não CONTÉM a margem — ausência de chave, não valor nulo', async () => {
    /**
     * O pior erro que este documento pode cometer: entregar o lucro do
     * escritório na mão de quem negocia contra ele.
     *
     * A verificação é de AUSÊNCIA DE CHAVE porque é isso que a montagem por
     * destino garante. Um `toBeNull()` passaria também numa implementação que
     * monta tudo e apaga depois — e essa implementação vaza no dia em que
     * alguém acrescentar um campo e esquecer de apagá-lo.
     */
    const { autor, processo, propostaId } = await comProposta();

    const folha = await negociacao.relatorio(processo.id, propostaId, autor, 'TITULAR');

    expect(folha).not.toHaveProperty('interno');
    const cru = JSON.stringify(folha);
    expect(cru).not.toContain('desagio');
    expect(cru).not.toContain('decidir com a filha');
    /* E o que ELE precisa ver está lá. */
    expect(folha.proposta.valorProposto).toBe('300000');
    expect(folha.proposta.baseOrigem).toBe('PARTE_UNICA');
  });

  /**
   * O DOCUMENTO DIZ O QUE O CRÉDITO É.
   *
   * ── O QUE ESTES CASOS TRANCAM ──
   *
   * Esta folha é ASSINADA pelo titular, e o bloco de identificação do crédito se
   * chamava "O precatório". Enquanto a base era 100% `PRECATORIO_EXPEDIDO` isso
   * era simplesmente verdade. Com os pré-precatórios na carteira — e no mesmo
   * sorteio dos 250 — o papel passou a chamar de precatório um crédito que pode
   * estar em TRÂNSITO EM JULGADO, sem precatório autuado, sem exercício e sem
   * valor apurado.
   *
   * O escritório entregava esse papel de boa-fé: a tela não lhe dizia a
   * diferença. O `SeloFase` existia na carteira e nunca chegou aqui.
   *
   * ── POR QUE A ASSERÇÃO É SOBRE A API, E NÃO SOBRE O TEXTO ──
   *
   * A palavra impressa mora no componente; o que o servidor precisa garantir é
   * que a informação CHEGUE. Uma folha sem `fase` no payload não tem como dizer
   * o estágio por mais bem escrita que a tela esteja.
   */
  it('⚠ a folha carrega a FASE — sem ela o documento não tem como dizer o estágio', async () => {
    const { autor, processo, propostaId } = await comProposta();

    const folha = await negociacao.relatorio(processo.id, propostaId, autor, 'TITULAR');

    expect(folha.precatorio.fase).toBe('PRECATORIO_EXPEDIDO');
  });

  it('⚠ na folha de um PRÉ-precatório, a fase é a anterior e o exercício é NULO', async () => {
    /* O caso que o rótulo antigo transformava em afirmação falsa. O exercício
       nulo não é dado faltando: ele só existe depois que o precatório entra na
       fila orçamentária, e a folha agora imprime essa razão ao lado. */
    const { org, autor } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [null], {
      fase: 'TRANSITO_EM_JULGADO',
      exercicio: null,
    });
    const p = await negociacao.criar(processo.id, autor, {
      modalidade: 'CESSAO',
      valorProposto: '90000.00',
    });
    await negociacao.enviar(processo.id, p.id, autor);

    const folha = await negociacao.relatorio(processo.id, p.id, autor, 'TITULAR');

    expect(folha.precatorio.fase).toBe('TRANSITO_EM_JULGADO');
    expect(folha.precatorio.exercicio).toBeNull();
  });

  it('a folha INTERNA também traz a fase — as duas descrevem o mesmo crédito', async () => {
    /* Se só uma das montagens levasse a fase, o escritório leria um estágio na
       via dele e entregaria outra coisa ao titular. */
    const { autor, processo, propostaId } = await comProposta();

    const interna = await negociacao.relatorio(processo.id, propostaId, autor, 'INTERNO');

    expect(interna.precatorio.fase).toBe('PRECATORIO_EXPEDIDO');
  });

  it('sem `destino`, o padrão é a folha do TITULAR', async () => {
    /* Um parâmetro esquecido numa integração futura entrega a folha SEM margem,
       e não a folha com ela. O padrão é o lado seguro. */
    const { autor, processo, propostaId } = await comProposta();

    const folha = await negociacao.relatorio(processo.id, propostaId, autor);

    expect(folha).not.toHaveProperty('interno');
  });

  it('a folha INTERNA traz margem, observação e o histórico das rodadas', async () => {
    const { autor, processo, propostaId } = await comProposta();

    const folha = await negociacao.relatorio(processo.id, propostaId, autor, 'INTERNO');

    /* O tipo de retorno é a UNIÃO das duas folhas, e é assim que tem de ser: o
       compilador obriga quem consome a decidir qual está lendo antes de tocar na
       margem. Aqui o teste faz essa checagem à mão. */
    if (!('interno' in folha)) throw new Error('a folha interna deveria trazer o bloco interno');

    expect(folha.interno.desagioPercentual).toBe('70');
    expect(folha.interno.observacao).toBe('titular pediu para decidir com a filha');
    expect(folha.interno.historico).toHaveLength(1);
  });

  it('o timbre é do ESCRITÓRIO, e a marca do produto não aparece', async () => {
    /* É o papel que o cliente entrega ao titular DELE: esconder a
       infraestrutura é a promessa central do produto. */
    const { autor, processo, propostaId } = await comProposta();

    const folha = await negociacao.relatorio(processo.id, propostaId, autor, 'TITULAR');

    expect(folha.escritorio.nome).toBe('Escritório de Teste');
    expect(JSON.stringify(folha)).not.toMatch(/MINER|Leão Amorim/i);
  });

  it('imprimir deixa TRILHA — é o momento em que o CPF sai em papel', async () => {
    /**
     * A fila não grava trilha de propósito (é lista de trabalho, e gravar a cada
     * filtro afogaria o que importa). Isto não é lista: é egresso de dado
     * pessoal, e é o elo mais grave da cadeia.
     */
    const { autor, processo, propostaId } = await comProposta();

    await negociacao.relatorio(processo.id, propostaId, autor, 'TITULAR', {
      ip: '10.0.0.1',
      userAgent: 'jest',
    });

    const trilha = await prisma.consultaCliente.findMany({ where: { userId: autor.id } });
    expect(trilha).toHaveLength(1);
    expect(trilha[0].tipo).toBe('PROPOSTA');
    expect(trilha[0].termo).toBe((await prisma.processo.findUniqueOrThrow({ where: { id: processo.id } })).numeroPrecatorio);
    /* Uma parte só: o CPF vai. Com várias, gravar um seria escolher de quem é a
       trilha arbitrariamente. */
    expect(trilha[0].cpfConsultado).not.toBeNull();
  });

  it('a folha de OUTRO escritório é 404, mesmo com o processo à vista', async () => {
    const { org } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    await liberarProcesso(a.org.id, processo.id);
    await liberarProcesso(b.org.id, processo.id);
    const p = await negociacao.criar(processo.id, a.autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });

    await expect(
      negociacao.relatorio(processo.id, p.id, b.autor, 'INTERNO'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('Negociação — isolamento entre escritórios', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /** O MESMO precatório liberado a dois clientes — não há exclusividade. */
  async function doisEscritorios() {
    const { org } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const a = await semearCliente('Escritório A');
    const b = await semearCliente('Escritório B');
    await liberarProcesso(a.org.id, processo.id);
    await liberarProcesso(b.org.id, processo.id);
    return { processo, a, b };
  }

  it('a proposta de A é invisível e intocável para B', async () => {
    const { processo, a, b } = await doisEscritorios();
    const deA = await negociacao.criar(processo.id, a.autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });

    /* B ENXERGA o processo — é o que torna o caso perigoso. */
    await expect(negociacao.resumo(processo.id, b.autor)).resolves.toMatchObject({ rodadas: [] });

    await expect(
      negociacao.ajustar(processo.id, deA.id, b.autor, { valorProposto: '1.00' }),
    ).rejects.toThrow(NotFoundException);
    await expect(negociacao.enviar(processo.id, deA.id, b.autor)).rejects.toThrow(NotFoundException);
    await expect(negociacao.remover(processo.id, deA.id, b.autor)).rejects.toThrow(
      NotFoundException,
    );

    /* Nem o ADMIN de B: administrador é papel DENTRO de um inquilino. */
    await expect(
      negociacao.remover(processo.id, deA.id, { ...b.autor, papel: 'ADMIN' }),
    ).rejects.toThrow(NotFoundException);

    const viva = await prisma.propostaNegociacao.findUniqueOrThrow({ where: { id: deA.id } });
    expect(viva.valorProposto?.toString()).toBe('300000');
  });

  it('os dois negociam o MESMO processo sem se atrapalhar', async () => {
    const { processo, a, b } = await doisEscritorios();

    await negociacao.criar(processo.id, a.autor, {
      modalidade: 'CESSAO',
      valorProposto: '300000.00',
    });
    await negociacao.criar(processo.id, b.autor, {
      modalidade: 'HONORARIOS',
      honorarioPercentual: '20.00',
    });

    /* A trava de "uma proposta viva" é por (org, processo): ela não pode
       impedir o concorrente de ter a dele. */
    expect((await negociacao.resumo(processo.id, a.autor)).viva?.modalidade).toBe('CESSAO');
    expect((await negociacao.resumo(processo.id, b.autor)).viva?.modalidade).toBe('HONORARIOS');
  });
});

describe('Negociação — as travas que moram no BANCO', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  /**
   * `ux_proposta_viva` e `ux_proposta_aceita` são índices PARCIAIS, criados no
   * SQL da migration. O Prisma NÃO OS ENXERGA — quem rodar `migrate diff` os
   * derruba sem aviso, como já acontece com os cinco trigram.
   *
   * Por isso estes dois casos gravam DIRETO no banco, sem passar pelo serviço: o
   * que se testa aqui não é a regra da aplicação, é a existência da trava. No
   * dia em que ela sumir, é aqui que a suíte fica vermelha.
   */
  it('o banco recusa DUAS propostas vivas no mesmo processo', async () => {
    const { org, user } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const comum = {
      organizationId: org.id,
      processoId: processo.id,
      autorId: user.id,
      modalidade: 'CESSAO' as const,
    };

    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 1, status: 'ENVIADA' } });

    await expect(
      prisma.propostaNegociacao.create({ data: { ...comum, rodada: 2, status: 'RASCUNHO' } }),
    ).rejects.toThrow(/Unique constraint|unique/i);
  });

  it('o banco recusa DUAS propostas aceitas no mesmo processo', async () => {
    const { org, user } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const comum = {
      organizationId: org.id,
      processoId: processo.id,
      autorId: user.id,
      modalidade: 'CESSAO' as const,
    };

    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 1, status: 'ACEITA' } });

    await expect(
      prisma.propostaNegociacao.create({ data: { ...comum, rodada: 2, status: 'ACEITA' } }),
    ).rejects.toThrow(/Unique constraint|unique/i);
  });

  it('mas ACEITA e SUBSTITUIDA convivem — a trava é parcial de propósito', async () => {
    /* Sem o `WHERE` do índice, um processo com histórico não conseguiria ter
       nem a proposta aceita: as rodadas antigas ocupariam a vaga. */
    const { org, user } = await semearOrganizacao();
    const processo = await processoComPartes(org.id, [1000000]);
    const comum = {
      organizationId: org.id,
      processoId: processo.id,
      autorId: user.id,
      modalidade: 'CESSAO' as const,
    };

    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 1, status: 'SUBSTITUIDA' } });
    await prisma.propostaNegociacao.create({ data: { ...comum, rodada: 2, status: 'RECUSADA' } });
    await expect(
      prisma.propostaNegociacao.create({ data: { ...comum, rodada: 3, status: 'ACEITA' } }),
    ).resolves.toBeDefined();
  });
});
