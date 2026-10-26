import { mascararDocumento, serializarRequisicaoSemDocumento } from './mascarar-documento';

/**
 * A máscara de documento no log.
 *
 * O que estes casos guardam não é a expressão regular — é a fronteira: mascarar
 * de MENOS vaza CPF para um arquivo que não se apaga sob pedido do titular;
 * mascarar de MAIS destrói o número de precatório e o id de requisição, que são
 * justamente o que se procura quando algo dá errado em produção.
 */
describe('mascararDocumento', () => {
  const CPF = '39053344705';

  it('mascara CPF no caminho da URL', () => {
    expect(mascararDocumento(`/api/v1/auditoria/cpf/${CPF}`)).toBe(
      '/api/v1/auditoria/cpf/[documento]',
    );
  });

  it('mascara CPF na query, preservando o resto', () => {
    expect(mascararDocumento(`/api/v1/carteira/buscar?termo=${CPF}&pagina=1`)).toBe(
      '/api/v1/carteira/buscar?termo=[documento]&pagina=1',
    );
  });

  it('mascara CPF com pontuação', () => {
    expect(mascararDocumento('titular 390.533.447-05 consultado')).toBe(
      'titular [documento] consultado',
    );
  });

  it('mascara CNPJ, com e sem máscara', () => {
    expect(mascararDocumento('12345678000199')).toBe('[documento]');
    expect(mascararDocumento('12.345.678/0001-99')).toBe('[documento]');
  });

  /* ── A outra borda: o que NÃO pode ser mascarado ── */

  it('não fatia número maior que um CPF', () => {
    /* 15 dígitos. Sem as âncoras (?<!\d)/(?!\d) os 11 primeiros virariam
       "[documento]" e sobrariam 4 soltos — log pior que o original. */
    expect(mascararDocumento('protocolo 123456789012345 aceito')).toBe(
      'protocolo 123456789012345 aceito',
    );
  });

  it('preserva o número de precatório, que é o que se procura no log', () => {
    const url = '/api/v1/carteira/processos/0000123-45.2020.4.01.3400';
    expect(mascararDocumento(url)).toBe(url);
  });

  it('preserva UUID de requisição e de usuário', () => {
    const url = '/api/v1/usuarios/3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(mascararDocumento(url)).toBe(url);
  });

  it('não mexe em rota sem documento', () => {
    expect(mascararDocumento('/api/v1/carteira/painel?pagina=2')).toBe(
      '/api/v1/carteira/painel?pagina=2',
    );
  });
});

describe('serializarRequisicaoSemDocumento', () => {
  /** Requisição mínima no formato que o serializer do pino espera. */
  const requisicao = (url: string, query: Record<string, unknown> = {}) => ({
    method: 'GET',
    url,
    query,
    headers: { host: 'localhost' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 1234 },
  });

  it('limpa a url e mantém os campos do serializer padrão', () => {
    const s = serializarRequisicaoSemDocumento(requisicao('/api/v1/auditoria/cpf/39053344705'));
    expect(s.url).toBe('/api/v1/auditoria/cpf/[documento]');
    // Nada de útil se perde: método e origem seguem no log.
    expect(s.method).toBe('GET');
    expect(s.remoteAddress).toBe('127.0.0.1');
  });

  it('limpa também a query, que o serializer padrão registra à parte da url', () => {
    const s = serializarRequisicaoSemDocumento(
      requisicao('/api/v1/auditoria/consultas', { cpfConsultado: '39053344705', pagina: '1' }),
    );
    expect(s.query).toEqual({ cpfConsultado: '[documento]', pagina: '1' });
  });

  it('sobrevive a query com lista e a valor não-string', () => {
    const s = serializarRequisicaoSemDocumento(
      requisicao('/x', { cpfs: ['39053344705', '11144477735'], ativo: true, n: 7 }),
    );
    expect(s.query).toEqual({ cpfs: ['[documento]', '[documento]'], ativo: true, n: 7 });
  });
});
