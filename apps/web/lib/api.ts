'use client';

import { API_URL as API } from '@/lib/config';

export class ErroApi extends Error {
  constructor(
    public readonly status: number,
    mensagem: string,
    /**
     * O campo `erro` do corpo — um código estável, quando a API manda um.
     *
     * Existe por causa do 403 de MFA obrigatório: a tela precisa distinguir
     * "você não tem permissão" de "falta cadastrar o segundo fator", e as duas
     * chegam como 403. Casar por texto de mensagem quebraria na primeira revisão
     * de redação.
     */
    public readonly codigo?: string,
  ) {
    super(mensagem);
  }
}

/**
 * Só o ACCESS token mora aqui.
 *
 * O refresh vive num cookie httpOnly que este código não lê nem escreve — é o
 * navegador que o guarda e o devolve, e só para as rotas de `/auth`. Um XSS
 * ainda alcançaria o access (15 min), mas não tem como levar embora a
 * credencial de dias que permitiria voltar depois, de outra máquina.
 */
function tokenDeAcesso(): string | null {
  return sessionStorage.getItem('miner.access');
}

/**
 * Toda chamada às rotas de autenticação precisa MANDAR o cookie.
 *
 * `credentials` do fetch é `same-origin` por padrão, e a API está noutra origem
 * (portas distintas em dev, subdomínios em produção). Sem `include`, o cookie
 * simplesmente não é enviado: o login funcionaria e a sessão morreria no
 * primeiro refresh, 15 minutos depois — sem erro nenhum na tela.
 */
const COM_COOKIE: RequestInit = { credentials: 'include' };

/**
 * POR QUE a sessão acabou — o único jeito de a tela de login saber.
 *
 * Sem isto, ser derrubado por um login em outro computador e ser derrubado por
 * expiração normal chegam na mesma tela em branco, e o usuário conclui que o
 * sistema o desloga sozinho. O código vem do campo `erro` da resposta do
 * refresh (`OUTRA_SESSAO`, `SESSAO_ENCERRADA`), nunca do texto da mensagem:
 * casar por redação quebraria na primeira revisão.
 *
 * Módulo, e não estado de componente, porque quem descobre o motivo é o
 * `renovar()` e quem redireciona é o `api()` — e entre os dois não há árvore de
 * React nenhuma.
 */
let motivoDaQueda: string | null = null;

/**
 * A ABA ESTÁ PAUSADA POR INATIVIDADE.
 *
 * ⚠ NÃO é um detalhe de tela. Sem esta trava aqui dentro, pausar a aba não
 * pausaria nada: o painel tem consultas que se repetem sozinhas (React Query),
 * e a primeira delas tomaria 401, renovaria pelo cookie — que continua válido,
 * porque a SESSÃO não morreu — e gravaria um access token novo. A aba estaria
 * destrancada por dentro enquanto mostra o cadeado por fora, e seguiria puxando
 * dados de clientes numa tela que o dono já abandonou.
 *
 * Por isso a recusa acontece ANTES de qualquer fetch, e não depois.
 */
let abaPausada = false;

/** Solta a credencial local e para de falar com a API até alguém voltar. */
export function pausarAba(): void {
  abaPausada = true;
  /* O token sai do storage: a aba pausada não guarda credencial nenhuma. */
  sessionStorage.removeItem('miner.access');
}

/**
 * Volta do pause — em silêncio, se a sessão ainda estiver viva.
 *
 * Devolve `false` quando o servidor recusa a renovação (sessão aberta em outro
 * lugar, senha trocada, refresh expirado). Aí a aba não volta sozinha, e quem
 * chama manda para o login.
 */
export async function retomarAba(): Promise<boolean> {
  abaPausada = false;
  const token = await renovarUmaVez();
  if (token) return true;
  /* Falhou: continua pausada, em vez de virar tela solta sem credencial. */
  abaPausada = true;
  return false;
}

/**
 * Limpa o local e vai para o login, dizendo por quê quando se sabe.
 *
 * ⚠ NÃO consome `motivoDaQueda`. A tentação é zerá-lo aqui, mas isso o perde
 * justamente quando ele importa: o dashboard dispara QUATRO chamadas e as
 * quatro tomam 401 juntas. O mutex faz o refresh acontecer uma vez só, mas as
 * quatro continuações rodam em seguida — a primeira navegaria para
 * `/login?motivo=…` e apagaria o motivo, e as outras três sobrescreveriam o
 * `location.href` com um `/login` pelado. A última atribuição é a que o
 * navegador honra, então a explicação sumia.
 *
 * Quem zera é o `renovar()`, a cada tentativa: o motivo é o resultado da
 * ÚLTIMA renovação, e não um recado acumulado.
 */
function irParaLogin(): void {
  sessionStorage.clear();
  if (typeof window === 'undefined') return;
  const q = motivoDaQueda ? `?motivo=${encodeURIComponent(motivoDaQueda)}` : '';
  window.location.href = `/login${q}`;
}

/**
 * Cliente da API própria. Se o access expirar (15 min), tenta uma vez
 * o refresh rotativo e repete a requisição — de forma transparente.
 * Nenhuma credencial de provider externo passa por aqui: o front só fala
 * com o nosso backend.
 */
export async function api<T>(caminho: string, init: RequestInit = {}): Promise<T> {
  /* Aba pausada não fala com a API — nem para renovar. Ver `pausarAba`. */
  if (abaPausada) throw new ErroApi(401, 'Sessão pausada nesta aba.', 'ABA_PAUSADA');

  const executar = async (token: string | null) =>
    fetch(`${API}/v1${caminho}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });

  let r = await executar(tokenDeAcesso());

  if (r.status === 401) {
    /* O código do PRIMEIRO 401, guardado antes de tentar renovar.
       Ele é o único que sabe explicar um caso: a aba 2 do mesmo navegador
       depois que a aba 1 clicou em "Sair" — o cookie já foi apagado, então o
       refresh responde um 401 genérico e não tem o que dizer. `clone()` porque
       o corpo original ainda pode ser lido adiante. */
    const motivoDoGuard = await r
      .clone()
      .json()
      .then((c) => (typeof c?.erro === 'string' ? (c.erro as string) : null))
      .catch(() => null);

    const renovado = await renovarUmaVez();
    if (!renovado) {
      motivoDaQueda ??= motivoDoGuard;
      irParaLogin();
      throw new ErroApi(401, 'Sessão expirada');
    }
    r = await executar(renovado);

    /**
     * 401 DEPOIS de uma renovação bem-sucedida — o estado que a sessão única
     * criou e que antes era inalcançável.
     *
     * Até aqui, tudo que fazia o guard recusar o access (usuário desativado,
     * `sessoesRevogadasEm`) matava o refresh na mesma transação, então "renova
     * e continua recusando" não existia. Com a família no token passam a
     * existir corridas em que a rotação responde 200 e a requisição seguinte
     * responde 401 — e, sem este bloco, a tela ficava num laço de erro
     * permanente, sem ninguém nunca ser mandado para o login.
     *
     * Vale para as corridas que eu não previ, também: qualquer 401 que
     * sobreviva a uma renovação vira "vá entrar de novo", em vez de virar uma
     * mensagem de erro sem saída.
     */
    if (r.status === 401) {
      const corpo = await r.json().catch(() => ({}));
      motivoDaQueda ??= (typeof corpo?.erro === 'string' ? corpo.erro : null) ?? motivoDoGuard;
      irParaLogin();
      throw new ErroApi(401, corpo?.mensagem ?? 'Sessão encerrada', corpo?.erro);
    }
  }

  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}));

    /**
     * MFA obrigatório: a política do ambiente barrou o acesso porque falta
     * cadastrar o segundo fator.
     *
     * O redirecionamento acontece AQUI, e não em cada tela, porque o 403 pode
     * chegar em qualquer chamada — inclusive nas quatro que o dashboard dispara
     * em paralelo. Tratado tela a tela, cada uma mostraria "acesso negado" e o
     * usuário não teria como saber que a saída é cadastrar o MFA.
     */
    if (r.status === 403 && corpo?.erro === 'MFA_OBRIGATORIO') {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/seguranca')) {
        window.location.href = '/seguranca?obrigatorio=1';
      }
    }

    /* E-mail não confirmado: mesma mecânica do MFA obrigatório, pela mesma
       razão — o 403 chega em QUALQUER chamada, e tratado tela a tela cada uma
       mostraria "acesso negado" sem apontar a saída. A tela de destino é
       pública e tem o reenvio do link. */
    if (r.status === 403 && corpo?.erro === 'EMAIL_NAO_CONFIRMADO') {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/confirmar-email')) {
        window.location.href = '/confirmar-email';
      }
    }

    /**
     * 402 — a assinatura está suspensa ou cancelada.
     *
     * O backend escolheu 402 (Payment Required) em vez de 403 justamente para
     * este caso ter tela própria: o cliente não está proibido, está devendo. O
     * comentário do `AssinaturaAtivaGuard` diz isso com todas as letras — "a
     * diferença importa para a tela, que precisa oferecer regularizar em vez de
     * você não tem permissão".
     *
     * A tela existia; o que faltava era CHEGAR nela. Sem este desvio, o cliente
     * suspenso caía no dashboard, as quatro consultas da carteira tomavam 402
     * em paralelo, e a página ficava em esqueleto para sempre — sem uma palavra
     * sobre assinatura, pagamento ou suspensão. A alavanca comercial existia no
     * servidor e era invisível para quem deveria senti-la.
     *
     * Aqui, e não em cada tela, pelo mesmo motivo do MFA: o 402 chega em
     * QUALQUER chamada da carteira ou do CRM, e tratado tela a tela cada uma
     * mostraria seu próprio erro sem apontar a saída.
     *
     * `/assinatura` não é barrada pelo guard (ele cobre carteira e CRM), e ela
     * só consulta `/cobranca/minha-assinatura` — então não há laço de
     * redirecionamento. A checagem do caminho garante isso também para o
     * seletor de lote, que roda no cabeçalho de toda página.
     */
    if (r.status === 402) {
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/assinatura')) {
        window.location.href = '/assinatura';
      }
    }

    throw new ErroApi(r.status, corpo?.mensagem ?? `Erro ${r.status}`, corpo?.erro);
  }

  /**
   * 204 NÃO TEM CORPO — e `r.json()` sobre corpo vazio LANÇA.
   *
   * Encontrado ao conferir a tela de segurança no navegador: desativar o MFA
   * responde 204, a chamada estourava com "Unexpected end of JSON input", e a
   * tela mostrava esse erro de parser como se a operação tivesse falhado — mas
   * ela tinha funcionado. O pior tipo de mensagem: assusta e mente.
   *
   * A correção vai AQUI, e não em cada chamada, porque toda rota que responde
   * 204 tem o mesmo problema (`trocar-senha`, `mfa/desativar`, e as próximas).
   */
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

/**
 * Serializa a renovação entre requisições concorrentes.
 *
 * O dashboard dispara 4 chamadas em paralelo. Quando o access expira, as quatro
 * recebem 401 ao mesmo tempo e, sem esta trava, cada uma chamava `renovar()` por
 * conta própria. Como o refresh é ROTATIVO e o backend detecta reuso revogando a
 * família inteira, as três perdedoras derrubavam o token que a vencedora acabara
 * de emitir — logout forçado a cada expiração normal, e o log de segurança
 * inundado de "reuso detectado" falso, o que esconderia um roubo de verdade.
 *
 * Com o mutex, a primeira renova e as demais aguardam o mesmo resultado.
 */
let renovacaoEmVoo: Promise<string | null> | null = null;

function renovarUmaVez(): Promise<string | null> {
  renovacaoEmVoo ??= renovar().finally(() => {
    renovacaoEmVoo = null;
  });
  return renovacaoEmVoo;
}

/**
 * Encerra a sessão DE VERDADE.
 *
 * Antes, "Sair" só fazia `sessionStorage.clear()` — a família do refresh
 * continuava válida no servidor até expirar. Com o token num cookie httpOnly
 * isso deixa de ser sutil: limpar o storage não apaga o cookie, e só o servidor
 * pode fazê-lo. Sem esta chamada, "Sair" deixaria a credencial viva no
 * navegador, e o próximo login herdaria a sessão anterior.
 *
 * Nunca lança: se a rede cair, o local é limpo do mesmo jeito. Recusar-se a
 * sair porque o servidor não respondeu deixaria o usuário preso.
 */
export async function encerrarSessao(): Promise<void> {
  try {
    await fetch(`${API}/v1/auth/logout`, { ...COM_COOKIE, method: 'POST' });
  } catch {
    /* ignorado de propósito — ver acima */
  } finally {
    sessionStorage.clear();
    /* Sair encerra o pause junto: a aba deixa de ter o que pausar, e manter a
       trava de pé só quebraria a próxima tela montada neste mesmo documento.
       (O `fetch` acima é cru e não passa pelo `api()`, então sair FUNCIONA com
       a aba pausada — que é o ponto do botão no cadeado.) */
    abaPausada = false;
  }
}

// ── Segundo fator (MFA) ──────────────────────────────────────

export interface SituacaoMfa {
  habilitado: boolean;
  /** Segredo gerado e cadastro não concluído — a tela oferece "continuar". */
  cadastroPendente: boolean;
  /** A política do ambiente exige MFA deste usuário. */
  obrigatorio: boolean;
  codigosDisponiveis: number;
}

export const situacaoMfa = () => api<SituacaoMfa>('/auth/mfa');

export const iniciarMfa = () =>
  api<{ segredo: string; uri: string }>('/auth/mfa/cadastrar', { method: 'POST' });

export const confirmarMfa = (codigo: string) =>
  api<{ codigos: string[] }>('/auth/mfa/confirmar', {
    method: 'POST',
    body: JSON.stringify({ codigo }),
  });

export const renovarCodigosMfa = (codigo: string) =>
  api<{ codigos: string[] }>('/auth/mfa/codigos', {
    method: 'POST',
    body: JSON.stringify({ codigo }),
  });

export const desativarMfa = (senha: string) =>
  api<void>('/auth/mfa/desativar', { method: 'POST', body: JSON.stringify({ senha }) });

/**
 * Passo 2 do login. Fora do `api()` de propósito: não há sessão ainda, então
 * não há access token para anexar nem 401 a renovar — e precisa do cookie.
 */
export async function verificarSegundoFator(
  desafio: string,
  codigo: string,
): Promise<{ accessToken: string }> {
  const r = await fetch(`${API}/v1/auth/mfa/verificar`, {
    ...COM_COOKIE,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ desafio, codigo }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi(r.status, d?.mensagem ?? 'Não foi possível verificar o código.');
  return d;
}

async function renovar(): Promise<string | null> {
  /* Sem corpo e sem consultar nada local: o refresh vai no cookie httpOnly, que
     o navegador anexa sozinho. Não há mais como saber daqui se existe sessão —
     quem responde isso é o 401 da API, e é ele que decide. */
  /* Zera antes de tentar: o motivo é o resultado DESTA renovação, não um recado
     acumulado. Sem isto, uma queda por "outro dispositivo" hoje explicaria uma
     expiração normal amanhã — mandando a pessoa caçar um invasor que não
     existe. É aqui, e não no `irParaLogin`, pelo motivo que aquele comentário
     explica. */
  motivoDaQueda = null;

  const r = await fetch(`${API}/v1/auth/refresh`, { ...COM_COOKIE, method: 'POST' });
  if (!r.ok) {
    /* É AQUI que o motivo aparece. O 401 da requisição original vem do guard e
       não sabe explicar nada; quem distingue "outro dispositivo" de "sessão
       encerrada" é a rotação, porque ela é quem enxerga a família. */
    const corpo = await r.json().catch(() => ({}));
    motivoDaQueda = typeof corpo?.erro === 'string' ? corpo.erro : null;
    return null;
  }
  const d = await r.json();
  sessionStorage.setItem('miner.access', d.accessToken);
  return d.accessToken as string;
}

// ── Tipos ──
export interface ResumoCarteira {
  pessoas: number;
  processos: number;
  valorTotal: string;
  enriquecidas: number;
  pendentes: number;
  porEntidade: { entidade: string; quantidade: number; comValor: number; valor: string }[];
  /**
   * A carteira por ESTÁGIO. Dado cru: quem decide o que cada fase significa é o
   * `FASES` de `components/fase-processo.tsx`, que é quem desenha o selo.
   */
  porFase: { fase: FaseProcesso; quantidade: number }[];
  /** Lote agregado. Explicita o recorte do número exibido. */
  lote: { tribunal: string; exercicio: number } | null;
}

export type StatusEnriquecimento = 'PENDENTE' | 'SINCRONIZADO' | 'SEM_DADOS' | 'ERRO';

/**
 * Um tribunal do catálogo, com o que a organização tem nele.
 *
 * `exercicios` vem do dado real, não de um intervalo fixo: um escritório que só
 * trabalha 2027 não deve ver 2024..2030 no seletor.
 */
export interface TribunalCatalogo {
  sigla: string;
  nome: string;
  esfera: string;
  /** UFs sob jurisdição do tribunal — NÃO é o filtro de endereço da busca. */
  ufsJurisdicao: string[];
  /** Do mais recente para o mais antigo. Vazio = sem carteira neste tribunal. */
  exercicios: { exercicio: number; processos: number }[];
  processos: number;
}

/**
 * BI da carteira: o que dá para acionar, e o que a equipe está fazendo.
 *
 * Existe separado de `ResumoCarteira` porque responde outra pergunta. O resumo
 * diz QUANTO a carteira vale; este diz QUANTO DISSO é alcançável — precatório
 * cujo titular não se contata não é ativo acionável.
 */
export interface PainelCarteira {
  lote: { tribunal: string; exercicio: number } | null;
  cobertura: {
    pessoas: number;
    /** Contam só canais ATIVOS: inativo é dado que o provedor deixou de confirmar. */
    comTelefone: number;
    comEmail: number;
    comEndereco: number;
    comAlgumContato: number;
    valorTotal: string;
    /** Soma dos vínculos cujo titular tem algum contato ativo. */
    valorAlcancavel: string;
  };
  operacao: {
    tarefasAbertas: number;
    /** Calculado com o "hoje" que o cliente envia — depende do fuso de quem lê. */
    tarefasAtrasadas: number;
    processosSemResponsavel: number;
    /** Sempre nas 4 prioridades, em ordem fixa, mesmo as zeradas. */
    porPrioridade: { prioridade: Prioridade; quantidade: number; valor: string }[];
  };
}

export interface PessoaLista {
  id: string;
  cpf: string;
  nome: string;
  statusEnriquecimento: StatusEnriquecimento;
  ultimaSincronizacao: string | null;
  telefones: { ddd: string | null; numero: string }[];
  emails: { endereco: string }[];
  enderecos: { cidade: string | null; uf: string | null }[];
  processos: {
    valorIndividual: string | null;
    processo: {
      /** Destino do link para a página do processo. */
      id: string;
      numeroPrecatorio: string;
      entidadeDevedora: string | null;
      situacao: string | null;
      /** O estágio do crédito. Sem ele a Consulta chamava tudo de precatório. */
      fase: FaseProcesso;
      /** Extraído de TEXTO, não de campo. Só existe nos pré-precatórios. */
      valorIndicativo: string | null;
    };
  }[];
}

export interface Pagina<T> {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: T[];
}

// ── Fila e consumo ──
export interface EstadoFila {
  /**
   * `false` quando o Redis não respondeu.
   *
   * Os contadores vêm ZERADOS nesse caso, e é por isso que este campo existe:
   * "0 aguardando" é indistinguível de "fila vazia", e quem olhasse o painel
   * concluiria que o enriquecimento terminou. A tela precisa dizer que não
   * sabe, em vez de dizer zero.
   *
   * Opcional para não quebrar leitura de resposta antiga em cache.
   */
  disponivel?: boolean;
  /** Preenchido quando `disponivel` é falso. */
  motivo?: string;
  aguardando: number; ativos: number; concluidos: number; falhos: number; atrasados: number;
}
export interface Consumo {
  provider: string; teto: number; usadas: number; restantes: number; percentual: number;
}
export interface Previsao {
  quantidade: number; elegiveis: number; tetoRestante: number;
  custoEstimado: number | null; provider: string; dryRun: boolean; observacao?: string;
}
export interface Importacao {
  id: string; arquivoNome: string; status: string; totalLinhas: number;
  /** Quantas linhas o worker já processou. Só se move enquanto a carga roda. */
  processadas: number;
  sucesso: number; falhas: number; criadoEm: string; concluidoEm: string | null;
  user: { nome: string; email: string };
}
export interface LinhaErro {
  numeroLinha: number; cpf: string | null; numeroProcesso: string | null; mensagemErro: string;
}

// ── Auditoria (somente leitura; datas chegam como ISO string) ──
export interface ConsultaAuditoria {
  id: string;
  tipo: 'CPF' | 'NOME' | 'PROCESSO' | 'CIDADE' | 'UF' | string;
  /**
   * O texto digitado, ou NULO quando já passou do prazo de retenção.
   *
   * Nulo significa "o conteúdo foi descartado", nunca "buscou vazio": a linha só
   * nasce quando há termo. O resto — quem, quando, qual CPF, quantos resultados
   * — continua inteiro, porque é ele que sustenta a prestação de contas.
   */
  termo: string | null;
  cpfConsultado: string | null;
  totalResultados: number;
  /** Se o contato do titular foi de fato exibido — é o que a LGPD cobra. */
  contatoExibido: boolean;
  ip: string | null;
  userAgent: string | null;
  criadoEm: string;
  user: { id: string; nome: string; email: string; papel: 'ADMIN' | 'OPERADOR' | 'CLIENTE' };
}

/** A lista de consultas usa o mesmo envelope de `Pagina<T>` já definido acima. */
export interface ResumoAuditoria {
  periodo: { de: string; ate: string };
  totalConsultas: number;
  consultasComContato: number;
  usuariosDistintos: number;
  cpfsDistintos: number;
  /** Um ponto por dia, inclusive os zerados — o gráfico não pode pular dia. */
  serieDiaria: { data: string; total: number }[];
}

export interface EnriquecimentoAuditoria {
  id: string;
  provider: string;
  versao: number;
  status: 'SUCESSO' | 'SEM_DADOS' | 'ERRO';
  mensagemErro: string | null;
  custoCreditos: string | null;
  requestId: string | null;
  latenciaMs: number | null;
  criadoEm: string;
}

export interface TrilhaCpf {
  cpf: string;
  geradoEm: string;
  pessoa: {
    id: string;
    nome: string;
    statusEnriquecimento: 'PENDENTE' | 'SINCRONIZADO' | 'SEM_DADOS' | 'ERRO';
    ultimaSincronizacao: string | null;
  } | null;
  totalConsultas: number;
  /** true = a trilha real é maior que a lista devolvida. Exiba o aviso. */
  truncado: boolean;
  consultas: ConsultaAuditoria[];
  enriquecimentos: EnriquecimentoAuditoria[];
}

// ── Processo (CRM) ──
export type TipoEventoProcesso =
  | 'IMPORTADO'
  | 'DADO_ATUALIZADO'
  | 'ENRIQUECIDO'
  | 'STATUS_ALTERADO'
  | 'OBSERVACAO'
  | 'ACESSO_CLIENTE';

export type PapelProcessual =
  | 'REQUERENTE'
  | 'EXEQUENTE'
  | 'CESSIONARIO'
  | 'ESPOLIO'
  | 'OUTRO';

/**
 * Um evento da linha do tempo.
 *
 * ⚠ OS CAMPOS OPCIONAIS NÃO SÃO "ÀS VEZES NULOS" — ELES NÃO EXISTEM NA RESPOSTA
 * DO CLIENTE. A projeção de cliente em `carteira.service.ts` remonta o evento
 * com quatro chaves só (id, tipo, descricao, criadoEm); o diff e a procedência
 * são operação interna e não saem.
 *
 * Estavam declarados como obrigatórios, e a mentira custou caro: `tsc` passava
 * e a tela quebrava em runtime com "Cannot read properties of undefined
 * (reading 'length')" no `camposAlterados`, para TODO cliente em TODO processo
 * — todo processo tem ao menos o evento IMPORTADO. Opcional aqui é o que faz o
 * compilador cobrar o tratamento em cada ponto de uso.
 */
export interface EventoProcesso {
  id: string;
  tipo: TipoEventoProcesso;
  /** Frase pronta, em pt-BR, já com os rótulos legíveis dos campos. */
  descricao: string;
  /** Nomes dos campos que mudaram. Vazio em IMPORTADO. Ausente para o cliente. */
  camposAlterados?: string[];
  /**
   * `{ campo: { de, para } }`. Pode conter MENOS chaves que `camposAlterados`:
   * campo marcado como sigiloso no motor de diff (hoje `valor`) registra que
   * mudou, mas nunca quanto — a timeline é append-only e a quantia devida a um
   * titular identificável não pode entrar num log que não se consegue apagar.
   *
   * Ausente para o cliente.
   */
  detalhe?: Record<string, { de: string | number | null; para: string | number | null }> | null;
  /** Ausente para o cliente: de qual importação veio é operação interna. */
  importacaoId?: string | null;
  criadoEm: string;
}

export interface ParteProcesso {
  papel: PapelProcessual;
  valorIndividual: string | null;
  observacoes: string | null;
  pessoa: {
    id: string;
    cpf: string;
    nome: string;
    /**
     * ⚠ AUSENTE na resposta do cliente — não é o mesmo que PENDENTE.
     *
     * O cliente vê o CONTATO; como ele chegou lá, não. A palavra
     * "enriquecimento" e o provedor que a produz não aparecem para quem assina,
     * e a projeção em `carteira.service.ts` remonta a pessoa sem estes dois
     * campos de propósito.
     *
     * Declarados obrigatórios, derrubavam a página do processo para TODO
     * cliente: `STATUS[undefined]` é `undefined`, e o `.cor` logo em seguida
     * lançava TypeError.
     */
    statusEnriquecimento?: StatusEnriquecimento;
    /** Ausente para o cliente, pelo mesmo motivo. */
    ultimaSincronizacao?: string | null;
    dataNascimento: string | null;
    obito: boolean;
    telefones: {
      ddd: string | null;
      numero: string;
      tipo: 'MOVEL' | 'FIXO' | 'DESCONHECIDO';
      whatsapp: boolean | null;
    }[];
    emails: { endereco: string }[];
    enderecos: {
      logradouro: string | null;
      numero: string | null;
      complemento: string | null;
      bairro: string | null;
      cidade: string | null;
      uf: string | null;
      cep: string | null;
    }[];
  };
}

export type Prioridade = 'BAIXA' | 'NORMAL' | 'ALTA' | 'URGENTE';

export interface Etiqueta {
  id: string;
  nome: string;
  /** Token do tema (marca-ciano, ok, alerta...), nunca hexadecimal. */
  cor: string;
}

export interface EtiquetaComUso extends Etiqueta {
  _count: { processos: number };
}

export interface Anotacao {
  id: string;
  texto: string;
  fixada: boolean;
  criadoEm: string;
  editadoEm: string;
  autor: { id: string; nome: string };
}

export type TipoTarefa = 'TAREFA' | 'FOLLOW_UP';

export interface Tarefa {
  id: string;
  tipo: TipoTarefa;
  titulo: string;
  /**
   * Prazo. Coluna DATE no banco, então chega sempre como meia-noite UTC
   * ("2026-07-25T00:00:00.000Z"). Os 10 primeiros caracteres SÃO o dia — não
   * passe por `new Date()` para exibir ou comparar, ou o fuso do leitor
   * devolve o dia anterior.
   */
  prazo: string | null;
  /** Instante da conclusão. `null` = ainda pendente. */
  concluidaEm: string | null;
  criadoEm: string;
  responsavel: { id: string; nome: string } | null;
  criadoPor: { id: string; nome: string };
}

/** Tarefa vista de fora do processo: precisa carregar de qual processo é. */
export interface TarefaDaAgenda extends Tarefa {
  processo: {
    id: string;
    numeroPrecatorio: string;
    entidadeDevedora: string | null;
    prioridade: Prioridade;
  };
}

export interface Agenda {
  /** Só as ABERTAS, do prazo mais apertado ao mais folgado, sem prazo por último. */
  tarefas: TarefaDaAgenda[];
  total: number;
  /** true = há mais pendências abertas do que as devolvidas. */
  truncado: boolean;
}

export interface MembroEquipe {
  id: string;
  nome: string;
  papel: 'ADMIN' | 'OPERADOR';
}

/**
 * O nome da planilha bate com o de quem realmente tem o CPF?
 *
 * Só existe para os pré-precatórios, onde o CPF é extraído do TEXTO da
 * publicação — dígito verificador válido prova que o número é bem formado, não
 * que seja daquele credor.
 */
export type ConferenciaNome = 'NAO_CONFERIDO' | 'CONFERE' | 'DIVERGE';

/**
 * O ESTÁGIO do crédito no caminho até virar dinheiro.
 *
 * A ordem é cronológica. Os quatro primeiros vêm dos pré-precatórios; o último é
 * o que a carteira inteira era até 04/09/2026 — precatório na fila orçamentária,
 * que é o único estágio com exigibilidade formada.
 */
export type FaseProcesso =
  | 'TRANSITO_EM_JULGADO'
  | 'CALCULOS_HOMOLOGADOS'
  | 'REQUISITORIO_EXPEDIDO'
  | 'PRECATORIO_AUTUADO'
  | 'PRECATORIO_EXPEDIDO';

export interface ProcessoDetalhe {
  id: string;
  numeroPrecatorio: string;
  numeroOriginario: string | null;
  numeroRequisitorio: string | null;
  tribunal: { sigla: string; nome: string; esfera: string };
  vara: string | null;
  entidadeDevedora: string | null;
  natureza: string | null;
  situacao: string | null;
  valor: string | null;
  fase: FaseProcesso;
  /** Extraído de TEXTO, não de campo estruturado. A tela precisa dizer isso. */
  valorIndicativo: string | null;
  dataAutuacao: string | null;
  exercicio: number | null;
  fonte: string | null;
  criadoEm: string;
  editadoEm: string;
  partes: ParteProcesso[];
  eventos: EventoProcesso[];
  totalEventos: number;
  /** true = a timeline real é maior que `eventos`. Exiba o aviso. */
  eventosTruncados: boolean;

  // ── Estado do CRM: mantido pela equipe, nunca pela planilha ──
  prioridade: Prioridade;
  responsavel: { id: string; nome: string } | null;
  /** Onde o processo está no funil comercial DESTA organização. */
  estagio: Estagio;
  /** Quando o estágio mudou — é daqui que sai "parado há N dias". */
  estagioEm: string | null;
  /** Só vem preenchido em PERDIDO. */
  motivoPerda: string | null;
  /** Última tentativa de contato. `null` = ninguém tocou neste processo. */
  ultimoContatoEm: string | null;
  etiquetas: Etiqueta[];
  /** Fixadas primeiro, depois da mais recente para a mais antiga. */
  anotacoes: Anotacao[];
  /** Pendentes primeiro (prazo mais apertado no topo, sem prazo por último). */
  tarefas: Tarefa[];
}

// ── Funil comercial ──

/** O ciclo de um precatório: chega, liga-se, propõe-se, fecha ou perde. */
export type Estagio = 'NOVO' | 'EM_CONTATO' | 'PROPOSTA' | 'FECHADO' | 'PERDIDO';
export type CanalContato = 'TELEFONE' | 'WHATSAPP' | 'EMAIL' | 'PRESENCIAL' | 'OUTRO';
export type ResultadoContato =
  | 'ATENDEU'
  | 'NAO_ATENDEU'
  | 'NUMERO_ERRADO'
  | 'RECADO'
  | 'RECUSOU';

export interface Contato {
  id: string;
  canal: CanalContato;
  resultado: ResultadoContato;
  observacao: string | null;
  criadoEm: string;
  autor: { id: string; nome: string };
}

export interface Funil {
  total: number;
  NOVO: number;
  EM_CONTATO: number;
  PROPOSTA: number;
  FECHADO: number;
  PERDIDO: number;
  /** Quem nunca recebeu uma tentativa — o número que diz se a carteira está
      sendo TRABALHADA, e não apenas triada. */
  semContato: number;
  /**
   * Quem MUDOU de estágio na janela — e não quantos estão nele.
   *
   * Conta uma vez por processo, no estágio de HOJE: quem virou proposta no dia
   * 5 e fechou no dia 20 aparece em FECHADO. O banco guarda o último carimbo,
   * não a trajetória — por isso a tela diz "movimentaram", e não "viraram".
   */
  movimento: {
    dias: number;
    /** Desde quando há registro. A tela imprime isto em vez de um zero solto. */
    desde: string;
    NOVO: number;
    EM_CONTATO: number;
    PROPOSTA: number;
    FECHADO: number;
    PERDIDO: number;
  };
}


/** Uma safra: os N processos que entraram num ciclo, e onde estão hoje. */
export interface Safra {
  competencia: string;
  /** O mês corrente ainda está acontecendo — a tela marca, para não parecer queda. */
  parcial: boolean;
  /** Quantos o plano previa para o ciclo. */
  alvo: number;
  /** Quantos de fato entraram. */
  liberados: number;
  /** Quantos DESSA safra caem no lote que a tela mostra. */
  noRecorte: number;
  NOVO: number;
  EM_CONTATO: number;
  PROPOSTA: number;
  FECHADO: number;
  PERDIDO: number;
}

export interface PerdaEscrita {
  processoId: string;
  numeroPrecatorio: string;
  motivo: string;
  quando: string | null;
}

// ── Negociacao ──

export type Modalidade = 'CESSAO' | 'HONORARIOS';
export type OrigemProposta = 'ESCRITORIO' | 'TITULAR';
export type StatusProposta =
  | 'RASCUNHO'
  | 'ENVIADA'
  | 'ACEITA'
  | 'RECUSADA'
  | 'SUBSTITUIDA'
  | 'CANCELADA';
export type QuemPaga = 'ESCRITORIO' | 'TITULAR';

/**
 * Uma RODADA de negociacao.
 *
 * Todo dinheiro vem como TEXTO:  em JSON e float de dupla precisao, e
 * centavo em conta encadeada nao sobrevive — a conta encadeada aqui e o desagio.
 */
export interface Proposta {
  id: string;
  rodada: number;
  origem: OrigemProposta;
  modalidade: Modalidade;
  status: StatusProposta;
  /** Base CONGELADA no dia da rodada. */
  baseValor: string | null;
  baseOrigem: 'PARTE_UNICA' | 'SOMA_DAS_PARTES' | 'MANUAL' | null;
  valorProposto: string | null;
  honorarioPercentual: string | null;
  custasEstimadas: string | null;
  custasPorContaDe: QuemPaga;
  validaAte: string | null;
  observacao: string | null;
  enviadaEm: string | null;
  respondidaEm: string | null;
  encerradaEm: string | null;
  criadoEm: string;
  autor: { id: string; nome: string };
  /** CALCULADOS, nunca gravados: guardar criaria duas verdades. */
  desagioPercentual: string | null;
  liquidoAoTitular: string | null;
}

export interface Negociacao {
  /** A base ATUAL do processo — para a tela avisar quando ela mudou. */
  baseAtual: string | null;
  baseOrigemAtual: string | null;
  viva: Proposta | null;
  aceita: Proposta | null;
  rodadas: Proposta[];
}


/**
 * O CONTEUDO DA FOLHA.
 *
 * O bloco  e OPCIONAL no tipo, e isso e a trava: quem consome precisa
 * checar antes de tocar na margem. Na folha do titular ele nao vem — nao vem
 * nulo, nao vem vazio: nao existe.
 */
export interface FolhaDaProposta {
  escritorio: { nome: string; cnpj: string | null };
  precatorio: {
    numero: string;
    numeroOriginario: string | null;
    tribunal: string;
    entidadeDevedora: string | null;
    exercicio: number | null;
    /** O estágio, IMPRESSO. Ver a nota no select de `negociacao.service`. */
    fase: FaseProcesso;
  };
  titulares: { nome: string; cpf: string; valorIndividual: string | null }[];
  proposta: {
    rodada: number;
    modalidade: Modalidade;
    status: StatusProposta;
    baseValor: string | null;
    baseOrigem: string | null;
    valorProposto: string | null;
    honorarioPercentual: string | null;
    custasEstimadas: string | null;
    custasPorContaDe: QuemPaga;
    liquidoAoTitular: string | null;
    validaAte: string | null;
    emitidaEm: string;
  };
  destino: 'TITULAR' | 'INTERNO';
  /** SÓ na folha interna. O deságio é o lucro do escritório. */
  interno?: {
    desagioPercentual: string | null;
    observacao: string | null;
    autor: { id: string; nome: string };
    historico: { rodada: number; origem: string; status: string; valorProposto: string | null }[];
  };
}

/** Uma parcela do que o escritório paga ao titular. */
export interface Parcela {
  id: string;
  numero: number;
  /** Número 0 — a quantia que sai no ato. */
  entrada: boolean;
  valor: string;
  vencimento: string;
  pagoEm: string | null;
  pagoPor: { id: string; nome: string } | null;
  /** CALCULADA na leitura. Não dispara nada: não bloqueia, não cobra, não suspende. */
  vencida: boolean;
}

export interface Cronograma {
  /** A soma das parcelas, para a tela confrontá-la com o valor acordado. */
  total: string;
  parcelas: Parcela[];
}

export const negociacao = {
  resumo: (processoId: string) =>
    api<Negociacao>(`/carteira/processos/${processoId}/negociacao`),

  criar: (
    processoId: string,
    dados: {
      modalidade: Modalidade;
      origem?: OrigemProposta;
      valorProposto?: string;
      honorarioPercentual?: string;
      custasEstimadas?: string;
      custasPorContaDe?: QuemPaga;
      validaAte?: string;
      observacao?: string;
    },
  ) =>
    api<Proposta>(`/carteira/processos/${processoId}/negociacao`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),

  ajustar: (processoId: string, propostaId: string, dados: Record<string, unknown>) =>
    api<Proposta>(`/carteira/processos/${processoId}/negociacao/${propostaId}`, {
      method: 'PATCH',
      body: JSON.stringify(dados),
    }),

  enviar: (processoId: string, propostaId: string) =>
    api<Proposta>(`/carteira/processos/${processoId}/negociacao/${propostaId}/enviar`, {
      method: 'POST',
    }),

  decidir: (processoId: string, propostaId: string, decisao: 'ACEITA' | 'RECUSADA' | 'CANCELADA') =>
    api<Proposta>(`/carteira/processos/${processoId}/negociacao/${propostaId}/decisao`, {
      method: 'POST',
      body: JSON.stringify({ decisao }),
    }),

  /** O conteudo da folha.  ausente = a do TITULAR, o lado seguro. */
  relatorio: (processoId: string, propostaId: string, destino: 'TITULAR' | 'INTERNO') =>
    api<FolhaDaProposta>(
      `/carteira/processos/${processoId}/negociacao/${propostaId}/relatorio?destino=${destino}`,
    ),
  cronograma: (processoId: string, propostaId: string) =>
    api<Cronograma>(`/carteira/processos/${processoId}/negociacao/${propostaId}/parcelas`),

  gerarCronograma: (
    processoId: string,
    propostaId: string,
    dados: { entrada?: string; parcelas: number; primeiroVencimento: string; intervaloMeses?: number },
  ) =>
    api<Cronograma>(`/carteira/processos/${processoId}/negociacao/${propostaId}/parcelas`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),

  /** Só GESTOR ou ADMIN. Idempotente: o segundo clique não reescreve a data. */
  baixar: (processoId: string, propostaId: string, numero: number) =>
    api<Cronograma & { alterado: boolean }>(
      `/carteira/processos/${processoId}/negociacao/${propostaId}/parcelas/${numero}/baixa`,
      { method: 'POST' },
    ),

  desfazerBaixa: (processoId: string, propostaId: string, numero: number) =>
    api<Cronograma & { alterado: boolean }>(
      `/carteira/processos/${processoId}/negociacao/${propostaId}/parcelas/${numero}/baixa`,
      { method: 'DELETE' },
    ),

  remover: (processoId: string, propostaId: string) =>
    api<{ removida: boolean }>(`/carteira/processos/${processoId}/negociacao/${propostaId}`, {
      method: 'DELETE',
    }),
};
// ── Escrita do CRM ──

// ── Fila de trabalho ──

/** Uma linha da fila: o processo com tudo que decide se ele é o próximo. */
export interface ItemFila {
  id: string;
  numeroPrecatorio: string;
  entidadeDevedora: string | null;
  situacao: string | null;
  valor: string | null;
  fase: FaseProcesso;
  valorIndicativo: string | null;
  /** Sigla, ex.: "TJMG". Sempre presente — todo processo tem tribunal. */
  tribunal: string;
  /* Sem o veredito do CPF: ele saiu da resposta em 20/09/2026, junto com o
     aviso que o desenhava. O recorte por veredito continua existindo, mas é
     resolvido no servidor (ver `FiltrosFila.conferencia`). */
  titular: { id: string; nome: string; cpf: string } | null;
  estagio: Estagio;
  estagioEm: string | null;
  prioridade: Prioridade;
  responsavel: { id: string; nome: string } | null;
  /** `null` = ninguém tocou neste processo ainda. */
  ultimoContatoEm: string | null;
  etiquetas: Etiqueta[];
  tarefasAbertas: number;
  tarefasAtrasadas: number;
}

export interface PaginaFila {
  total: number;
  pagina: number;
  porPagina: number;
  totalPaginas: number;
  itens: ItemFila[];
}

export interface FiltrosFila {
  termo?: string;
  estagio?: Estagio;
  prioridade?: Prioridade;
  /** UUID, ou `nenhum` para os sem responsável. */
  responsavelId?: string;
  etiquetaId?: string;
  semContato?: boolean;
  /** Esfriou: último contato há mais de N dias (7, 15 ou 30). */
  frioDias?: number;
  tarefaAtrasada?: boolean;
  /* ── Os três chips do módulo de pré-precatórios ── */
  /** UMA fase, clicada. O recorte do módulo (as quatro) é da rota. */
  fase?: FaseProcesso;
  esfera?: EsferaTribunal;
  conferencia?: ConferenciaNome;
  pagina?: number;
  porPagina?: number;
}

/** A esfera de justiça do tribunal. `SUPERIOR` existe no banco e não tem processo. */
export type EsferaTribunal = 'FEDERAL' | 'ESTADUAL' | 'TRABALHISTA' | 'SUPERIOR';

/**
 * Os filtros da fila como query string — UMA serialização para as três rotas
 * que os aceitam (`fila`, `pre-precatorios`, `pre-precatorios/resumo`).
 *
 * Só o que está PREENCHIDO vai na query: mandar `estagio=` vazio faria o
 * servidor recusar por valor inválido, e um filtro em branco tem de significar
 * "não filtre". Paginação fica de fora: o resumo não pagina.
 */
function queryDaFila(f: Omit<FiltrosFila, 'pagina' | 'porPagina'>): URLSearchParams {
  const q = new URLSearchParams();
  if (f.termo) q.set('termo', f.termo);
  if (f.estagio) q.set('estagio', f.estagio);
  if (f.prioridade) q.set('prioridade', f.prioridade);
  if (f.responsavelId) q.set('responsavelId', f.responsavelId);
  if (f.etiquetaId) q.set('etiquetaId', f.etiquetaId);
  if (f.semContato) q.set('semContato', 'true');
  if (f.frioDias) q.set('frioDias', String(f.frioDias));
  if (f.tarefaAtrasada) q.set('tarefaAtrasada', 'true');
  if (f.fase) q.set('fase', f.fase);
  if (f.esfera) q.set('esfera', f.esfera);
  if (f.conferencia) q.set('conferencia', f.conferencia);
  return q;
}

export function filaDeTrabalho(f: FiltrosFila, lote?: { tribunal: string; exercicio: number }) {
  const q = queryDaFila(f);
  q.set('pagina', String(f.pagina ?? 1));
  q.set('porPagina', String(f.porPagina ?? 25));
  if (lote) {
    q.set('tribunal', lote.tribunal);
    q.set('exercicio', String(lote.exercicio));
  }
  return api<PaginaFila>(`/carteira/fila?${q}`);
}

/**
 * O módulo de pré-precatórios: a MESMA fila, sem recorte de lote e recortada
 * pelas fases anteriores ao precatório expedido.
 *
 * Sem `lote` na assinatura, e isso é deliberado: pré-precatório não tem
 * exercício orçamentário, então nenhum lote o alcançaria. Aceitar o parâmetro
 * daria a impressão de um recorte que não existe.
 */
export function prePrecatorios(f: FiltrosFila) {
  const q = queryDaFila(f);
  q.set('pagina', String(f.pagina ?? 1));
  q.set('porPagina', String(f.porPagina ?? 25));
  return api<PaginaFila>(`/carteira/pre-precatorios?${q}`);
}

/**
 * Os números em cima da lista do módulo: cartões e chips com contagem.
 *
 * Os três chips ficam FORA do tipo, e não só da serialização: o chip é o
 * recorte da LISTA, e mandá-lo aqui zeraria os outros no instante em que um
 * fosse clicado (o servidor os ignora de qualquer forma; recusar no tipo faz o
 * compilador lembrar quem tentar). Mesma regra do `crm.funil` com `estagio`.
 */
export interface ResumoPrePrecatorios {
  total: number;
  /** Soma do valor INDICATIVO — extraído de texto, não apurado. */
  valorIndicativo: string;
  /** De quantos processos a soma veio. */
  comValorIndicativo: number;
  tribunais: number;
  porFase: { fase: FaseProcesso; quantidade: number }[];
  porEsfera: { esfera: EsferaTribunal; quantidade: number }[];
  /**
   * Processos com AO MENOS uma parte naquele veredito — o mesmo critério do chip.
   * AUSENTE para o assinante: o servidor não manda o agregado de CPF a ele.
   */
  porConferencia?: { conferencia: ConferenciaNome; quantidade: number }[];
}

export function resumoPrePrecatorios(
  f: Omit<FiltrosFila, 'fase' | 'esfera' | 'conferencia' | 'pagina' | 'porPagina'>,
) {
  const q = queryDaFila(f);
  const s = q.toString();
  return api<ResumoPrePrecatorios>(`/carteira/pre-precatorios/resumo${s ? `?${s}` : ''}`);
}

export interface ResultadoLoteCrm {
  pedidos: number;
  aplicados: number;
  /** Quantos de fato mudaram de valor — o resto já estava como se pediu. */
  alterados: number;
  /** Ids que a seleção trazia e que não são (mais) visíveis. */
  ignorados: number;
}

export const crm = {
  acaoEmLote: (dados: {
    processoIds: string[];
    estagio?: Estagio;
    /** Só é gravado quando o estágio pedido é PERDIDO. */
    motivoPerda?: string;
    prioridade?: Prioridade;
    /** `null` REMOVE o responsável; ausente não mexe. */
    responsavelId?: string | null;
    etiquetaIds?: string[];
  }) =>
    api<ResultadoLoteCrm>('/carteira/processos/lote', {
      method: 'PATCH',
      body: JSON.stringify(dados),
    }),

  definirEstagio: (processoId: string, estagio: Estagio, motivoPerda?: string) =>
    api<{ estagio: Estagio; alterado: boolean }>(`/carteira/processos/${processoId}/estagio`, {
      method: 'PATCH',
      body: JSON.stringify({ estagio, ...(motivoPerda ? { motivoPerda } : {}) }),
    }),

  registrarContato: (
    processoId: string,
    dados: { canal?: CanalContato; resultado: ResultadoContato; observacao?: string },
  ) =>
    api<{ contato: Contato; estagio: Estagio }>(`/carteira/processos/${processoId}/contatos`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),

  contatos: (processoId: string) => api<Contato[]>(`/carteira/processos/${processoId}/contatos`),

  /* O lote E os filtros vão juntos: sem o lote o funil contaria a carteira
     inteira enquanto a fila mostra um tribunal/exercício; sem os filtros, com
     "responsável = Ana" ligado, o chip diria 3.000 sobre uma lista de 12.
     Nos dois casos os números na mesma tela não fechariam. */
  funil: (
    lote?: { tribunal: string; exercicio: number },
    /*  fora do TIPO, e não só da serialização: o chip é o recorte da
       LISTA, e mandá-lo aqui zeraria os outros quatro no instante em que um
       fosse clicado. Recusar no tipo faz o compilador lembrar quem tentar. */
    filtros?: Omit<FiltrosFila, 'estagio' | 'pagina' | 'porPagina'>,
  ) => {
    const q = new URLSearchParams();
    if (lote) {
      q.set('tribunal', lote.tribunal);
      q.set('exercicio', String(lote.exercicio));
    }
    if (filtros) {
      if (filtros.termo) q.set('termo', filtros.termo);
      if (filtros.prioridade) q.set('prioridade', filtros.prioridade);
      if (filtros.responsavelId) q.set('responsavelId', filtros.responsavelId);
      if (filtros.etiquetaId) q.set('etiquetaId', filtros.etiquetaId);
      if (filtros.semContato) q.set('semContato', 'true');
      if (filtros.frioDias) q.set('frioDias', String(filtros.frioDias));
      if (filtros.tarefaAtrasada) q.set('tarefaAtrasada', 'true');
      /* `estagio` NÃO vai: o chip é o recorte da LISTA. Mandá-lo aqui zeraria os
         outros quatro chips no instante em que um fosse clicado, e o operador
         perderia a referência de onde está. */
    }
    const s = q.toString();
    return api<Funil>('/carteira/funil' + (s ? `?${s}` : ''));
  },

  /* A safra é do CICLO, não do lote: o total de um mês não muda quando se troca
     o tribunal em foco. O lote entra só para dizer quantos daquela safra a tela
     está mostrando — o campo `noRecorte`. */
  safras: (lote?: { tribunal: string; exercicio: number }, meses = 12) => {
    const q = new URLSearchParams({ meses: String(meses) });
    if (lote) {
      q.set('tribunal', lote.tribunal);
      q.set('exercicio', String(lote.exercicio));
    }
    return api<Safra[]>(`/carteira/funil/safras?${q.toString()}`);
  },

  perdas: (lote?: { tribunal: string; exercicio: number }, limite = 50) => {
    const q = new URLSearchParams({ limite: String(limite) });
    if (lote) {
      q.set('tribunal', lote.tribunal);
      q.set('exercicio', String(lote.exercicio));
    }
    return api<PerdaEscrita[]>(`/carteira/funil/perdas?${q.toString()}`);
  },

  criarAnotacao: (processoId: string, texto: string) =>
    api<Anotacao>(`/carteira/processos/${processoId}/anotacoes`, {
      method: 'POST',
      body: JSON.stringify({ texto }),
    }),

  editarAnotacao: (processoId: string, anotacaoId: string, dados: { texto?: string; fixada?: boolean }) =>
    api<Anotacao>(`/carteira/processos/${processoId}/anotacoes/${anotacaoId}`, {
      method: 'PATCH',
      body: JSON.stringify(dados),
    }),

  removerAnotacao: (processoId: string, anotacaoId: string) =>
    api<{ removida: boolean }>(`/carteira/processos/${processoId}/anotacoes/${anotacaoId}`, {
      method: 'DELETE',
    }),

  /** `prazo` vai como "AAAA-MM-DD" — a API recusa ISO com hora, de propósito. */
  criarTarefa: (
    processoId: string,
    dados: { titulo: string; tipo?: TipoTarefa; prazo?: string | null; responsavelId?: string | null },
  ) =>
    api<Tarefa>(`/carteira/processos/${processoId}/tarefas`, {
      method: 'POST',
      body: JSON.stringify(dados),
    }),

  editarTarefa: (
    processoId: string,
    tarefaId: string,
    dados: {
      titulo?: string;
      tipo?: TipoTarefa;
      prazo?: string | null;
      responsavelId?: string | null;
      concluida?: boolean;
    },
  ) =>
    api<Tarefa>(`/carteira/processos/${processoId}/tarefas/${tarefaId}`, {
      method: 'PATCH',
      body: JSON.stringify(dados),
    }),

  /** Fila de trabalho: minhas tarefas abertas + as que ninguém assumiu. */
  minhasTarefas: () => api<Agenda>('/carteira/tarefas/minhas'),

  removerTarefa: (processoId: string, tarefaId: string) =>
    api<{ removida: boolean }>(`/carteira/processos/${processoId}/tarefas/${tarefaId}`, {
      method: 'DELETE',
    }),

  definirPrioridade: (processoId: string, prioridade: Prioridade) =>
    api<{ prioridade: Prioridade; alterado: boolean }>(
      `/carteira/processos/${processoId}/prioridade`,
      { method: 'PATCH', body: JSON.stringify({ prioridade }) },
    ),

  /** `null` remove o responsável — é um gesto explícito, não a ausência do campo. */
  definirResponsavel: (processoId: string, responsavelId: string | null) =>
    api<{ responsavelId: string | null; alterado: boolean }>(
      `/carteira/processos/${processoId}/responsavel`,
      { method: 'PATCH', body: JSON.stringify({ responsavelId }) },
    ),

  /** Substitui o conjunto INTEIRO — a última escrita vence por completo. */
  definirEtiquetas: (processoId: string, etiquetaIds: string[]) =>
    api<{ etiqueta: Etiqueta }[]>(`/carteira/processos/${processoId}/etiquetas`, {
      method: 'PUT',
      body: JSON.stringify({ etiquetaIds }),
    }),

  listarEtiquetas: () => api<EtiquetaComUso[]>('/carteira/etiquetas'),

  /** Idempotente: nome repetido devolve a etiqueta que já existe. */
  criarEtiqueta: (nome: string, cor?: string) =>
    api<Etiqueta>('/carteira/etiquetas', { method: 'POST', body: JSON.stringify({ nome, cor }) }),

  equipe: () => api<MembroEquipe[]>('/carteira/equipe'),
};

/** Upload usa FormData — não pode ir com Content-Type: application/json. */
/** Projeção do que aconteceria, sem gravar nada. */
export interface SimulacaoImportacao {
  dryRun: true;
  /* `tribunal` é NULO no perfil multi-tribunal — é assim que ele declara que lê
     o tribunal de uma coluna. O tipo dizia `string`, e a tela renderizava o nulo
     como vazio, produzindo um " · Pré-precatórios" com um separador órfão. */
  perfil: { tribunal: string | null; nome: string };
  arquivoJaImportado: { em: string; arquivo: string } | null;
  /** O mesmo arquivo AINDA na fila. Confirmar seria recusado — o aviso evita isso. */
  emAndamento: { em: string; processadas: number; totalLinhas: number } | null;
  totalLinhas: number;
  /**
   * Linhas que NÃO entram por causa de como o radar achou o CPF (o método
   * "rotulado CPF, credor único" acerta 21% das vezes). Já estão FORA de
   * `pessoas`, `processos` e `seriamEnfileiradas`. Zero fora do radar.
   */
  recusadasPeloMetodo: { total: number; motivo: string | null };
  pessoas: { distintas: number; novas: number; existentes: number };
  processos: { distintos: number; novos: number };
  seriamEnfileiradas: number;
  problemas: { linha: number; motivo: string }[];
  totalProblemas: number;
  /** Onde os processos vão cair. Última chance de ver que é o lugar errado. */
  destino: { tribunal: string; exercicio: number | null };
}

/**
 * O que o POST devolve agora: um RECIBO, não um resultado.
 *
 * Desde o B5 a rota só valida e enfileira — o trabalho roda no worker, e os
 * números da carga chegam depois, por `estadoImportacao`. A resposta é 202.
 */
export interface ReciboImportacao {
  importacaoId: string;
  status: 'RECEBIDA';
  totalLinhas: number;
  /* Multi-tribunal devolve `{ tribunal: 'da planilha', exercicio: null }`. */
  destino: { tribunal: string; exercicio: number | null };
}

/**
 * Um perfil de leitura de planilha, como a tela o oferece.
 *
 * ── POR QUE A TELA PRECISA DESTA LISTA ──
 *
 * O modo multi-tribunal é escolhido por PERFIL, não por tribunal — e o id do
 * perfil é gerado pela migration com `gen_random_uuid()`. Cravá-lo no front
 * quebraria calado no dia em que ele fosse recriado, e simplesmente não
 * existiria num banco novo.
 */
export interface PerfilDeImportacao {
  id: string;
  nome: string;
  /** `null` = o tribunal vem de uma coluna da planilha. */
  tribunal: string | null;
  multiTribunal: boolean;
}

export const perfisDeImportacao = () => api<PerfilDeImportacao[]>('/importacao/perfis');

/**
 * PARA ONDE A CARGA VAI — nas duas formas que existem, e só nessas.
 *
 * União discriminada de propósito: com dois campos opcionais soltos, uma tela
 * nova poderia mandar tribunal E perfil juntos, ou nenhum dos dois. Aqui o
 * compilador exige exatamente um dos modos, e a API recusa a combinação com 400
 * — as duas defesas dizem a mesma coisa, e a de tipo fala antes.
 */
export type DestinoImportacao =
  | { modo: 'TRIBUNAL'; tribunal: string; exercicio: number }
  | { modo: 'PERFIL'; perfilId: string };

/** O andamento e o resultado de uma importação. */
export interface EstadoImportacao {
  id: string;
  arquivoNome: string;
  status: string;
  mensagemErro: string | null;
  totalLinhas: number;
  processadas: number;
  sucesso: number;
  falhas: number;
  ignoradas: number;
  /** Reimportar a MESMA planilha dá criados=0 e atualizados=0. É como o operador
      vê que o arquivo não mexeu em nada, sem conferir processo a processo. */
  processosCriados: number;
  processosAtualizados: number;
  processosInalterados: number;
  enfileirados: number;
  criadoEm: string;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  destino: { tribunal: string; exercicio: number } | null;
  /** A API diz quando parar de consultar, em vez de cada tela enumerar os status. */
  terminou: boolean;
}

export const estadoImportacao = (id: string) => api<EstadoImportacao>(`/importacao/${id}`);

/**
 * O fôlego das assinaturas: quantos ciclos de base ainda restam por cliente.
 *
 * A base é finita e o cliente paga todo mês. Quando o poço dele seca, a
 * assinatura segue ATIVA e a fatura segue saindo — é o único alerta do painel em
 * que o dinheiro já está errado, e não apenas o trabalho acumulado.
 */
export interface FolegoCliente {
  organizationId: string;
  nome: string;
  status: 'ATIVA' | 'INADIMPLENTE';
  alvoPorCiclo: number;
  jaRecebeu: number;
  restantesNaBase: number;
  ciclosRestantes: number;
  /** ESGOTADA: cobra sem entregar HOJE. ULTIMO_CICLO: o próximo já vem incompleto. */
  situacao: 'ESGOTADA' | 'ULTIMO_CICLO' | 'PERTO_DO_FIM' | 'OK';
}

export interface Folego {
  naBase: number;
  clientes: FolegoCliente[];
  emAlerta: number;
}

export const folegoDasAssinaturas = () => api<Folego>('/distribuicao/folego');

export async function enviarPlanilha(
  arquivo: File,
  destino: DestinoImportacao,
): Promise<ReciboImportacao>;
export async function enviarPlanilha(
  arquivo: File,
  destino: DestinoImportacao,
  dryRun: true,
): Promise<SimulacaoImportacao>;
export async function enviarPlanilha(
  arquivo: File,
  destino: DestinoImportacao,
  dryRun = false,
): Promise<ReciboImportacao | SimulacaoImportacao> {
  const fd = new FormData();
  fd.append('arquivo', arquivo);
  /* Destino OBRIGATÓRIO na assinatura: com ele opcional, esquecer de passá-lo
     numa tela nova mandaria a planilha para o tribunal padrão em silêncio.
     E os dois modos NUNCA viajam juntos — a API responde 400 se receber os
     dois, então mandá-los seria pedir uma recusa. */
  const q = new URLSearchParams(
    destino.modo === 'PERFIL'
      ? { perfilId: destino.perfilId }
      : { tribunal: destino.tribunal, exercicio: String(destino.exercicio) },
  );
  if (dryRun) q.set('dryRun', 'true');

  /* Multipart não pode passar por `api()`: ela fixa Content-Type JSON, e o
     boundary do FormData só é montado pelo navegador quando esse cabeçalho é
     OMITIDO. Por isso o 401 é tratado aqui — mas chamando o MESMO
     `renovarUmaVez()`, e não um refresh próprio: um upload concorrente com o
     painel dispararia a segunda renovação que o mutex existe para impedir, e o
     backend revogaria a família inteira por reuso.

     O modo de falha que isto elimina: sem renovação, bastava o access expirar
     (15 min) para TODA importação morrer com um "Unauthorized" cru — e morrer
     no "Importar de verdade", depois de o operador já ter lido a simulação e
     decidido gravar. O pior momento possível para a sessão acabar.

     Reenviar é seguro: o 401 vem do guard, antes de o handler abrir transação,
     então a tentativa recusada não gravou nada. E o mesmo FormData serve às
     duas chamadas — cada fetch o serializa de novo. */
  const enviar = (token: string | null) =>
    fetch(`${API}/v1/importacao?${q}`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    });

  let r = await enviar(tokenDeAcesso());

  if (r.status === 401) {
    const renovado = await renovarUmaVez();
    if (!renovado) {
      irParaLogin();
      throw new ErroApi(401, 'Sessão expirada');
    }
    r = await enviar(renovado);

    /* Mesmo bloco do `api()`: renovou e ainda assim foi recusado significa que
       a sessão morreu, e não que o upload falhou. Sem isto, o operador que
       acabou de ler a simulação veria "Unauthorized" cru e não saberia que
       bastava entrar de novo. */
    if (r.status === 401) {
      const corpo = await r.json().catch(() => ({}));
      motivoDaQueda ??= typeof corpo?.erro === 'string' ? corpo.erro : null;
      irParaLogin();
      throw new ErroApi(401, corpo?.mensagem ?? 'Sessão encerrada', corpo?.erro);
    }
  }

  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroApi(r.status, d?.mensagem ?? `Erro ${r.status}`);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CENTRAL DE PRIVACIDADE — pedidos do titular (LGPD art. 18)
// ─────────────────────────────────────────────────────────────────────────────

export type TipoSolicitacao =
  | 'ACESSO'
  | 'CORRECAO'
  | 'EXCLUSAO'
  | 'OPOSICAO'
  | 'PORTABILIDADE'
  | 'REVISAO_AUTOMATIZADA';

export type StatusSolicitacao = 'RECEBIDA' | 'EM_ANALISE' | 'ATENDIDA' | 'RECUSADA';

export interface SolicitacaoTitular {
  id: string;
  protocolo: string;
  cpf: string;
  nome: string | null;
  email: string | null;
  tipo: TipoSolicitacao;
  status: StatusSolicitacao;
  descricao: string | null;
  resposta: string | null;
  prazoLimite: string | null;
  recebidoEm: string;
  respondidoEm: string | null;
  /** Calculado na leitura — prazo gravado envelhece no banco e passa a mentir. */
  diasParaVencer: number | null;
  vencido: boolean;
}

export const solicitacoesTitular = (status?: StatusSolicitacao) =>
  api<SolicitacaoTitular[]>(`/titular/solicitacoes${status ? `?status=${status}` : ''}`);

export const registrarSolicitacao = (dados: {
  cpf: string;
  tipo: TipoSolicitacao;
  nome?: string;
  email?: string;
  descricao?: string;
}) =>
  api<SolicitacaoTitular>('/titular/solicitacoes', {
    method: 'POST',
    body: JSON.stringify(dados),
  });

export const anotarSolicitacao = (id: string, dados: { status?: StatusSolicitacao; resposta?: string }) =>
  api<SolicitacaoTitular>(`/titular/solicitacoes/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(dados),
  });

/**
 * EXECUTA o pedido. Para EXCLUSAO é irreversível — a tela precisa confirmar
 * antes, e o botão precisa dizer o que vai acontecer.
 */
export const atenderSolicitacao = (id: string) =>
  api<{ protocolo: string; tipo: TipoSolicitacao }>(`/titular/solicitacoes/${id}/atender`, {
    method: 'POST',
  });

// ─────────────────────────────────────────────────────────────────────────────
//  PORTABILIDADE — os dados da própria conta (LGPD art. 18, V)
// ─────────────────────────────────────────────────────────────────────────────

export interface ExportacaoDaConta {
  geradoEm: string;
  organizacao: Record<string, unknown>;
  usuarios: Record<string, unknown>[];
  assinatura: Record<string, unknown> | null;
  /** O que NÃO está no arquivo, dito por extenso — ver o serviço no back. */
  naoIncluido: Record<string, string>;
}

export const exportarMinhaConta = () => api<ExportacaoDaConta>('/minha-conta/exportacao');
