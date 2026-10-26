import pino from 'pino';

import { CAMINHOS_REDIGIDOS, CENSURA } from './log-redact';

/**
 * A redação de segredos no log, exercitada com um pino DE VERDADE.
 *
 * Um teste que só conferisse `expect(LISTA).toContain('...')` seria teatro: ele
 * passaria com o caminho escrito errado. E escrever errado é fácil e silencioso
 * — `req.headers.asaas-access-token` (sem colchetes) é sintaxe válida para o
 * pino, que a interpreta como outra coisa, não redige nada e não reclama.
 *
 * Por isso aqui se monta um logger real, escreve-se uma requisição com segredos
 * dentro e confere-se o TEXTO que sairia no arquivo. Se a proteção quebrar, o
 * segredo aparece na linha e o teste reprova.
 */

const SEGREDO_WEBHOOK = 'aVeIaDoWeBhOoK-que-nao-pode-vazar-jamais';
const SEGREDO_BEARER = 'Bearer jwt-que-tambem-nao-pode-vazar';
const SEGREDO_COOKIE = 'refresh=cookie-que-tambem-nao-pode-vazar';

/** Loga uma requisição e devolve a linha crua que o pino escreveria. */
function linhaDeLog(headers: Record<string, unknown>): string {
  const escrito: string[] = [];
  const destino = {
    write(pedaco: string) {
      escrito.push(pedaco);
    },
  };

  const log = pino(
    { redact: { paths: [...CAMINHOS_REDIGIDOS], censor: CENSURA } },
    destino as unknown as pino.DestinationStream,
  );

  /* O formato imita o que o `serializarRequisicaoSemDocumento` entrega: o
     serializer padrão do pino devolve `headers` INTEIRO, e é por isso que o
     redact é a única coisa entre o cabeçalho e o disco. */
  log.info(
    { req: { method: 'POST', url: '/api/v1/cobranca/webhook', headers } },
    'requisicao recebida',
  );

  return escrito.join('');
}

describe('redação de segredos no log', () => {
  it('APAGA o token do webhook do Asaas', () => {
    /* A defesa que faltava. Quem tem esse token forja "pagamento confirmado" e
       libera assinatura sem ninguém ter pago — some no log e vira chave mestra. */
    const linha = linhaDeLog({ 'asaas-access-token': SEGREDO_WEBHOOK });

    expect(linha).not.toContain(SEGREDO_WEBHOOK);
    expect(linha).toContain(CENSURA);
  });

  it('APAGA authorization e cookie (as que já existiam)', () => {
    const linha = linhaDeLog({ authorization: SEGREDO_BEARER, cookie: SEGREDO_COOKIE });

    expect(linha).not.toContain(SEGREDO_BEARER);
    expect(linha).not.toContain(SEGREDO_COOKIE);
  });

  it('apaga os três de uma vez, quando vêm juntos', () => {
    /* Em produção eles chegam na mesma requisição. Redigir um só e deixar os
       outros seria pior do que não redigir nenhum, porque pareceria protegido. */
    const linha = linhaDeLog({
      authorization: SEGREDO_BEARER,
      cookie: SEGREDO_COOKIE,
      'asaas-access-token': SEGREDO_WEBHOOK,
    });

    for (const segredo of [SEGREDO_BEARER, SEGREDO_COOKIE, SEGREDO_WEBHOOK]) {
      expect(linha).not.toContain(segredo);
    }
  });

  it('APAGA IP e user agent — dado pessoal não vai para o log de terceiro', () => {
    const linha = linhaDeLog({
      'cf-connecting-ip': '203.0.113.163',
      'x-forwarded-for': '203.0.113.163, 198.51.100.27',
      'true-client-ip': '203.0.113.163',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/151',
    });
    expect(linha).not.toContain('203.0.113.163');
    expect(linha).not.toContain('198.51.100.27');
    expect(linha).not.toContain('Chrome/151');
  });

  it('NÃO apaga cabeçalho inocente — a lista é bisturi, não machado', () => {
    /* Sem este caso, "redigir tudo" passaria nos testes acima. Um log que perde
       method, content-type e caminho deixa de servir para depurar, e a primeira
       coisa que alguém faz é desligar o redact inteiro.

       ⚠ O `user-agent` ESTAVA nesta lista de inocentes e MUDOU DE LADO. Ele é
       impressão digital de dispositivo: junto do IP identifica pessoa, e é dado
       pessoal sob a LGPD. Perder a string do navegador custa pouco na depuração
       — o que se depura de verdade é caminho, método e status. O caso do
       webhook do Asaas é o mais tentador a favor dele (ali o user agent é de
       máquina, não de gente), e mesmo assim a lista é por CAMINHO, não por
       rota: abrir exceção para uma rota abriria para todas. */
    const linha = linhaDeLog({
      'content-type': 'application/json',
      'user-agent': 'Asaas-Webhook',
      'asaas-access-token': SEGREDO_WEBHOOK,
    });

    expect(linha).toContain('application/json');
    expect(linha).toContain('/api/v1/cobranca/webhook');
    expect(linha).not.toContain(SEGREDO_WEBHOOK);
    /* O user agent some junto — é o preço declarado acima, fixado aqui para
       não voltar por descuido. */
    expect(linha).not.toContain('Asaas-Webhook');
  });

  it('ESTILO: todo cabeçalho com hífen usa colchetes', () => {
    /* ⚠ Isto é regra de ESTILO, não defesa de segurança — e o rótulo importa.
       Eu supunha que notação de ponto com hífen falharia calada; MEDI com a
       mutação e é falso: no pino 10.3.1 `req.headers.asaas-access-token` redige
       igualzinho, e os quatro casos acima passam com as duas formas. O valor
       daqui é só uniformidade com `res.headers["set-cookie"]`.
       Se este caso um dia atrapalhar, apague sem dó: quem protege o segredo são
       os testes de comportamento, não este. */
    const comHifenForaDeColchete = CAMINHOS_REDIGIDOS.filter((caminho) => {
      const semColchetes = caminho.replace(/\[[^\]]*\]/g, '');
      return semColchetes.includes('-');
    });

    expect(comHifenForaDeColchete).toEqual([]);
  });
});
