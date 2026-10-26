import { Injectable } from '@nestjs/common';
import type {
  BillingProvider,
  CobrancaEmitida,
  EventoNormalizado,
} from '../domain/billing-provider.port';

/**
 * Cobrança MANUAL — o padrão, e o único provedor que existe hoje.
 *
 * A fatura é emitida no nosso banco e o administrador dá baixa quando o dinheiro
 * cai (PIX na conta, transferência, o que for). Não há chamada externa, não há
 * dinheiro movimentado por código, e o ciclo completo (emitir → vencer →
 * inadimplir → suspender → reativar) funciona igual: quem muda com o gateway é
 * QUEM avisa que pagou, não a máquina de estados.
 *
 * É o mesmo espírito do provider `fake` do enriquecimento: o sistema nasce no
 * modo que não gasta nem cobra nada de ninguém, e sair disso é ato explícito.
 */
@Injectable()
export class ManualProvider implements BillingProvider {
  readonly nome = 'MANUAL';

  async registrarCliente(): Promise<string | null> {
    return null;
  }

  async emitirCobranca(): Promise<CobrancaEmitida> {
    /* Sem id externo e sem link: a cobrança vive só aqui. */
    return { idExterno: null, urlPagamento: null };
  }

  async cancelarCobranca(): Promise<void> {
    /* Nada a cancelar fora daqui. */
  }

  /**
   * SEMPRE recusa.
   *
   * No modo manual não existe gateway do outro lado, então nenhum webhook é
   * legítimo — e recusar por princípio é o que impede a rota pública de virar um
   * "marque como pago" aberto ao mundo enquanto nenhum gateway está configurado.
   * Um `true` aqui seria a pior linha do sistema.
   */
  verificarWebhook(): boolean {
    return false;
  }

  interpretarEvento(): EventoNormalizado | null {
    return null;
  }
}
