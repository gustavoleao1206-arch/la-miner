/** @type {import('next').NextConfig} */

/**
 * Cabeçalhos FIXOS ficam aqui; a CSP fica no `middleware.ts`, porque o nonce
 * dela muda a cada requisição e este arquivo só produz valores constantes.
 */
const producao = process.env.NODE_ENV === 'production';

const cabecalhos = [
  /* Redundante com `frame-ancestors 'none'` da CSP, e mantido de propósito:
     navegador antigo que ignore CSP ainda lê este. */
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  /* Nega o que o painel nunca usa. Sem isto, um script injetado poderia pedir
     câmera, microfone ou localização — e o navegador mostraria o pedido com o
     NOSSO domínio no aviso, o que é um belo golpe pronto. */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

if (producao) {
  /**
   * HSTS só em produção.
   *
   * Em desenvolvimento o site é http://localhost, e o cabeçalho seria ignorado
   * — mas basta um dia de HTTPS local para o navegador GRAVAR a regra e passar
   * a recusar `http://localhost` em TODAS as portas, inclusive de outros
   * projetos. O estrago dura dois anos e só se desfaz limpando o HSTS do
   * navegador à mão. Não vale o risco por um cabeçalho que ali não protege.
   *
   * `includeSubDomains` fica; `preload` SAIU, e o motivo é que ele não fazia
   * nada além de prometer.
   *
   * O painel é servido de app.laminer.com.br. A lista pública de preload só
   * aceita submissão do domínio REGISTRÁVEL, e exige que o cabeçalho venha do
   * ápice — que aqui não é servido por este código, e nem deve ser: o ápice é
   * onde moram os registros MX do domínio. Ou seja, a palavra viajava em toda
   * resposta anunciando uma proteção que nenhuma lista jamais leria.
   *
   * E ela não era só inerte: era uma armadilha armada. No dia em que alguém
   * apontasse o ápice para cá "para o site abrir sem o app.", o cabeçalho
   * passaria a valer para laminer.com.br e TODOS os seus subdomínios por dois
   * anos — webmail., mail., cpanel. e ftp., que ficam em outro provedor e cujo
   * comportamento em http não controlamos. Com `preload`, praticamente
   * irreversível. Sem a palavra, o alcance é só *.app.laminer.com.br.
   */
  cabecalhos.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains',
  });
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: cabecalhos }];
  },
};

export default nextConfig;
