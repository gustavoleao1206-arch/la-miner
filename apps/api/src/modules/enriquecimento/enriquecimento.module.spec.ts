import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EnriquecimentoModule } from './enriquecimento.module';
import { ENRICHMENT_PROVIDER } from './domain/enrichment-provider.port';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * O TESTE QUE FALTAVA — e a razão pela qual ele faltava.
 *
 * Um deploy inteiro morreu aqui: o construtor do `FakeProvider` recusava rodar
 * em produção, mas a `useFactory` deste módulo INJETA os dois providers para
 * escolher entre eles, então o Nest era obrigado a construir o fake. A API não
 * subia nem com `ENRICHMENT_PROVIDER=contactra` — e a mensagem de erro mandava
 * justamente configurar `contactra`, que já estava configurado.
 *
 * Os 459 testes existentes passavam porque NENHUM deles roda com
 * `NODE_ENV=production`: os dois lugares que montam a aplicação de teste
 * importam um arquivo que força `NODE_ENV='test'` antes de qualquer coisa. O
 * `FakeProvider` foi construído centenas de vezes na suíte — a diferença entre
 * verde e produção quebrada era o valor de UMA variável.
 *
 * ── POR QUE ESTE TESTE NÃO MONTA O AppModule INTEIRO ──
 *
 * Seria a cobertura mais ampla, e foi a primeira ideia. Mas com
 * `NODE_ENV=production` o `FilaModule` sai do modo de teste e passa a montar o
 * BullMQ de verdade — e a CI não tem Redis. O portão viraria intermitente, e
 * portão intermitente é pior que portão nenhum: ensina a ignorar vermelho.
 * Aqui a escolha é deliberada: cobrir o módulo onde a decisão de produção
 * realmente mora, de forma determinística e sem serviço externo.
 */

/* PrismaService entra como duplo, num módulo GLOBAL — que é exatamente como ele
   chega ao `TetoConsumoService` na aplicação real. `overrideProvider` não serve
   aqui: ele substitui o que já existe, e o EnriquecimentoModule não declara o
   Prisma em lugar nenhum. Nenhum caso deste arquivo toca o banco: o que se
   testa é a MONTAGEM do módulo. */
const prismaFalso = {} as PrismaService;

@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: prismaFalso }],
  exports: [PrismaService],
})
class PrismaDeMentira {}

async function montarCom(env: Record<string, string>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true, // o .env da máquina não pode mudar o resultado
        load: [() => env],
      }),
      PrismaDeMentira,
      EnriquecimentoModule,
    ],
  }).compile();
}

/** Um ambiente de produção plausível, com as credenciais que o provider real exige. */
const PRODUCAO_COM_CONTACTRA = {
  NODE_ENV: 'production',
  ENRICHMENT_PROVIDER: 'contactra',
  CONTACTRA_BASE_URL: 'https://exemplo.invalido',
  CONTACTRA_CLIENT_ID: 'id-de-teste',
  CONTACTRA_CLIENT_SECRET: 'segredo-de-teste',
  CONTACTRA_TOKEN_URL: 'https://exemplo.invalido/oauth2/token',
};

describe('EnriquecimentoModule — a montagem em produção', () => {
  it('MONTA em produção com a Contactra selecionada', async () => {
    /* É ESTE o caso que o defeito quebrava. Se alguém puser uma trava no
       construtor de qualquer provider deste módulo de novo, este teste cai —
       e cai aqui, em segundos, e não depois de dez minutos de deploy. */
    const modulo = await montarCom(PRODUCAO_COM_CONTACTRA);

    const escolhido = modulo.get(ENRICHMENT_PROVIDER);
    expect(escolhido.nome).toBe('CONTACTRA');

    await modulo.close();
  });

  it('RECUSA subir em produção com o provider falso — o banco tem CPF de gente real', async () => {
    /* A propriedade de segurança, agora testada de verdade pela primeira vez:
       antes ela morava num construtor que ninguém nunca executou com
       NODE_ENV=production. */
    await expect(
      montarCom({ ...PRODUCAO_COM_CONTACTRA, ENRICHMENT_PROVIDER: 'fake' }),
    ).rejects.toThrow(/proibido em produção/);
  });

  it('em desenvolvimento o provider falso é aceito, sem alarme', async () => {
    /* O contrapositivo importa tanto quanto: uma trava que dispara fora de
       produção transformaria o dia a dia de desenvolvimento num inferno, e a
       reação seria removê-la — perdendo a proteção justamente onde ela vale. */
    const modulo = await montarCom({ NODE_ENV: 'development', ENRICHMENT_PROVIDER: 'fake' });

    expect(modulo.get(ENRICHMENT_PROVIDER).nome).toBe('FAKE');

    await modulo.close();
  });

  it('sem a variável definida, cai no falso — e isso só é permitido fora de produção', async () => {
    /* O default do `config.get` é 'fake'. Em produção, quem barra essa
       combinação primeiro é o refine de env.validation.ts; esta trava é a
       segunda linha, para o caso de a validação ser contornada. */
    const modulo = await montarCom({ NODE_ENV: 'test' });
    expect(modulo.get(ENRICHMENT_PROVIDER).nome).toBe('FAKE');
    await modulo.close();

    await expect(montarCom({ NODE_ENV: 'production' })).rejects.toThrow(/proibido em produção/);
  });
});
