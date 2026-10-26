import { dataBR, mapearRespostaContactra } from './contactra.mapper';

/**
 * Fixture SINTÉTICA no formato da resposta da Contactra: nome, CPF, datas e
 * endereço são inventados. A ESTRUTURA é a que o mapper precisa ler.
 */
const respostaExemplo = {
  meta: {
    protocolo: '0000-exemplo-0000',
    reconsulta: false,
  },
  resposta: {
    cadastro: {
      nome: 'FULANA DE TAL',
      cpf: '00000000000',
      dataNascimento: '17/08/1971',
      nomeDaMae: 'MARIA DE TAL',
      situacaoCadastral: 'REGULAR',
      falecido: false,
    },
    telefones: { fixos: [], moveis: [] },
    telefonesExtras: { fixos: [], moveis: [] },
    emails: [],
    emailsExtras: [],
    enderecos: [
      {
        uf: 'SP',
        cidade: 'CIDADE EXEMPLO',
        complemento: 'APTO 101',
        numero: 100,
        logradouro: 'DAS FLORES',
        bairro: 'CENTRO',
        tipoLogradouro: 'R',
        cep: '01001000',
        qualidadeCep: 'COMPLETA',
      },
    ],
    enderecosExtras: [],
  },
};

describe('contactra.mapper', () => {
  describe('dataBR', () => {
    it('converte DD/MM/AAAA corretamente', () => {
      const d = dataBR('04/03/1963');
      expect(d?.getFullYear()).toBe(1963);
      expect(d?.getMonth()).toBe(2); // março = 2
      expect(d?.getDate()).toBe(4);
    });

    it('não confunde dia com mês (o bug que new Date() causaria)', () => {
      // 13/01 só é válido como DD/MM — se fosse lido como MM/DD daria inválido
      expect(dataBR('13/01/1990')?.getMonth()).toBe(0);
    });

    it('devolve undefined para formato desconhecido', () => {
      expect(dataBR('1963-03-04')).toBeUndefined();
      expect(dataBR(null)).toBeUndefined();
    });
  });

  describe('mapearRespostaContactra', () => {
    it('extrai os dados cadastrais', () => {
      const p = mapearRespostaContactra(respostaExemplo)!;
      expect(p.nome).toBe('FULANA DE TAL');
      expect(p.nomeMae).toBe('MARIA DE TAL');
      expect(p.situacaoCadastral).toBe('REGULAR');
      expect(p.obito).toBe(false);
      expect(p.dataNascimento?.getFullYear()).toBe(1971);
    });

    it('junta tipoLogradouro + logradouro no endereço', () => {
      const p = mapearRespostaContactra(respostaExemplo)!;
      expect(p.enderecos[0].logradouro).toBe('R DAS FLORES');
      expect(p.enderecos[0].cep).toBe('01001000');
      expect(p.enderecos[0].numero).toBe('100');
      expect(p.enderecos[0].uf).toBe('SP');
    });

    it('lida com telefones vazios sem quebrar', () => {
      const p = mapearRespostaContactra(respostaExemplo)!;
      expect(p.telefones).toEqual([]);
      expect(p.emails).toEqual([]);
    });

    it('achata telefones de { fixos, moveis } em lista única com tipo', () => {
      const comTel = {
        ...respostaExemplo,
        resposta: {
          ...respostaExemplo.resposta,
          telefones: {
            fixos: [{ ddd: '81', numero: '33334444' }],
            moveis: [{ ddd: '81', numero: '999998888', whatsapp: true }],
          },
        },
      };
      const p = mapearRespostaContactra(comTel)!;
      expect(p.telefones).toHaveLength(2);
      // móveis primeiro — são os que mais importam para contato
      expect(p.telefones[0]).toMatchObject({ ddd: '81', numero: '999998888', tipo: 'MOVEL', whatsapp: true });
      expect(p.telefones[1]).toMatchObject({ tipo: 'FIXO' });
    });

    it('separa DDD embutido no número', () => {
      const comTel = {
        ...respostaExemplo,
        resposta: {
          ...respostaExemplo.resposta,
          telefones: { fixos: [], moveis: [{ numero: '81999998888' }] },
        },
      };
      const p = mapearRespostaContactra(comTel)!;
      expect(p.telefones[0]).toMatchObject({ ddd: '81', numero: '999998888' });
    });

    it('devolve null quando não há dado algum', () => {
      expect(mapearRespostaContactra({ resposta: {} })).toBeNull();
      expect(mapearRespostaContactra(null)).toBeNull();
    });
  });
});

/**
 * O QUE NÃO CABE NA COLUNA NÃO SAI DAQUI.
 *
 * Quatro colunas alimentadas por texto do provedor têm limite duro:
 * `Telefone.ddd` VarChar(3), `Telefone.numero` VarChar(15), `Endereco.uf`
 * VarChar(2) e `Endereco.cep` VarChar(8). O mapper entregava as quatro cruas.
 *
 * Um valor grande demais não falhava aqui: viajava até o `INSERT`, onde o
 * Postgres levantava 22001 — dentro da transação do enriquecimento, DEPOIS de a
 * consulta já ter sido paga. Era o gatilho mais barato para o rollback que fazia
 * o job ser retentado e o provedor cobrado de novo.
 *
 * ── DESCARTAR, E NUNCA TRUNCAR ──
 *
 * Cortar um telefone de 20 dígitos em 15 não produz um telefone: produz um
 * número errado, que alguém liga. É a mesma regra que a fonte dos
 * pré-precatórios enuncia para o CPF — "documento errado ao lado de um nome é
 * pior que documento nenhum".
 */
describe('contactra.mapper — o que não cabe na coluna é descartado', () => {
  /** Envelope mínimo: só o que cada caso precisa mexer. */
  function resposta(partes: Record<string, unknown>) {
    return {
      resposta: {
        cadastro: { nome: 'FULANA DE TAL' },
        telefones: { fixos: [], moveis: [] },
        telefonesExtras: { fixos: [], moveis: [] },
        emails: [],
        emailsExtras: [],
        enderecos: [],
        enderecosExtras: [],
        ...partes,
      },
    };
  }

  describe('UF', () => {
    it('⚠ UF com mais de duas letras SOME — não vira as duas primeiras', () => {
      const r = mapearRespostaContactra(
        resposta({ enderecos: [{ cidade: 'Recife', uf: 'PERNAMBUCO', cep: '50000000' }] }),
      );
      expect(r?.enderecos[0].uf).toBeUndefined();
      /* O endereço continua: perder a UF não invalida a rua e o CEP. */
      expect(r?.enderecos[0].cidade).toBe('Recife');
    });

    it('UF válida em minúscula é normalizada, não descartada', () => {
      const r = mapearRespostaContactra(resposta({ enderecos: [{ uf: 'pe' }] }));
      expect(r?.enderecos[0].uf).toBe('PE');
    });
  });

  describe('CEP', () => {
    it('⚠ CEP que não tem 8 dígitos SOME', () => {
      const r = mapearRespostaContactra(
        resposta({ enderecos: [{ uf: 'PE', cep: '5000000000000' }] }),
      );
      expect(r?.enderecos[0].cep).toBeUndefined();
    });

    it('CEP de 7 dígitos também some — não é CEP incompleto, é outra coisa', () => {
      const r = mapearRespostaContactra(resposta({ enderecos: [{ uf: 'PE', cep: '5000003' }] }));
      expect(r?.enderecos[0].cep).toBeUndefined();
    });

    it('CEP com máscara continua passando, só com os dígitos', () => {
      const r = mapearRespostaContactra(resposta({ enderecos: [{ uf: 'PE', cep: '50000-030' }] }));
      expect(r?.enderecos[0].cep).toBe('50000030');
    });
  });

  describe('Telefone', () => {
    it('⚠ número longo demais é DESCARTADO, não cortado em 15', () => {
      const r = mapearRespostaContactra(
        resposta({ telefones: { fixos: [], moveis: [{ ddd: '81', numero: '99999888877776666' }] } }),
      );
      expect(r?.telefones).toHaveLength(0);
    });

    it('⚠ DDD que não tem 2 dígitos não vira DDD', () => {
      const r = mapearRespostaContactra(
        resposta({ telefones: { fixos: [], moveis: [{ ddd: '81999', numero: '999998888' }] } }),
      );
      /* O telefone sobrevive — é o DDD que era mentira. */
      expect(r?.telefones).toHaveLength(1);
      expect(r?.telefones[0].ddd).toBeUndefined();
      expect(r?.telefones[0].numero).toBe('999998888');
    });

    it('telefone normal continua intacto — a trava não pode custar dado bom', () => {
      const r = mapearRespostaContactra(
        resposta({ telefones: { fixos: [], moveis: [{ ddd: '81', numero: '999998888' }] } }),
      );
      expect(r?.telefones[0]).toMatchObject({ ddd: '81', numero: '999998888', tipo: 'MOVEL' });
    });
  });
});
