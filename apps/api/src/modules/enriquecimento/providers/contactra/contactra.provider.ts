import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ContextoConsulta,
  EnrichmentProvider,
  PessoaEnriquecida,
  ResultadoEnriquecimento,
  SaudeProvider,
} from '../../domain/enrichment-provider.port';
import { mapearRespostaContactra } from './contactra.mapper';

/**
 * Contactra — consulta de pessoa física por CPF, o produto mais barato do
 * contrato. ("Contactra" é o nome usado nesta versão pública para o bureau de
 * dados contratado.)
 *
 * Contrato da API:
 *   POST /oauth2/token                (Basic, client_credentials)
 *   GET  /v1/pessoas/cpf?finalidade={n}&cpf={cpf}
 *
 * CUSTO — não adicione chamadas a endpoints SECUNDÁRIOS sem decisão explícita:
 * telefones adicionais, pessoas de referência e vínculos são cobrados à parte.
 * Este provider chama SOMENTE a consulta por CPF.
 *
 * A credencial é lida do ConfigService (backend) e nunca sai daqui:
 * o resultado devolvido já vem normalizado, sem token nem headers.
 */
@Injectable()
export class ContactraProvider implements EnrichmentProvider {
  readonly nome = 'CONTACTRA';
  private readonly logger = new Logger(ContactraProvider.name);

  private token: { valor: string; expiraEm: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('CONTACTRA_BASE_URL', '');
  }

  /**
   * Quanto ESTA consulta custa, em reais.
   *
   * A Contactra não devolve preço na resposta — quem sabe o valor é o contrato.
   * Sem isto, `custoCreditos` ficava `undefined` em toda consulta cobrada, e o
   * acumulado (`creditosGastos += custo ?? 0`) somava zero para sempre: o painel
   * mostrava R$ 0,00 enquanto a fatura corria. Só a RECONSULTA, que é grátis,
   * registrava seu zero — o sistema contabilizava exatamente o que não custa.
   */
  private get precoPorConsulta(): number {
    return this.config.get<number>('CONTACTRA_CUSTO_POR_CONSULTA', 0);
  }

  private get configurado(): boolean {
    return Boolean(
      this.baseUrl &&
        this.config.get<string>('CONTACTRA_CLIENT_ID') &&
        this.config.get<string>('CONTACTRA_CLIENT_SECRET'),
    );
  }

  async healthCheck(): Promise<SaudeProvider> {
    if (!this.configurado) {
      return { disponivel: false, detalhe: 'Credenciais da Contactra não configuradas' };
    }
    try {
      await this.obterToken();
      return { disponivel: true };
    } catch (e) {
      return { disponivel: false, detalhe: (e as Error).message };
    }
  }

  /**
   * OAuth2 client_credentials com cache em memória.
   * AJUSTAR (1/3): confirmar URL, grant type e formato da resposta.
   */
  private async obterToken(): Promise<string> {
    if (this.token && this.token.expiraEm > Date.now() + 30_000) {
      return this.token.valor;
    }
    const tokenUrl = this.config.get<string>('CONTACTRA_TOKEN_URL', '');
    const id = this.config.get<string>('CONTACTRA_CLIENT_ID', '');
    const secret = this.config.get<string>('CONTACTRA_CLIENT_SECRET', '');
    if (!tokenUrl || !id || !secret) {
      throw new ServiceUnavailableException('Contactra: credenciais ausentes no ambiente');
    }

    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(this.config.get<number>('CONTACTRA_TIMEOUT_MS', 15_000)),
    });

    if (!r.ok) {
      throw new ServiceUnavailableException(`Contactra: falha ao autenticar (HTTP ${r.status})`);
    }
    const d = (await r.json()) as { access_token: string; expires_in?: number };
    this.token = {
      valor: d.access_token,
      expiraEm: Date.now() + (d.expires_in ?? 3600) * 1000,
    };
    return this.token.valor;
  }

  async consultarPorCpf(cpf: string, ctx?: ContextoConsulta): Promise<ResultadoEnriquecimento> {
    const inicio = Date.now();

    if (!this.configurado) {
      // Falha explícita e honesta: melhor do que devolver dado inventado.
      return {
        status: 'ERRO',
        dadosBrutos: null,
        mensagemErro:
          'Provider Contactra não configurado. Informe URL, endpoints e credenciais no .env.',
        latenciaMs: Date.now() - inicio,
      };
    }

    try {
      const token = await this.obterToken();

      // Endpoint CONFIRMADO por sondagem (19/07/2026).
      // finalidade declara o motivo legal da consulta — exigência de bureau.
      const finalidade = this.config.get<string>('CONTACTRA_ID_FINALIDADE', '1');
      const url =
        `${this.baseUrl.replace(/\/$/, '')}/v1/pessoas/cpf` +
        `?finalidade=${encodeURIComponent(finalidade)}&cpf=${encodeURIComponent(cpf)}`;

      const r = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.config.get<number>('CONTACTRA_TIMEOUT_MS', 15_000)),
      });

      const dadosBrutos: unknown = await r.json().catch(() => null);

      const env = (dadosBrutos ?? {}) as Record<string, any>;
      // A Contactra devolve o protocolo mesmo em erro — é o nosso rastro.
      const protocolo: string | undefined = env?.meta?.protocolo;

      // 400 com "CPF inválido" não é falha nossa nem cobra crédito.
      if (r.status === 400) {
        return {
          status: 'SEM_DADOS',
          dadosBrutos,
          mensagemErro: typeof env.resposta === 'string' ? env.resposta : 'Requisição inválida',
          requestId: protocolo,
          latenciaMs: Date.now() - inicio,
        };
      }
      if (r.status === 404) {
        return { status: 'SEM_DADOS', dadosBrutos, requestId: protocolo, latenciaMs: Date.now() - inicio };
      }
      if (!r.ok) {
        return {
          status: 'ERRO',
          dadosBrutos,
          mensagemErro: `HTTP ${r.status}`,
          requestId: protocolo,
          latenciaMs: Date.now() - inicio,
        };
      }

      const pessoa = mapearRespostaContactra(dadosBrutos);
      return {
        status: pessoa ? 'SUCESSO' : 'SEM_DADOS',
        pessoa: pessoa ?? undefined,
        dadosBrutos,
        requestId: protocolo,
        // reconsulta = true costuma não gerar cobrança nova; o resto é cobrado.
        custoCreditos: env?.meta?.reconsulta === true ? 0 : this.precoPorConsulta,
        latenciaMs: Date.now() - inicio,
      };
    } catch (e) {
      this.logger.warn(`Falha ao consultar CPF (origem=${ctx?.origem ?? '-'}): ${(e as Error).message}`);
      return {
        status: 'ERRO',
        dadosBrutos: null,
        mensagemErro: (e as Error).message,
        latenciaMs: Date.now() - inicio,
      };
    }
  }

}
