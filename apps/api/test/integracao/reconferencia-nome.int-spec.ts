import { ReconferenciaService } from '../../src/modules/enriquecimento/application/reconferencia.service';
import { prisma, limparDados, encerrar } from './ambiente';

const reconferencia = new ReconferenciaService(prisma as never);

/**
 * REFAZER O VEREDITO SEM PAGAR DE NOVO.
 *
 * `Pessoa.conferenciaNome` é dado DERIVADO. Em 08/09/2026 a regra mudou — passou
 * a conferir separadamente cada credor de uma célula com vários nomes —, e o
 * veredito gravado virou resposta de uma pergunta que ninguém faz mais.
 *
 * O que torna a correção do passado possível é `Enriquecimento.dadosBrutos`: a
 * resposta crua do provedor fica 180 dias, e o nome do titular está lá. A
 * finalidade declarada dessa retenção é "reprocessar sem o arquivo".
 *
 * Estes casos existem porque a rotina ESCREVE numa coluna que decide
 * distribuição: um DIVERGE novo tira o processo do sorteio da madrugada
 * seguinte, e um CONFERE indevido devolve ao cliente um CPF de estranho.
 */

/** O envelope que `mapearRespostaContactra` sabe ler. */
const payloadCom = (nome: string) => ({ resposta: { cadastro: { nome } } });

async function semearPessoa(params: {
  cpf: string;
  /** O nome como veio da PLANILHA — é ele que pode trazer vários credores. */
  nome: string;
  veredito: 'NAO_CONFERIDO' | 'CONFERE' | 'DIVERGE';
  /** O nome que o PROVEDOR devolveu, guardado no payload. `null` = sem payload. */
  doProvedor: string | null;
}) {
  const pessoa = await prisma.pessoa.create({
    data: {
      cpf: params.cpf,
      nome: params.nome,
      nomeNormalizado: params.nome,
      conferenciaNome: params.veredito,
    },
    select: { id: true },
  });
  if (params.doProvedor !== null) {
    await prisma.enriquecimento.create({
      data: {
        pessoaId: pessoa.id,
        provider: 'CONTACTRA',
        versao: 1,
        status: 'SUCESSO',
        dadosBrutos: payloadCom(params.doProvedor),
      },
    });
  }
  return pessoa;
}

const vereditoDe = async (id: string) =>
  (await prisma.pessoa.findUniqueOrThrow({ where: { id }, select: { conferenciaNome: true } }))
    .conferenciaNome;

describe('Reconferência do veredito de nome (sem consultar o provedor)', () => {
  beforeEach(limparDados);
  afterAll(encerrar);

  it('o CONFERE que vinha de sobrenome do OUTRO credor vira DIVERGE', async () => {
    /* O caso dos 95 medidos em produção: célula com dois nomes, e o veredito
       saía de uma coincidência entre pessoas diferentes — "KESSLER" é sobrenome
       do segundo credor e validava o CPF do primeiro. */
    const p = await semearPessoa({
      cpf: '39053344705',
      nome: 'OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER',
      veredito: 'CONFERE',
      doProvedor: 'OTAVIO SANTOS KESSLER',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(p.id)).toBe('DIVERGE');
    expect(r.alteradas).toBe(1);
    expect(r.transicoes).toEqual({ 'CONFERE -> DIVERGE': 1 });
  });

  it('o DIVERGE de quem era o SEGUNDO da lista vira CONFERE', async () => {
    /* O outro lado, e o que devolve dinheiro: o dono legítimo do CPF estava
       listado em segundo lugar, e a regra antiga só aceitava o primeiro nome da
       célula. O processo tinha sido bloqueado por defeito da comparação. */
    const p = await semearPessoa({
      cpf: '11144477735',
      nome: 'OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER',
      veredito: 'DIVERGE',
      doProvedor: 'RUBENS KESSLER',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(p.id)).toBe('CONFERE');
    expect(r.transicoes).toEqual({ 'DIVERGE -> CONFERE': 1 });
  });

  it('simular NÃO grava — e é o padrão', async () => {
    const p = await semearPessoa({
      cpf: '39053344705',
      nome: 'OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER',
      veredito: 'CONFERE',
      doProvedor: 'OTAVIO SANTOS KESSLER',
    });

    const r = await reconferencia.reconferir();

    expect(r.simular).toBe(true);
    expect(r.alteradas).toBe(1);
    /* O relatório anuncia a mudança; o banco continua como estava. */
    expect(await vereditoDe(p.id)).toBe('CONFERE');
  });

  it('NAO_CONFERIDO não é tocado — é a carteira inteira dos TRFs', async () => {
    /* A trava que impede a correção de uma regra de virar decisão comercial: dar
       veredito a quem nunca teve alcançaria os 12.425 precatórios de uma vez, e
       cada DIVERGE novo sairia do sorteio na mesma madrugada. */
    const p = await semearPessoa({
      cpf: '39053344705',
      nome: 'JOAO PEREIRA SILVA',
      veredito: 'NAO_CONFERIDO',
      doProvedor: 'MARIA SANTOS COSTA',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(p.id)).toBe('NAO_CONFERIDO');
    expect(r.analisadas).toBe(0);
  });

  it('sem payload guardado, a pessoa é contada à parte e não muda', async () => {
    /* Depois do corte de retenção não há o que reprocessar. Somar isso em
       "inalteradas" faria o relatório parecer completo quando não é. */
    const p = await semearPessoa({
      cpf: '39053344705',
      nome: 'OTAVIO BRANDAO DE ARRUDA, RUBENS KESSLER',
      veredito: 'CONFERE',
      doProvedor: null,
    });
    /* Uma pessoa COM payload no mesmo lote: sem ela, `analisadas: 0` passaria o
       caso mesmo que o filtro estivesse errado. */
    await semearPessoa({
      cpf: '11144477735',
      nome: 'MARIA DE SOUZA',
      veredito: 'CONFERE',
      doProvedor: 'MARIA DE SOUZA SANTOS',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(p.id)).toBe('CONFERE');
    /* A sem payload nem entra na consulta — o `where` exige um dadosBrutos. */
    expect(r.analisadas).toBe(1);
    expect(r.inalteradas).toBe(1);
    expect(r.alteradas).toBe(0);
  });

  it('o CONFERE de um nome só de INICIAIS volta a ser NAO_CONFERIDO', async () => {
    /* Medido em produção em 10/09/2026: 41 dos 1.169 estavam assim. O tribunal
       anonimiza menor de idade e segredo de justiça em iniciais; `tokensDoNome`
       descarta token de uma letra, então não sobrava nada com que comparar — e
       a regra antiga devolvia CONFERE, afirmando que o CPF era daquela pessoa.

       O destino é NAO_CONFERIDO e não DIVERGE de propósito: não há evidência de
       erro, só ausência de evidência. Nenhum dos dois desenha aviso na tela. */
    const p = await semearPessoa({
      cpf: '39053344705',
      nome: 'M.A.V.',
      veredito: 'CONFERE',
      doProvedor: 'MARIA APARECIDA VIEIRA',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(p.id)).toBe('NAO_CONFERIDO');
    expect(r.transicoes).toEqual({ 'CONFERE -> NAO_CONFERIDO': 1 });
  });

  it('nome de uma pessoa só continua com o veredito de sempre', async () => {
    /* A maioria da base. A correção não pode mexer em quem não tem vírgula. */
    const igual = await semearPessoa({
      cpf: '39053344705',
      nome: 'MARIA DE SOUZA SANTOS',
      veredito: 'CONFERE',
      doProvedor: 'MARIA DE SOUZA SANTOS',
    });
    const outro = await semearPessoa({
      cpf: '11144477735',
      nome: 'JOSE PEREIRA LIMA',
      veredito: 'DIVERGE',
      doProvedor: 'JOSE SANTOS COSTA',
    });

    const r = await reconferencia.reconferir(false);

    expect(await vereditoDe(igual.id)).toBe('CONFERE');
    expect(await vereditoDe(outro.id)).toBe('DIVERGE');
    expect(r.alteradas).toBe(0);
    expect(r.inalteradas).toBe(2);
  });
});
