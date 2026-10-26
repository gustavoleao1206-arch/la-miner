import { cpfDeMetodoRecusado } from './metodo-do-cpf';

/**
 * A régua que decide se uma linha do radar entra — e, com ela, se uma consulta
 * paga é feita. Lista de NEGAÇÃO: só o método medido como ruim fica de fora.
 */
describe('cpfDeMetodoRecusado', () => {
  it('recusa o método "rotulado CPF, credor unico", como a planilha o escreve', () => {
    expect(cpfDeMetodoRecusado('rotulado CPF, credor unico')).toBe(true);
  });

  it('não depende de acento, caixa nem pontuação — o radar pode mudar o rótulo de leve', () => {
    expect(cpfDeMetodoRecusado('Rotulado CPF — credor único')).toBe(true);
    expect(cpfDeMetodoRecusado('  ROTULADO CPF, CREDOR UNICO ')).toBe(true);
  });

  it('aceita os outros dois métodos do radar', () => {
    expect(cpfDeMetodoRecusado('junto ao nome do credor')).toBe(false);
    expect(cpfDeMetodoRecusado('unico CPF valido no texto')).toBe(false);
  });

  it('⚠ método AUSENTE passa — as planilhas dos TRFs não têm essa coluna', () => {
    /* Recusar o vazio tiraria a base inteira dos TRFs da importação. */
    expect(cpfDeMetodoRecusado(null)).toBe(false);
    expect(cpfDeMetodoRecusado(undefined)).toBe(false);
    expect(cpfDeMetodoRecusado('')).toBe(false);
  });

  it('⚠ método DESCONHECIDO passa — é lista de negação, não de permissão', () => {
    /* No dia em que o radar inventar um método, a carga não pode sumir em
       silêncio. Ele entra, é conferido, e a medição decide se vem para a lista. */
    expect(cpfDeMetodoRecusado('cruzado com a certidão')).toBe(false);
  });
});
