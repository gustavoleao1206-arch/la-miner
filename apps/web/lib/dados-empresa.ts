/**
 * Os dados da empresa que as páginas legais precisam citar.
 *
 * Em um arquivo só porque razão social, CNPJ e endereço aparecem nos Termos E
 * na Política de Privacidade — e documento legal com o CNPJ errado em uma das
 * duas é pior que documento nenhum. Conferidos contra a fatura que o Asaas
 * emite em nome da empresa, que é a mesma identificação que o cliente vê ao
 * pagar.
 */
export const EMPRESA = {
  razaoSocial: 'LEÃO AMORIM TECNOLOGIA LTDA',
  cnpj: '68.064.461/0001-61',
  endereco: 'Avenida Mendonça Júnior, 317, Loja A, Gruta de Lourdes, Maceió/AL, CEP 57052-480',
  cidadeForo: 'Maceió, Alagoas',
  email: 'contato@leaoamorimtecnologia.com.br',
} as const;

/**
 * A data da última revisão dos documentos.
 *
 * Escrita à mão, e NÃO derivada de `new Date()`: documento legal precisa dizer
 * desde quando aquele texto vale. Uma data que se atualiza sozinha a cada
 * carregamento faria a página afirmar que foi revisada hoje — todo dia — e
 * destruiria justamente a informação que ela existe para dar.
 */
export const VIGENTE_DESDE = '20 de agosto de 2026';
