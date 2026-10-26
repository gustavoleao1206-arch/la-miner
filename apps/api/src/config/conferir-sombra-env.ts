import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';

/**
 * Recusa subir quando o `.env` da raiz NÃO é o que a aplicação está usando.
 *
 * O incidente que motivou isto: `packages/database/.env` era uma cópia inteira
 * do `.env` da raiz. Importar o client gerado do Prisma carrega aquele arquivo
 * em `process.env`, e o dotenv não sobrescreve variável já definida — então o
 * `@nestjs/config`, que roda depois, não tinha efeito algum sobre as chaves ali
 * repetidas. O `app.module.ts` afirmava que a raiz era a fonte da verdade; não
 * era, e nada avisava.
 *
 * O custo disso foi concreto: uma rotação dos segredos JWT na raiz não mudou
 * nada. A API seguiu assinando e aceitando tokens com o segredo velho, e o
 * arquivo rotacionado passava a impressão de que a troca tinha sido feita — o
 * pior tipo de falha de segurança, a que parece resolvida.
 *
 * Só confere CREDENCIAL. Divergência de porta ou de nível de log é ruído; um
 * segredo de assinatura que não é o que se pensa que é derruba a garantia
 * inteira. E só olha chaves que o arquivo da raiz REALMENTE define: quem sobe
 * sem `.env`, com variáveis de ambiente de verdade, não é afetado.
 */
const CREDENCIAIS = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'CONTACTRA_CLIENT_ID',
  'CONTACTRA_CLIENT_SECRET',
] as const;

/** Identifica o valor sem revelá-lo — a mensagem de erro vai para o log. */
const digital = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 12);

export function conferirSombraEnv(caminhoEnv: string, ambiente = process.env): void {
  if (!existsSync(caminhoEnv)) return;

  const doArquivo = parse(readFileSync(caminhoEnv, 'utf8'));

  const divergentes = CREDENCIAIS.filter((k) => {
    const declarado = doArquivo[k];
    /* Sem valor no arquivo não há o que comparar. Ausente no ambiente também
       não é sombra: é configuração faltando, e a validação Zod já cobre. */
    if (!declarado || !ambiente[k]) return false;
    return ambiente[k] !== declarado;
  });

  if (divergentes.length === 0) return;

  const detalhe = divergentes
    .map((k) => `  ${k}: o arquivo declara ${digital(doArquivo[k]!)}, a aplicação usa ${digital(ambiente[k]!)}`)
    .join('\n');

  throw new Error(
    `A aplicação NÃO está usando as credenciais do .env da raiz.\n\n${detalhe}\n\n` +
      `Alguma coisa definiu essas variáveis antes do @nestjs/config, e o dotenv não\n` +
      `sobrescreve o que já existe. O suspeito de sempre é um segundo .env dentro do\n` +
      `repositório — packages/database/.env é carregado pelo client do Prisma assim que\n` +
      `ele é importado. Remova a chave duplicada de lá; a raiz é a fonte da verdade.\n\n` +
      `Se a intenção era mesmo sobrescrever por variável de ambiente, tire a chave do\n` +
      `.env da raiz para a ambiguidade deixar de existir.`,
  );
}
