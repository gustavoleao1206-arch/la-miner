/**
 * Origem única da URL da API.
 *
 * ⚠ POR QUE ISTO FALHA O BUILD EM VEZ DE CAIR NUM DEFAULT.
 *
 * Antes, dois arquivos repetiam `process.env.NEXT_PUBLIC_API_URL ??
 * 'http://localhost:3333/api'`. Variável `NEXT_PUBLIC_` é substituída no BUILD e
 * congelada dentro do bundle — não é lida em tempo de execução. Então esquecê-la
 * no painel da Render publicava um site que aponta para `localhost:3333`: cada
 * visitante chamaria a própria máquina, TODAS as telas ficariam vazias, e o
 * servidor da API não registraria uma única requisição. Falha invisível dos dois
 * lados, e impossível de corrigir sem um build novo.
 *
 * Em desenvolvimento o default continua, porque ali ele está certo. Em produção,
 * a ausência quebra o build — o momento mais barato possível para descobrir.
 */
function resolverApi(): string {
  const doAmbiente = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (doAmbiente) return doAmbiente.replace(/\/+$/, '');

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_API_URL não definida no build de produção. ' +
        'Sem ela o site publicado apontaria para localhost e nenhuma tela carregaria. ' +
        'Defina a variável no ambiente de build (ex.: https://api.seudominio.com.br/api).',
    );
  }
  return 'http://localhost:3333/api';
}

export const API_URL = resolverApi();
