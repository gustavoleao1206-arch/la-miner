import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { BILLING_PROVIDER } from './domain/billing-provider.port';
import { DistribuicaoModule } from '../distribuicao/distribuicao.module';
import { ManualProvider } from './providers/manual.provider';
import { AsaasProvider } from './providers/asaas.provider';
import { CobrancaService } from './cobranca.service';
import { CobrancaController } from './cobranca.controller';
import { CobrancaAgendada } from './cobranca.agendada';

/**
 * Seleção do provedor de cobrança por configuração (BILLING_PROVIDER), no mesmo
 * desenho do módulo de enriquecimento.
 *
 * Hoje só existe o MANUAL. Um gateway entra como mais um provider aqui, sem que
 * nada do domínio mude — `CobrancaService` só conhece a porta.
 */
@Module({
  /* `DistribuicaoModule` entra porque pagar DISPARA a entrega (ver
     `registrarPagamento`). A seta aponta só nesta direção: distribuição não
     conhece cobrança, então não há ciclo — e o dia em que precisar conhecer,
     o certo é um evento, não um import de volta. */
  imports: [ConfigModule, DistribuicaoModule],
  controllers: [CobrancaController],
  providers: [
    ManualProvider,
    AsaasProvider,
    CobrancaService,
    CobrancaAgendada,
    {
      provide: BILLING_PROVIDER,
      inject: [ConfigService, ManualProvider, AsaasProvider],
      useFactory: (config: ConfigService, manual: ManualProvider, asaas: AsaasProvider) => {
        const escolhido = config.get<string>('BILLING_PROVIDER', 'manual').toLowerCase();
        const log = new Logger('CobrancaModule');

        if (escolhido === 'manual') {
          log.warn(
            'Provider de cobrança: MANUAL — faturas são emitidas no banco e a baixa é ' +
              'dada à mão. Nenhuma cobrança externa é criada.',
          );
          return manual;
        }

        /* FALHA ALTA em vez de cair no manual em silêncio. Configurar um provedor
           inexistente e o sistema seguir cobrando à mão seria o pior dos mundos:
           o operador acreditaria que o gateway está no ar, ninguém receberia link
           de pagamento, e a descoberta viria pelo cliente reclamando que nunca foi
           cobrado. Erro no boot é barato; essa conversa, não. */
        if (escolhido !== 'asaas') {
          throw new Error(
            `BILLING_PROVIDER="${escolhido}" não tem adaptador. Use "manual" ou "asaas".`,
          );
        }

        /* As duas variáveis são exigidas AQUI, no boot, e não na primeira
           cobrança. Sem a chave, o erro apareceria só quando o cron mensal
           rodasse de madrugada; sem o token do webhook, pior ainda — o sistema
           subiria cobrando de verdade e RECUSANDO todo aviso de pagamento, e
           clientes em dia seriam suspensos por inadimplência que não existe. */
        for (const chave of ['ASAAS_API_KEY', 'ASAAS_WEBHOOK_TOKEN']) {
          if (!config.get<string>(chave)) {
            throw new Error(`BILLING_PROVIDER=asaas exige ${chave} no .env.`);
          }
        }

        /* O ambiente sai do PREFIXO da chave, então não há como configurar
           "sandbox" e cobrar de verdade. O aviso é ruidoso de propósito: é a
           única linha do boot que separa dinheiro de brincadeira. */
        if (asaas.producao) {
          log.warn('⚠ Provider de cobrança: ASAAS em PRODUÇÃO — cobranças REAIS serão emitidas.');
        } else if (config.get<string>('NODE_ENV') === 'production') {
          /* ── O ESTADO QUE NÃO PODE VIRAR PAISAGEM ──
             Ambiente de produção rodando com chave de sandbox. É legítimo — a
             validação de ambiente só chega aqui com ASAAS_ACEITAR_SANDBOX=true,
             que é uma declaração escrita à mão — e é exatamente por ser
             legítimo que precisa gritar: o risco não é o engano de hoje, é o
             esquecimento de daqui a três semanas, com o site no ar recebendo
             assinatura de gente que acha que pagou.

             Vai como `error`, não `warn`: em produção o nível de log costuma
             cortar avisos, e este é o único que não pode ser cortado. */
          log.error(
            '⚠⚠ COBRANÇA EM SANDBOX NUM AMBIENTE DE PRODUÇÃO ⚠⚠ ' +
              'NENHUM cliente será cobrado de verdade — as faturas e os links são de mentira. ' +
              'Este estado só existe porque ASAAS_ACEITAR_SANDBOX=true foi declarado. ' +
              'Ao trocar pela chave de produção ($aact_prod_), APAGUE essa variável.',
          );
        } else {
          log.log('Provider de cobrança: ASAAS em sandbox (chave $aact_hmlg_).');
        }
        return asaas;
      },
    },
  ],
  exports: [CobrancaService, BILLING_PROVIDER],
})
export class CobrancaModule {}
