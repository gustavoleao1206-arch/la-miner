import { Prisma } from '@miner/database';

/**
 * O SENTINELA DE ESCOPO — a segunda linha de defesa do isolamento entre clientes.
 *
 * ── POR QUE ISTO EXISTE, E POR QUE NÃO É ROW LEVEL SECURITY ──
 *
 * Hoje a fronteira entre escritórios é 100% aplicacional: cada `where` precisa
 * lembrar de `organizationId`, ou de compor `escopoProcessos`. Está correto nas
 * 300 e poucas chamadas de hoje — a exposição é a PRÓXIMA consulta que alguém
 * escrever. Não há nada no banco que segure o erro.
 *
 * A resposta óbvia seria RLS no Postgres. Foi medida e recusada, e não por
 * preguiça — por cinco impedimentos, cada um suficiente sozinho:
 *
 *  1. A aplicação conecta como DONO das tabelas (a Render injeta a string de
 *     conexão do papel dono). Dono ignora policy por padrão; só `FORCE` alcança
 *     — e `FORCE` alcançaria também o comando de migration do deploy.
 *  2. Não há papel com BYPASSRLS: conceder exige superusuário, que não temos.
 *  3. As rotas ADMIN legítimas são cross-tenant por desenho. A distribuição
 *     pergunta "processos da org INTERNA que a org CLIENTE ainda não recebeu" —
 *     duas organizações na mesma linha. Nenhum valor único de "organização
 *     atual" satisfaz isso, e os crons rodam sem usuário nenhum.
 *  4. Cobertura quase nula onde mais importa: dos modelos do schema, só os 15
 *     abaixo têm `organizationId`. `Pessoa`, `Telefone`, `Email`, `Endereco`,
 *     `Enriquecimento` e `ConsultaCliente` — o dado pessoal que a LGPD cobra —
 *     NÃO têm coluna de tenant, porque a base é compartilhada por decisão de
 *     produto. RLS ali não é difícil: é impossível sem outro produto.
 *  5. As suítes de integração montam fixture com cliente próprio, sem variável
 *     de sessão. `FORCE` derrubaria todas de uma vez.
 *
 * Então a rede é aplicacional, e assume isso no nome. O que ela dá que o código
 * de hoje não dá: uma consulta em massa sobre tabela com dono, sem escopo no
 * filtro, deixa de passar silenciosamente. Na suíte ela BLOQUEIA; em produção
 * ainda AVISA — o porquê, e a condição para mudar, estão em `modoDoAmbiente`.
 *
 * ── O QUE ELA NÃO É ──
 *
 * Não é autorização. Não substitui `escopoProcessos` nem os guards. É um
 * detector de omissão: sabe dizer "faltou escopo", nunca "este escopo é o
 * correto". Um `where` com o `organizationId` ERRADO passa por ela — isso é
 * trabalho do guard e da revisão, e está dito aqui para ninguém confundir a
 * rede com o chão.
 */

export type ModoSentinela = 'desligado' | 'avisar' | 'bloquear';

/**
 * As ações que varrem a tabela, e por isso podem devolver linha de outro dono.
 *
 * De fora ficam `findUnique`, `findFirst`, `update`, `delete`, `create` e
 * `upsert`, e a razão é o padrão desta casa: verificar-e-agir. `crm.service`
 * confirma a organização com um `findFirst` escopado e SÓ ENTÃO chama
 * `update({ where: { id } })` — são dezenas de chamadas nessa forma. Bloqueá-las
 * derrubaria CRM, negociação e cobrança inteiros para proteger de um risco que a
 * verificação anterior já cobriu.
 */
export const ACOES_EM_MASSA: ReadonlySet<string> = new Set([
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

/**
 * Os modelos que TÊM dono, derivados do próprio schema em tempo de carga.
 *
 * Derivado, e não escrito à mão, de propósito: uma lista manual erra de duas
 * maneiras que ninguém percebe — o modelo novo que ganhou `organizationId` e
 * não foi somado (fica desprotegido) e o que perdeu a coluna e continua na
 * lista (barra consulta legítima). O `dmmf` é a mesma fonte que gera o client,
 * então a lista não tem como divergir do banco.
 *
 * Os nomes vêm em PascalCase — é assim que `params.model` chega no middleware.
 * Escrever em camelCase (o formato do `prisma.processoLiberado`) faria o
 * sentinela nunca disparar, e passar num teste distraído que só verificasse
 * "não quebrou nada".
 */
export const MODELOS_TENANT: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
    .map((m) => m.name),
);

/**
 * Teto de profundidade da caminhada pelo `where`.
 *
 * Filtro do CRM chega a cinco níveis (`AND` → relação → `some` → relação →
 * campo). Oito dá folga e ainda impede que um objeto com ciclo — que o Prisma
 * aceita montar — trave a requisição num laço.
 */
const PROFUNDIDADE_MAX = 8;

/** Chaves cujo valor é uma LISTA de sub-filtros, e não um filtro só. */
const COMPOSTAS = new Set(['AND', 'OR', 'NOT']);

/**
 * O filtro está ancorado na identidade da linha?
 *
 * `where: { id: ... }` no primeiro nível endereça linha por chave primária.
 * Acrescentar `organizationId` ali não protege nada — a linha já é uma só, e
 * quem a escolheu já sabia qual era. Marcar esses casos como omissão encheria o
 * caminho MAIS QUENTE do sistema de alarme: a autenticação atualiza
 * `refresh_tokens` e `users` por `id` a cada requisição, e o detector passaria a
 * gritar em toda chamada. Alarme falso constante não é um detector chato: é um
 * detector que alguém desliga na primeira sexta-feira.
 *
 * Só o PRIMEIRO NÍVEL conta. `{ processo: { id } }` filtra pela relação, não
 * pela linha — ali a ausência de escopo continua sendo ausência.
 */
function ancoradaNaChave(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(where, 'id');
}

/**
 * Existe `organizationId` em algum lugar deste filtro?
 *
 * Recursiva porque o escopo raramente está no topo. `escopoProcessos` devolve
 * `{ liberacoes: { some: { organizationId } } }` — o escopo mora dentro de uma
 * relação —, e a fila do CRM monta `{ AND: [ ...condicoes ] }`, um array. Olhar
 * só as chaves de primeiro nível reprovaria as duas formas mais usadas da casa
 * e encheria o log de alarme falso, que é como um detector morre.
 *
 * NUNCA percorre array que não seja de `AND`/`OR`/`NOT`: `id: { in: [250 uuids] }`
 * é o caso comum no cron de distribuição, e caminhar por ele seria custo por
 * elemento em troca de nada — uuid não contém filtro.
 */
export function temEscopoDeOrganizacao(where: unknown, profundidade = 0): boolean {
  if (profundidade > PROFUNDIDADE_MAX) return false;
  if (!where || typeof where !== 'object') return false;

  for (const [chave, valor] of Object.entries(where as Record<string, unknown>)) {
    if (chave === 'organizationId') return true;

    if (COMPOSTAS.has(chave)) {
      const ramos = Array.isArray(valor) ? valor : [valor];
      /* `some` e não `every`: um OR com um ramo escopado e outro não é
         ambíguo, e o sentinela é detector de OMISSÃO — quem escreveu um OR
         assim pensou no assunto. Reprovar aqui geraria alarme falso, e o
         alarme falso é o que faz alguém desligar o detector. */
      if (ramos.some((r) => temEscopoDeOrganizacao(r, profundidade + 1))) return true;
      continue;
    }

    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      if (temEscopoDeOrganizacao(valor, profundidade + 1)) return true;
    }
  }
  return false;
}

/**
 * A marca que declara "esta consulta é global DE PROPÓSITO".
 *
 * `Symbol.for` e não `Symbol()`: o registro global sobrevive a duas cópias do
 * módulo carregadas por caminhos diferentes, que é exatamente o que acontece
 * entre a API e a suíte de testes.
 */
export const MARCA_GLOBAL = Symbol.for('miner.escopoGlobal');

/**
 * Declara que uma consulta é cross-tenant por desenho, e por quê.
 *
 * Os crons varrem todas as assinaturas; a importação procura processo por
 * número em toda a base para não duplicar; a exclusão de cliente opera sobre a
 * organização-alvo, não a do ator. Nenhuma delas é erro — e nenhuma delas
 * deveria virar log de alarme toda madrugada.
 *
 * Devolve o MESMO tipo que recebeu, então nenhuma assinatura de função muda e o
 * typecheck das chamadas segue idêntico. A marca é NÃO ENUMERÁVEL e é removida
 * antes de o Prisma ver os argumentos: o motivo existe para o log e para quem
 * lê o código, nunca para o banco.
 */
export function escopoGlobal<T extends object>(motivo: string, args: T): T {
  Object.defineProperty(args, MARCA_GLOBAL, {
    value: motivo,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return args;
}

/**
 * O modo, lido do ambiente. Padrão BLOQUEAR na suíte (`NODE_ENV=test`), AVISAR
 * fora dela. `SENTINELA_ESCOPO` vence o padrão nos dois sentidos.
 *
 * ── COMO SE CHEGOU AQUI ──
 *
 * O detector entrou AVISANDO em todo lugar, porque medi antes de ligar: a suíte
 * de integração inteira acendia 29 combinações de `modelo.ação`, e a esmagadora
 * maioria era LEGÍTIMA — a exclusão do titular varre por PESSOA em todas as
 * organizações; os crons varrem todas as assinaturas sem usuário logado; o
 * fôlego mede a base da org INTERNA, que se identifica por `tipo`; a importação
 * procura processo por número em toda a base para não duplicar. Bloquear antes
 * de ler cada uma daria uma suíte vermelha, e a saída fácil seria espalhar a
 * marca sem ler — o que mataria o valor dela.
 *
 * Então foi em três passos, e os três estão feitos (22/09/2026): (1) avisar;
 * (2) cada legítima ganhou `escopoGlobal('motivo')` com a leitura que merecia, e
 * as que eram FALHA ganharam escopo de verdade — a última, o `deleteMany` das
 * parcelas de cessão, que apagava por `propostaId` sem a org; (3) com o log
 * limpo, a suíte passou a BLOQUEAR. Um inventário das 97 consultas em massa do
 * `src/` e dos scripts sobre tabela com dono não deixou nenhuma sem escopo, sem
 * âncora em `id` e sem marca.
 *
 * ── POR QUE A SUÍTE BLOQUEIA E A PRODUÇÃO AINDA AVISA ──
 *
 * A suíte é onde a omissão tem de doer: uma consulta nova sem escopo reprova no
 * `npm run test:int` da CI, antes do deploy — antes de qualquer dado sair.
 *
 * Em produção, bloquear transforma a omissão num 500. Numa rota de leitura é o
 * certo (falha fechado). Mas o sentinela não distingue rota de cron: um cron
 * que varre por desenho e escapou da marca simplesmente pararia de rodar — a
 * cobrança, por exemplo, à noite, sem ninguém olhando. Ligar em produção é
 * `SENTINELA_ESCOPO=bloquear` no `render.yaml`, e é uma decisão à parte: a
 * condição é o log de produção não trazer nenhum "Consulta sem escopo de
 * organização".
 */
export function modoDoAmbiente(env: NodeJS.ProcessEnv = process.env): ModoSentinela {
  const bruto = (env.SENTINELA_ESCOPO ?? '').trim().toLowerCase();
  if (bruto === 'desligado' || bruto === 'avisar' || bruto === 'bloquear') return bruto;
  return env.NODE_ENV === 'test' ? 'bloquear' : 'avisar';
}

/** O que o sentinela decidiu sobre uma chamada — isolado para ser testável sem banco. */
export function avaliar(params: {
  model?: string;
  action: string;
  args?: Record<string, unknown> | null;
}): { global: false; escopada: boolean } | { global: true; motivo: string } | null {
  if (!params.model || !MODELOS_TENANT.has(params.model)) return null;
  if (!ACOES_EM_MASSA.has(params.action)) return null;

  const marca = params.args ? (params.args as Record<symbol, unknown>)[MARCA_GLOBAL] : undefined;
  if (typeof marca === 'string') return { global: true, motivo: marca };

  const where = params.args?.where;
  if (ancoradaNaChave(where)) return null;

  return { global: false, escopada: temEscopoDeOrganizacao(where) };
}

/**
 * Pendura o sentinela num cliente Prisma.
 *
 * Recebe o cliente em vez de morar dentro do `PrismaService` porque a suíte de
 * integração monta um `PrismaClient` próprio — e é justamente lá que o modo
 * BLOQUEAR precisa valer. Um sentinela que só existisse na API seria um
 * sentinela que nunca reprova ninguém antes do deploy.
 */
export function registrarSentinela(
  cliente: { $use: (fn: (params: never, next: (p: never) => unknown) => unknown) => void },
  modo: ModoSentinela,
  avisar: (mensagem: string) => void,
): void {
  if (modo === 'desligado') return;

  cliente.$use(((
    params: { model?: string; action: string; args?: Record<string, unknown> | null },
    next: (p: unknown) => unknown,
  ) => {
    const veredito = avaliar(params);

    /* A marca sai ANTES do `next`: o Prisma valida os argumentos que recebe, e
       uma chave desconhecida — ainda que Symbol — é risco desnecessário numa
       biblioteca que não prometeu ignorá-la. */
    if (params.args && MARCA_GLOBAL in params.args) {
      delete (params.args as Record<symbol, unknown>)[MARCA_GLOBAL];
    }

    if (veredito && veredito.global === false && !veredito.escopada) {
      const onde = `${params.model}.${params.action}`;
      if (modo === 'bloquear') {
        throw new Error(
          `SENTINELA DE ESCOPO: ${onde} varre a tabela sem "organizationId" no filtro. ` +
            'Acrescente o escopo da organização (ou componha `escopoProcessos`). ' +
            'Se a consulta for cross-tenant DE PROPÓSITO, declare com ' +
            '`escopoGlobal(\'motivo\', { ... })` — a marca existe para o próximo ' +
            'leitor saber que a ausência foi decidida, e não esquecida.',
        );
      }
      avisar(`Consulta sem escopo de organização: ${onde}`);
    }

    return next(params);
  }) as never);
}
