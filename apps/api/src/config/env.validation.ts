/**
 * Validação de ambiente com zod.
 *
 * A API falha ao subir se faltar variável crítica — em vez de quebrar
 * silenciosamente em produção na primeira requisição.
 */
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    // Banco
    DATABASE_URL: z.string().url('DATABASE_URL precisa ser uma URL de conexão válida'),

    // Redis
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),

    /**
     * O commit publicado — quem preenche é a Render, não nós. Lido pela rota
     * `/versao`.
     *
     * DECLARADA POR DOCUMENTAÇÃO, e não por necessidade: o `ConfigService.get`
     * cai em `process.env` depois de procurar no env validado (conferido na
     * fonte do @nestjs/config), então ela funcionaria sem esta linha. O que a
     * linha entrega é encontrabilidade — este arquivo é onde se lê quais
     * variáveis o app usa, e uma que não está aqui ninguém acha.
     *
     * (A versão anterior deste comentário afirmava que o zod DESCARTAVA a
     * chave e que sem a declaração a rota responderia nulo para sempre. Uma
     * mutação removendo a linha deixou a suíte verde e desmentiu isso.)
     *
     * Opcional porque fora da Render ela não existe (máquina de desenvolvimento,
     * suíte de testes), e faltar não é motivo para a API não subir.
     */
    RENDER_GIT_COMMIT: z.string().optional(),

    /**
     * Horas PARADAS até a sessão morrer no servidor. 8 = não atravessa a noite.
     *
     * ⚠ Precisa ser MAIOR que o pause da aba (30 min, `lib/inatividade.tsx`).
     * Com um teto menor, o botão "Continuar trabalhando" nunca funcionaria: a
     * aba pausa, a pessoa clica, a renovação é recusada e ela cai no login toda
     * vez — que é exatamente o comportamento que o pause existe para evitar.
     * O mínimo de 1 hora é a trava contra configurar isso por engano.
     */
    SESSAO_OCIOSA_HORAS: z.coerce.number().int().min(1).max(720).default(8),

    /**
     * ── Confirmação de e-mail no cadastro público ──
     *
     * DESLIGADA por padrão, e o deploy desta funcionalidade não muda nada em
     * produção — mesmo desenho do plano anual invisível. Ligar é decisão de
     * operação: exige provedor real configurado (o refine lá embaixo recusa o
     * boot com fake em produção) e o DNS do domínio (SPF/DKIM) publicado.
     */
    CONFIRMACAO_EMAIL_ATIVA: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Horas de validade do link. Vencido, o cadastro vira reciclável. */
    CONFIRMACAO_EMAIL_VALIDADE_HORAS: z.coerce.number().int().min(1).max(168).default(48),
    EMAIL_PROVIDER: z.enum(['fake', 'resend']).default('fake'),
    /** Remetente verificado no provedor (ex.: nao-responda@laminer.com.br). */
    EMAIL_REMETENTE: z.string().email().optional(),
    RESEND_API_KEY: z.string().optional(),
    /** Base dos links que vão em e-mail (a URL do front, sem barra final). */
    WEB_URL: z.string().url().default('http://localhost:3000'),

    // API
    API_PORT: z.coerce.number().int().positive().default(3333),
    API_PREFIX: z.string().default('api'),
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /* Número de proxies na frente do app. 0 em desenvolvimento (acesso direto);
       2 na Render — ela serve o app atrás da própria Cloudflare, então são dois,
       e não um. Esta linha já disse "1", e o rate limit ficou morto em produção
       sem nada denunciar. Ver a nota extensa em configurar-app.ts, com a medição
       do X-Forwarded-For e o motivo de NUNCA poder ser `true` nem 3. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    /* SEM default aqui, de propósito.
       Com `.default('true')`, o ConfigService sempre encontrava um valor
       validado e o fallback `!producao` do main.ts virava código morto: o
       Swagger subia LIGADO em produção, expondo o mapa completo da API e a
       existência do enriquecimento — o que o requisito de negócio proíbe.
       Opcional aqui, o default passa a ser decidido por NODE_ENV no main.ts. */
    SWAGGER_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),

    // Autenticação — segredos com tamanho mínimo real, não placeholder
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET precisa de ao menos 32 caracteres'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET precisa de ao menos 32 caracteres'),
    JWT_REFRESH_TTL: z.string().default('7d'),

    /* O refresh token vive num cookie httpOnly. Estas duas decidem se o
       navegador vai de fato enviá-lo — e errar aqui produz a pior classe de
       falha: login funciona, e a sessão morre 15 minutos depois, sem erro.

       `strict` é o padrão porque é o mais seguro. Só serve se web e API forem o
       MESMO SITE. Nos domínios de fábrica da Render não são: `onrender.com`
       está na Public Suffix List, então miner-web.onrender.com e
       miner-api.onrender.com são sites distintos e o cookie nunca sairia.
       Nesse cenário, `none` — que exige `secure`, garantido pelo refine. */
    COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('strict'),
    /* Sem default: quando ausente, `opcoesCookieRefresh` deriva de NODE_ENV.
       Existe para o caso de HTTPS local — nunca para desligar em produção, o
       que o refine abaixo impede. */
    COOKIE_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),

    /* ── Segundo fator (MFA/TOTP) ──
       Chave que CIFRA o segredo TOTP no banco (AES-256-GCM, via HKDF).

       OPCIONAL de propósito. Exigi-la quebraria todo deploy existente na
       primeira subida depois desta mudança — para entregar um recurso que
       ninguém ainda usa. Sem ela, ligar MFA responde 503 com a explicação; com
       ela, tudo funciona. É a mesma escolha de `BILLING_PROVIDER=manual`: o
       sistema nasce no modo que não muda nada para quem já está rodando.

       ⚠ PERDER esta chave depois de haver cadastros equivale a apagar os
       segredos: os usuários entram pelos códigos de recuperação e cadastram de
       novo. Material de cofre, e não de arquivo de configuração comum. */
    MFA_ENCRYPTION_KEY: z
      .string()
      .min(32, 'MFA_ENCRYPTION_KEY precisa de ao menos 32 caracteres')
      .optional(),

    /* Quem é OBRIGADO a ter segundo fator.
         nenhum → opcional para todos (padrão)
         admin  → ADMIN da plataforma e gestor de organização cliente
         todos  → todo mundo
       Quem está em falta entra, mas só alcança o próprio cadastro de MFA — ver
       MfaObrigatorioGuard. */
    MFA_OBRIGATORIO: z.enum(['nenhum', 'admin', 'todos']).default('nenhum'),

    // Provider de enriquecimento
    ENRICHMENT_PROVIDER: z.enum(['fake', 'contactra']).default('fake'),

    // Contactra — só exigido quando o provider real está selecionado
    CONTACTRA_BASE_URL: z.string().optional(),
    CONTACTRA_CLIENT_ID: z.string().optional(),
    CONTACTRA_CLIENT_SECRET: z.string().optional(),
    CONTACTRA_TOKEN_URL: z.string().optional(),
    CONTACTRA_RATE_LIMIT_POR_MINUTO: z.coerce.number().int().positive().default(60),
    CONTACTRA_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    // Trava de custo: sem coerce vira string e as contas ficam frágeis.
    // Começa LIGADO: quem quiser gastar de verdade precisa desligar conscientemente.
    SYNC_DRY_RUN: z.enum(['true','false']).default('true'),
    SYNC_LIMITE_POR_RODADA: z.coerce.number().int().positive().max(5000).default(100),
    CONTACTRA_CUSTO_POR_CONSULTA: z.coerce.number().nonnegative().default(0),
    SYNC_AGENDADA_ATIVA: z.enum(['true','false']).default('false'),
    SYNC_CRON: z.string().default('0 3 * * *'),
    SYNC_DIAS_RECONSULTA: z.coerce.number().int().positive().default(90),
    CONTACTRA_TETO_DIARIO: z.coerce.number().int().positive().default(500),
    CONTACTRA_ID_FINALIDADE: z.coerce.number().int().positive().default(5),

    // ── Cobrança ──
    // Começa MANUAL pelo mesmo motivo do provider de enriquecimento começar
    // `fake`: o sistema nasce no modo que não movimenta dinheiro de ninguém.
    BILLING_PROVIDER: z.enum(['manual', 'asaas']).default('manual'),
    ASAAS_API_KEY: z.string().optional(),
    ASAAS_WEBHOOK_TOKEN: z.string().optional(),
    /**
     * Aceite EXPLÍCITO de rodar produção com a chave de sandbox.
     *
     * A trava lá embaixo existe para impedir o pior silêncio possível: faturas
     * emitidas, links gerados, ninguém cobrado de verdade. Mas há um caso
     * legítimo que ela não distingue de um acidente — homologar o ciclo
     * completo (cadastro → pagamento → webhook → acesso liberado) no ambiente
     * de produção, que é o único onde o Asaas consegue ENTREGAR o webhook.
     *
     * A diferença entre o acidente e a decisão é alguém ter escrito isto aqui.
     * Sem a variável, a trava é exatamente a de antes; com ela, o boot passa a
     * gritar em todo start (ver CobrancaModule) para o estado nunca virar
     * paisagem. Apagar a variável restaura a proteção sozinha — é o que se faz
     * no dia em que a chave de produção entrar.
     */
    ASAAS_ACEITAR_SANDBOX: z.enum(['true', 'false']).default('false'),
    // UNDEFINED oferece na fatura TODOS os meios habilitados na conta Asaas —
    // PIX, boleto E cartão (quem liga/desliga o cartão é o painel do Asaas).
    // Custos: PIX e boleto são taxa fixa; cartão é percentual (2–4%) e o
    // dinheiro liquida em ~32 dias — no anual de R$ 7.670 isso é R$ 150–300
    // por venda. Decisão comercial, não deste código.
    ASAAS_BILLING_TYPE: z.enum(['UNDEFINED', 'BOLETO', 'PIX', 'CREDIT_CARD']).default('UNDEFINED'),
    COBRANCA_DIAS_VENCIMENTO: z.coerce.number().int().positive().max(60).default(10),
    COBRANCA_CARENCIA_DIAS: z.coerce.number().int().nonnegative().max(60).default(5),
    COBRANCA_AGENDADA_ATIVA: z.enum(['true', 'false']).default('false'),
    COBRANCA_CRON: z.string().default('0 5 * * *'),

    /* Dias que a resposta CRUA do provedor sobrevive antes de ser descartada.
       A linha da consulta fica (é a trilha e a conferência da fatura); só o
       conteúdo sai. 0 desliga — e o `max` existe porque "10 anos" digitado sem
       querer transformaria a política de minimização em decoração. */
    RETENCAO_DADOS_BRUTOS_DIAS: z.coerce.number().int().nonnegative().max(3650).default(180),

    /* Dias que IP e user agent sobrevivem nos REGISTROS DE ACESSO (audit_logs,
       consultas_cliente) antes de serem anonimizados em lugar. O `min(180)` é
       LEI, não gosto: o art. 15 do Marco Civil obriga a guardar o IP dos
       acessos por 6 meses para entrega mediante ordem judicial. Um "30" aqui
       trocaria uma infração da LGPD por uma do Marco Civil. */
    RETENCAO_REGISTROS_ACESSO_DIAS: z.coerce.number().int().min(180).max(3650).default(180),
    /* Vida da linha crua da planilha importada. Mínimo de 7 dias porque abaixo
       disso a limpeza alcançaria uma importação da semana, que ainda é candidata
       real a reprocessamento; máximo de 365 porque acima disso a coluna volta a
       ser o arquivo permanente que ela deixou de ser. */
    RETENCAO_PLANILHA_DIAS: z.coerce.number().int().min(7).max(365).default(90),
    /* Vida do TEXTO digitado na busca (`consultas_cliente.termo`) — que numa
       busca por nome É um nome completo, e numa por endereço, um logradouro.

       NÃO herda o piso de 180 dos registros de acesso, e a diferença é de
       natureza, não de gosto: o art. 15 do Marco Civil obriga a guardar o
       REGISTRO DE ACESSO — quem se conectou, de onde, quando. O que a pessoa
       digitou na caixa de busca é CONTEÚDO, e conteúdo o Marco Civil manda
       guardar sigiloso e só entregar com ordem judicial (art. 7º, II e III);
       obrigação de retenção ele não cria. Aplicar o piso de 180 aqui inverteria
       a lei que se está tentando cumprir.

       90 por simetria com a planilha. O que sustenta a prestação de contas —
       usuário, data, CPF consultado, nº de resultados, contato exibido — não
       tem prazo e continua inteiro. O mínimo de 30 evita que a trilha do mês
       corrente já nasça ilegível para quem investiga um incidente. */
    RETENCAO_TERMO_BUSCA_DIAS: z.coerce.number().int().min(30).max(365).default(90),
    /* Sentinela de escopo. Sem valor: AVISAR fora de teste, BLOQUEAR em teste.
       `desligado` existe para uma emergência de produção — e não para virar o
       padrão de quem se cansou de um aviso. */
    SENTINELA_ESCOPO: z.enum(['desligado', 'avisar', 'bloquear']).optional(),
    /* Dias para responder a um pedido de titular. 15 é o prazo do art. 19, II
       da LGPD para a declaração completa de acesso; para os outros direitos a
       lei não fixa número. Configurável porque o prazo por TIPO de pedido é
       validação jurídica — o que o código garante é que existe prazo, que ele é
       medido e que aparece na tela. O teto de 60 impede que "configurável" vire
       "sem prazo". */
    PRAZO_SOLICITACAO_TITULAR_DIAS: z.coerce.number().int().min(1).max(60).default(15),
    /* Ligado por padrão: retenção é obrigação, não opção. A chave existe para
       emergência (um corte errado em produção), nunca para "desligar a LGPD". */
    RETENCAO_AGENDADA_ATIVA: z.enum(['true', 'false']).default('true'),

    /* ── Limites da conexão com o banco ──
       Sem estes, o Prisma dimensiona o pool por `num_cpus * 2 + 1` — o tamanho
       vira acidente do hardware onde o processo caiu — e `statement_timeout`
       fica ZERO, deixando uma consulta travada segurar a conexão para sempre.

       O `max` de conexões existe porque o Postgres da Render tem teto baixo e
       ele é COMPARTILHADO: as migrations do preDeploy e qualquer segundo
       serviço (o worker, quando separado) disputam o mesmo bolo. Pedir 100 aqui
       não daria mais conexões, daria erro de conexão recusada. */
    DB_CONEXOES: z.coerce.number().int().positive().max(50).default(10),
    DB_POOL_TIMEOUT_S: z.coerce.number().int().positive().max(120).default(10),
    /* Teto por CONSULTA, não por transação. 30s é folgado para tudo que a
       aplicação faz hoje; o `min` impede que alguém digite 100 e derrube a
       busca por nome, que é a consulta mais pesada da carteira. */
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),

    /* Que papel este processo cumpre.
         api    → serve HTTP; produz na fila, mas NÃO consome, e não roda cron
         worker → consome a fila e dispara os crons; sem porta HTTP
         tudo   → os dois no mesmo processo (padrão)

       `tudo` continua VÁLIDO em produção, e isso é deliberado: separar custa um
       segundo serviço na Render, e essa é uma decisão de custo do dono, não do
       código. O que não pode é rodar um worker separado E deixar a API em
       `tudo` — seriam dois consumidores da mesma fila. Quem separa, separa dos
       dois lados; é o que o render.yaml faz. */
    PAPEL_PROCESSO: z.enum(['api', 'worker', 'tudo']).default('tudo'),
  })
  // Trava de segurança: o provider falso jamais roda em produção.
  .refine((env) => !(env.NODE_ENV === 'production' && env.ENRICHMENT_PROVIDER === 'fake'), {
    message: 'ENRICHMENT_PROVIDER=fake é proibido em produção. Configure o provider real.',
    path: ['ENRICHMENT_PROVIDER'],
  })
  // Se escolheu Contactra, as credenciais são obrigatórias.
  .refine(
    (env) =>
      env.ENRICHMENT_PROVIDER !== 'contactra' ||
      Boolean(env.CONTACTRA_BASE_URL && env.CONTACTRA_CLIENT_ID && env.CONTACTRA_CLIENT_SECRET),
    {
      message:
        'ENRICHMENT_PROVIDER=contactra exige CONTACTRA_BASE_URL, CONTACTRA_CLIENT_ID e CONTACTRA_CLIENT_SECRET.',
      path: ['CONTACTRA_BASE_URL'],
    },
  )
  /* Exigir MFA sem a chave que cifra os segredos tranca TODO MUNDO do lado de
     fora: o guard manda cadastrar, o cadastro responde 503 por falta de chave, e
     não há saída pela aplicação. É a combinação que precisa morrer no boot, e
     não em produção com o dono sem acesso ao próprio painel. */
  .refine(
    (env) =>
      !(env.NODE_ENV === 'production' && env.CONFIRMACAO_EMAIL_ATIVA && env.EMAIL_PROVIDER === 'fake'),
    {
      message:
        'CONFIRMACAO_EMAIL_ATIVA=true com EMAIL_PROVIDER=fake em produção é um cadastro que ' +
        'NINGUÉM consegue confirmar: o link sai no log do servidor, não na caixa de entrada. ' +
        'Configure um provedor real (resend) antes de ligar a exigência.',
      path: ['EMAIL_PROVIDER'],
    },
  )
  .refine(
    (env) => env.EMAIL_PROVIDER !== 'resend' || (Boolean(env.RESEND_API_KEY) && Boolean(env.EMAIL_REMETENTE)),
    {
      message: 'EMAIL_PROVIDER=resend exige RESEND_API_KEY e EMAIL_REMETENTE.',
      path: ['EMAIL_PROVIDER'],
    },
  )
  .refine((env) => env.MFA_OBRIGATORIO === 'nenhum' || Boolean(env.MFA_ENCRYPTION_KEY), {
    message:
      'MFA_OBRIGATORIO exige MFA_ENCRYPTION_KEY. Sem ela ninguém consegue cadastrar o ' +
      'segundo fator — e todos ficariam bloqueados. Gere com: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
    path: ['MFA_ENCRYPTION_KEY'],
  })
  // Swagger em produção é decisão consciente, não descuido: ele publica o mapa
  // inteiro da API. Ligar exige mudar esta linha, não só uma variável.
  .refine((env) => !(env.NODE_ENV === 'production' && env.SWAGGER_ENABLED === true), {
    message:
      'SWAGGER_ENABLED=true é proibido em produção: expõe o mapa completo da API. ' +
      'Remova a variável ou defina false.',
    path: ['SWAGGER_ENABLED'],
  })
  // Em produção a aplicação está atrás de um proxy (Render, Nginx, Cloudflare).
  // Com 0, o rate limit vira um balde único para toda a plataforma e a trilha da
  // LGPD grava o IP do balanceador em todas as linhas — a coluna existe para
  // responder à ANPD e ficaria constante.
  .refine((env) => !(env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS < 1), {
    message:
      'Em produção, TRUST_PROXY_HOPS precisa ser ≥ 1 (use 2 na Render: ela põe a ' +
      'própria Cloudflare na frente, então são DOIS proxies). ' +
      'Com 0, o rate limit e a trilha de auditoria registram o proxy, não o usuário.',
    path: ['TRUST_PROXY_HOPS'],
  })
  /* SameSite=None sem Secure: o navegador RECUSA o cookie por completo — não
     avisa, não envia, e a sessão morre no primeiro refresh. Vale lembrar que
     `secure` só é ligado sozinho quando NODE_ENV=production; fora dela, pedir
     `none` exige dizer COOKIE_SECURE=true explicitamente. */
  .refine(
    (env) =>
      env.COOKIE_SAMESITE !== 'none' ||
      (env.COOKIE_SECURE ?? env.NODE_ENV === 'production') === true,
    {
      message:
        'COOKIE_SAMESITE=none exige cookie Secure. Rode em produção ou defina COOKIE_SECURE=true ' +
        '(o navegador descarta silenciosamente um cookie SameSite=None sem Secure).',
      path: ['COOKIE_SAMESITE'],
    },
  )
  /* Desligar Secure em produção mandaria o refresh token em texto claro por
     HTTP. É o oposto do que o cookie httpOnly foi feito para conseguir. */
  .refine((env) => !(env.NODE_ENV === 'production' && env.COOKIE_SECURE === false), {
    message:
      'COOKIE_SECURE=false é proibido em produção: o refresh token trafegaria sem TLS.',
    path: ['COOKIE_SECURE'],
  })
  // Gateway sem credencial e, sobretudo, sem o segredo do webhook não sobe.
  // Faltando o token, o sistema cobraria de verdade e RECUSARIA todo aviso de
  // pagamento — clientes em dia seriam suspensos por inadimplência inexistente.
  .refine(
    (env) =>
      env.BILLING_PROVIDER !== 'asaas' ||
      Boolean(env.ASAAS_API_KEY && env.ASAAS_WEBHOOK_TOKEN),
    {
      message: 'BILLING_PROVIDER=asaas exige ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN.',
      path: ['ASAAS_API_KEY'],
    },
  )
  // O segredo do webhook guarda a única rota pública que quita fatura. Um valor
  // curto ("teste", "123") é adivinhável, e o Asaas até recusa tokens fracos —
  // melhor barrar aqui do que descobrir pelo cadastro rejeitado.
  .refine((env) => !env.ASAAS_WEBHOOK_TOKEN || env.ASAAS_WEBHOOK_TOKEN.length >= 24, {
    message: 'ASAAS_WEBHOOK_TOKEN precisa de ao menos 24 caracteres.',
    path: ['ASAAS_WEBHOOK_TOKEN'],
  })
  // A trava que impede o pior silêncio possível: subir em PRODUÇÃO com a chave
  // de sandbox. Tudo pareceria funcionar — faturas emitidas, links gerados — e
  // ninguém seria cobrado de verdade, até alguém conferir o extrato.
  //
  // `ASAAS_ACEITAR_SANDBOX=true` abre a exceção, e só ela: continua sendo
  // impossível cair nesse estado SEM QUERER, que é o que a trava protege. O
  // aceite não silencia nada — o CobrancaModule berra em todo boot enquanto
  // ele estiver ligado.
  .refine(
    (env) =>
      !(
        env.NODE_ENV === 'production' &&
        env.BILLING_PROVIDER === 'asaas' &&
        !env.ASAAS_API_KEY?.startsWith('$aact_prod_') &&
        env.ASAAS_ACEITAR_SANDBOX !== 'true'
      ),
    {
      message:
        'Em produção, ASAAS_API_KEY precisa ser a chave de produção ($aact_prod_). ' +
        'Com a chave de sandbox ninguém é cobrado de verdade. ' +
        'Se a intenção é homologar o ciclo de pagamento em produção, declare ' +
        'ASAAS_ACEITAR_SANDBOX=true — e apague a variável assim que a chave real entrar.',
      path: ['ASAAS_API_KEY'],
    },
  );

export type Env = z.infer<typeof envSchema>;

export function validarEnv(config: Record<string, unknown>): Env {
  const resultado = envSchema.safeParse(config);

  if (!resultado.success) {
    const problemas = resultado.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`\nConfiguração de ambiente inválida:\n${problemas}\n`);
  }

  return resultado.data;
}
