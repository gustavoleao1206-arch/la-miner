import { ValidationPipe, VersioningType, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';

/**
 * Configuração global da aplicação: prefixo, versionamento, CORS, helmet e o
 * ValidationPipe.
 *
 * Vive fora do `main.ts` para que os testes de controller apliquem EXATAMENTE
 * a mesma configuração. Replicada no teste, ela envelheceria sozinha: alguém
 * afrouxaria o `forbidNonWhitelisted` em produção e a suíte continuaria verde
 * validando uma configuração que não existe mais — o pior resultado possível,
 * porque dá confiança falsa em vez de nenhuma.
 *
 * Fica de fora daqui o que é só de processo real: Swagger, logger, shutdown
 * hooks e o `listen`. Nada disso muda o comportamento das rotas.
 */
export function configurarApp(app: INestApplication): string {
  const config = app.get(ConfigService);
  const prefixo = config.get<string>('API_PREFIX', 'api');

  app.setGlobalPrefix(prefixo);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  /**
   * Quantos proxies existem na frente da aplicação.
   *
   * Sem isto, atrás do roteador da Render o `req.ip` é o do BALANCEADOR, e não o
   * do usuário. Dois estragos simultâneos, ambos ativos no primeiro minuto:
   *
   *  1. O throttler usa `req.ip` como chave. Com um IP só para todo mundo, o
   *     balde vira global: um cliente sozinho estoura o limite de `/auth/login`
   *     e derruba o login de TODA a plataforma.
   *  2. As colunas `ip` de AuditLog, ConsultaCliente e RefreshToken gravam o
   *     proxy em 100% das linhas. A trilha que existe para responder "quem
   *     consultou o CPF deste titular" fica preenchida e ENGANOSA — pior do que
   *     vazia, porque parece resposta.
   *
   * ⚠ Um NÚMERO, nunca `true`. `true` manda o Express aceitar a cadeia inteira
   * de X-Forwarded-For, e o cliente controla esse cabeçalho: bastaria enviar um
   * IP forjado para trocar de balde a cada requisição e furar o rate limit. Com
   * `n`, o Express conta n saltos a partir da DIREITA — a parte que o próprio
   * proxy escreveu e o cliente não alcança.
   *
   * ── O NÚMERO NA RENDER É 2, NÃO 1 ──
   *
   * Este comentário dizia 1, e por causa disso o rate limit ficou MORTO em
   * produção: medi 8 logins seguidos, 36 POSTs no webhook e 25 simultâneos, e
   * NENHUM 429 apareceu. A Render serve o app atrás da própria Cloudflare, então
   * são DOIS proxies, não um. Medido no log de produção, em 3 requisições
   * seguidas:
   *
   *   x-forwarded-for: "186.235.x.x, 172.71.146.148"
   *   x-forwarded-for: "186.235.x.x, 172.71.234.200"
   *   x-forwarded-for: "186.235.x.x, 172.69.39.82"
   *
   * A 2ª entrada é o nó de borda, e ele MUDA a cada requisição. Com `n=1` o
   * Express resolve `req.ip` justamente para ela — cada chamada num balde
   * próprio, nada é limitado, e nada denuncia. Com `n=2` sai o IP real, estável.
   *
   * E 2 é o teto: com `n=3`, um XFF forjado pelo cliente vence e ele passa a
   * escolher o próprio balde. Ou seja, 2 é ao mesmo tempo o MENOR valor correto
   * e o MAIOR valor seguro — não há margem para arredondar para nenhum lado.
   *
   * ⚠ Se um dia o domínio passar a usar o proxy da Cloudflare do DONO (a nuvem
   * laranja; hoje os registros estão em "Somente DNS"), a cadeia vira 3 e este
   * número precisa virar 3 junto — senão o rate limit morre de novo, calado.
   * Conferir com 8 logins de e-mail inexistente: a 6ª tem de vir 429.
   */
  const saltos = config.get<number>('TRUST_PROXY_HOPS', 0);
  if (saltos > 0) app.getHttpAdapter().getInstance().set('trust proxy', saltos);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));

  // CORS restrito à lista do .env — nunca '*', porque a API devolve dado pessoal.
  const origens = config
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origens.length > 0 ? origens : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // remove campos não declarados no DTO
      forbidNonWhitelisted: true, // e recusa a requisição se vierem
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  return prefixo;
}
