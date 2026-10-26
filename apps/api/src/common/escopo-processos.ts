import type { Prisma } from '@miner/database';
import type { UsuarioAutenticado } from './decorators/papeis.decorator';

/** O mínimo para decidir escopo: o tipo da org, a própria org e o papel. */
export type EscopoUsuario = Pick<UsuarioAutenticado, 'tipo' | 'organizationId' | 'papel'>;

/**
 * O filtro que realiza a FRONTEIRA DE VISIBILIDADE sobre Processo.
 *
 * INTERNA (Leão Amorim) é dona da base: vê o que a própria org possui. CLIENTE é
 * assinante: vê SÓ o que lhe foi LIBERADO. Um único ponto decide isso, e como
 * todo método de leitura compõe este fragmento no `where`, esquecer o escopo não
 * devolve dado de mais — devolve dado de menos (nada), que estoura no teste. É o
 * oposto de um vazamento silencioso.
 *
 * Mora em `common/` e não no serviço da carteira porque a ESCRITA precisa da
 * mesma regra: o cliente anota e cria tarefa num processo que é PROPRIEDADE da
 * org interna e foi liberado a ele. Duas cópias desta função divergiriam no
 * primeiro ajuste — e a que divergisse seria a da escrita, a mais perigosa.
 */
/**
 * Quem deve ser TRATADO como cliente.
 *
 * Uma função só, porque a resposta governa duas coisas que precisam concordar: o
 * ESCOPO (o que a consulta alcança) e a PROJEÇÃO (quais campos saem na resposta).
 * Quando elas divergiram — escopo olhando papel+org, projeção olhando só a org —
 * o resultado foi uma carteira corretamente vazia devolvida com o vocabulário do
 * enriquecimento junto. Duas perguntas, uma verdade.
 */
export function ehEscopoCliente(usuario: EscopoUsuario): boolean {
  return usuario.tipo === 'CLIENTE' || usuario.papel === 'CLIENTE';
}

export function escopoProcessos(usuario: EscopoUsuario): Prisma.ProcessoWhereInput {
  /* Dos dois sinais, vale o MAIS RESTRITIVO — falha fechado.
     O normal é papel CLIENTE morar em org CLIENTE, mas nada no schema obriga
     isso, e existe a configuração legada: papel CLIENTE dentro da org INTERNA
     ("apenas consulta o banco interno", como o enum Papel ainda descreve).
     Decidir só pelo tipo da org daria a esse usuário a BASE INTEIRA — 3.974
     documentos com telefone e endereço —, justamente o que o antigo 403 na
     carteira existia para impedir. Com o OR, ele cai no escopo de liberação: a
     org interna não tem liberação nenhuma, então ele não vê nada. */
  return ehEscopoCliente(usuario)
    ? { liberacoes: { some: { organizationId: usuario.organizationId } } }
    : { organizationId: usuario.organizationId };
}
