/**
 * Os caminhos que o pino APAGA antes de escrever qualquer linha.
 *
 * Vive em arquivo próprio, e não dentro da `useFactory` do `app.module.ts`, por
 * um motivo prático: dentro do closure nenhum teste alcançava a lista. Uma
 * proteção que ninguém consegue exercitar é uma proteção que ninguém percebe
 * quando some — foi exatamente assim que o `asaas-access-token` ficou de fora
 * por todo o tempo em que o webhook esteve escrito.
 *
 * ── POR QUE O REDACT É A ÚNICA DEFESA AQUI ──
 *
 * O serializer de requisição (`serializarRequisicaoSemDocumento`) devolve `...base`, e
 * `base` vem do serializer padrão do pino — que inclui `headers` INTEIRO. Ou
 * seja: todo cabeçalho da requisição chega ao log por padrão, e o que não
 * estiver nesta lista é escrito em claro. O `autoLogging` está ligado e o nível
 * em produção é `info`, então isso vale para TODA requisição, não só para erro.
 *
 * ── SOBRE OS COLCHETES: É PADRONIZAÇÃO, NÃO CORREÇÃO ──
 *
 * Eu supunha que `req.headers.asaas-access-token`, em notação de ponto, não
 * redigiria nada por causa do hífen. **Medi, e é falso**: no pino 10.3.1 as duas
 * formas redigem igual — os testes de comportamento deste arquivo passam com as
 * duas. Fica registrado para ninguém "consertar" isso de novo baseado na mesma
 * suposição errada.
 *
 * Mantemos os colchetes por consistência com `res.headers["set-cookie"]`, que já
 * estava assim, e porque a forma é inequívoca. O teste que exige colchetes é uma
 * regra de ESTILO, e está rotulado como tal — não é uma defesa de segurança, e
 * chamá-lo de defesa seria a falsa confiança que este projeto já pagou caro.
 *
 * A defesa de verdade são os casos que montam um pino real, escrevem segredos e
 * conferem o texto que sairia no disco.
 */
export const CAMINHOS_REDIGIDOS = [
  'req.headers.authorization',
  'req.headers.cookie',
  /* Segredo compartilhado do webhook do Asaas. Quem o tiver consegue forjar
     "pagamento confirmado" e liberar assinatura sem ninguém ter pago — é
     credencial de mesmo peso que a senha, e não pode viver no log da Render. */
  'req.headers["asaas-access-token"]',
  'req.body.senha',
  'req.body.senhaAtual',
  'req.body.novaSenha',
  'req.body.refreshToken',
  'req.body.cpf',
  'res.headers["set-cookie"]',
  /* ── DADO PESSOAL, NÃO SEGREDO ──
     IP e user agent associados a uma conta são dado pessoal (LGPD, art. 5º I),
     e o log da Render é um armazém de terceiro cuja retenção não controlamos.
     O registro de acesso que a lei manda guardar mora no AuditLog, sob a
     política de retenção; o log de requisição não precisa de uma cópia. */
  'req.headers["cf-connecting-ip"]',
  'req.headers["x-forwarded-for"]',
  'req.headers["true-client-ip"]',
  'req.headers["x-real-ip"]',
  'req.headers["user-agent"]',
  'req.remoteAddress',
] as const;

/** O que aparece no lugar do valor apagado. */
export const CENSURA = '[REDIGIDO]';
