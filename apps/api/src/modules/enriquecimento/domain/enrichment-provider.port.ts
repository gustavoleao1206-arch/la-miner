/**
 * Porta (hexagonal) do provedor de enriquecimento.
 *
 * Nenhum caso de uso conhece "Contactra". Eles dependem desta interface.
 * Trocar de provedor — ou usar dois em cascata — é mudança de configuração,
 * não de código de domínio.
 */

export const ENRICHMENT_PROVIDER = Symbol('ENRICHMENT_PROVIDER');

/** Telefone normalizado para o nosso domínio, independente do formato do provedor. */
export interface TelefoneEnriquecido {
  ddd?: string;
  numero: string;
  tipo?: 'MOVEL' | 'FIXO' | 'DESCONHECIDO';
  whatsapp?: boolean;
  /* Havia um `score?: number` aqui, e a ausência dele é a trava.
     Tirar o campo do CONTRATO é o que impede um provedor futuro de reintroduzir
     a coleta sem ninguém perceber: o TypeScript recusa. Tivesse ficado como
     opcional, bastaria um mapper novo preenchê-lo para o dado voltar a entrar. */
}

export interface EnderecoEnriquecido {
  logradouro?: string;
  numero?: string;
  complemento?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  tipo?: string;
}

export interface PessoaEnriquecida {
  nome?: string;
  dataNascimento?: Date;
  nomeMae?: string;
  situacaoCadastral?: string;
  obito?: boolean;
  telefones: TelefoneEnriquecido[];
  /* Sem `score`, pela mesma razão de `TelefoneEnriquecido`. */
  emails: { endereco: string }[];
  enderecos: EnderecoEnriquecido[];
}

export type StatusEnriquecimentoProvider = 'SUCESSO' | 'SEM_DADOS' | 'ERRO';

export interface ResultadoEnriquecimento {
  status: StatusEnriquecimentoProvider;
  pessoa?: PessoaEnriquecida;
  /**
   * Payload íntegro do provedor, sem transformação.
   * É o que permite acrescentar campos depois sem migration —
   * o dado já estará gravado.
   */
  dadosBrutos: unknown;
  mensagemErro?: string;
  custoCreditos?: number;
  requestId?: string;
  latenciaMs: number;
}

export interface ContextoConsulta {
  /** Para rastrear a origem no log/auditoria (ex.: importacaoId). */
  origem?: string;
  correlacaoId?: string;
}

export interface SaudeProvider {
  disponivel: boolean;
  detalhe?: string;
}

export interface EnrichmentProvider {
  readonly nome: string;

  /** Consulta 1 CPF. Deve normalizar a resposta para PessoaEnriquecida. */
  consultarPorCpf(cpf: string, ctx?: ContextoConsulta): Promise<ResultadoEnriquecimento>;

  healthCheck(): Promise<SaudeProvider>;
}
