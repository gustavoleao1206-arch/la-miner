import { faseDaPlanilha } from './fase-da-planilha';

/**
 * A tradução da fase, que não pode adivinhar.
 *
 * A fase decide o que entra no sorteio dos 250 e o que o cliente vê como
 * estágio. Um default aqui viraria venda errada — uma oportunidade em trânsito
 * em julgado marcada como precatório expedido promete exigibilidade que não
 * existe. Por isso o contrato é: reconheceu, traduz; não reconheceu, `null`, e
 * quem chama recusa a linha.
 */
describe('faseDaPlanilha', () => {
  describe('pelo CÓDIGO — é o que a coluna "Fase" traz', () => {
    it.each([
      ['1', 'TRANSITO_EM_JULGADO'],
      ['2', 'CALCULOS_HOMOLOGADOS'],
      ['3', 'REQUISITORIO_EXPEDIDO'],
      ['4', 'PRECATORIO_AUTUADO'],
    ])('%s → %s', (codigo, esperado) => {
      expect(faseDaPlanilha(codigo)).toBe(esperado);
    });

    it('aceita o que o Excel devolve: número, texto e "2.0"', () => {
      /* A mesma célula chega das três formas dependendo de como a planilha foi
         salva. As três são o mesmo estágio, e recusar uma delas reprovaria a
         linha por formatação. */
      expect(faseDaPlanilha('2')).toBe('CALCULOS_HOMOLOGADOS');
      expect(faseDaPlanilha(' 2 ')).toBe('CALCULOS_HOMOLOGADOS');
      expect(faseDaPlanilha('2.0')).toBe('CALCULOS_HOMOLOGADOS');
    });

    it('código fora da faixa NÃO vira palpite', () => {
      expect(faseDaPlanilha('0')).toBeNull();
      expect(faseDaPlanilha('5')).toBeNull();
      expect(faseDaPlanilha('-1')).toBeNull();
      /* 2,5 não é fase nenhuma. Aceitá-lo como 2 seria arredondar o estágio de
         um crédito — exatamente o tipo de gentileza que vira defeito. */
      expect(faseDaPlanilha('2.5')).toBeNull();
    });
  });

  describe('pelo TEXTO — a coluna "Descrição da fase"', () => {
    it.each([
      ['Trânsito em julgado', 'TRANSITO_EM_JULGADO'],
      ['Cálculos homologados', 'CALCULOS_HOMOLOGADOS'],
      ['Requisitório expedido', 'REQUISITORIO_EXPEDIDO'],
      ['Precatório autuado', 'PRECATORIO_AUTUADO'],
    ])('%s → %s', (texto, esperado) => {
      expect(faseDaPlanilha(texto)).toBe(esperado);
    });

    it('acento, caixa e pontuação não decidem nada', () => {
      /* Quem exporta a planilha de novo pode salvar sem acento, em caixa alta,
         ou com hífen. Nenhuma dessas variações muda o estágio de um crédito. */
      expect(faseDaPlanilha('TRANSITO EM JULGADO')).toBe('TRANSITO_EM_JULGADO');
      expect(faseDaPlanilha('calculos-homologados')).toBe('CALCULOS_HOMOLOGADOS');
      expect(faseDaPlanilha('Requisitorio  Expedido')).toBe('REQUISITORIO_EXPEDIDO');
    });
  });

  describe('o que NÃO reconhece — e é aqui que o contrato vive', () => {
    it.each([null, '', '   '])('%p → null', (v) => {
      expect(faseDaPlanilha(v as string | null)).toBeNull();
    });

    it('texto desconhecido devolve null em vez de escolher o mais parecido', () => {
      /* O instinto seria casar por prefixo ou por semelhança. Seria pior: uma
         fonte nova escrevendo "requisição expedida" cairia em
         REQUISITORIO_EXPEDIDO sem ninguém revisar se é a mesma coisa. */
      expect(faseDaPlanilha('Requisição expedida')).toBeNull();
      expect(faseDaPlanilha('Em andamento')).toBeNull();
      expect(faseDaPlanilha('Pago')).toBeNull();
      expect(faseDaPlanilha('Trânsito')).toBeNull();
    });

    it('NUNCA devolve PRECATORIO_EXPEDIDO por engano', () => {
      /* É a fase que a base inteira tem hoje, e a única distribuível com
         certeza de exigibilidade. Uma planilha de pré-precatório não alcança
         esse estágio — se algo dela caísse aí, 1.169 oportunidades entrariam no
         sorteio anunciadas como precatório na fila orçamentária. */
      const entradas = ['1', '2', '3', '4', 'Trânsito em julgado', 'Precatório autuado', 'lixo'];
      for (const e of entradas) {
        expect(faseDaPlanilha(e)).not.toBe('PRECATORIO_EXPEDIDO');
      }
      /* Só o nome por extenso chega lá, e nenhuma planilha de hoje o escreve. */
      expect(faseDaPlanilha('Precatório expedido')).toBe('PRECATORIO_EXPEDIDO');
    });
  });
});
