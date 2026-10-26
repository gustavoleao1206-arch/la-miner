import { randomBytes } from 'node:crypto';

import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * ── O FIM DA VIDA DE UMA CONTA DE CLIENTE ──
 *
 * O painel sabia analisar cliente e não sabia removê-lo, então conta abandonada
 * ficava para sempre: ruído na lista de quem opera, e dado pessoal guardado sem
 * propósito — que é exatamente o que a LGPD chama de excesso.
 *
 * DUAS NATUREZAS, E QUEM ESCOLHE É O HISTÓRICO, NÃO O CLIQUE.
 *
 * Apagar de verdade destrói junto assinatura e faturas (o `onDelete: Cascade`
 * desce por `assinaturas`), e fatura paga é comprovação de receita — documento
 * fiscal, não linha de banco. Então:
 *
 *  • Conta que NUNCA pagou some inteira. É o caso do cadastro abandonado, que é
 *    justamente a poluição que se quer varrer.
 *  • Conta que já pagou é ANONIMIZADA: o dado pessoal vai embora (é o que a
 *    LGPD pede), o acesso morre, carteira e CRM são apagados — e assinatura e
 *    faturas ficam de pé (é o que a contabilidade pede). As duas exigências
 *    convivem porque atacam metades diferentes do registro.
 *
 * O BANCO TAMBÉM MANDA NESSA ESCOLHA. Medido nas constraints reais, não no
 * schema: `processos` e `importacoes` são RESTRICT. Um cliente que tenha
 * qualquer um dos dois não PODE ser apagado — o Postgres recusa. Isso não vira
 * erro na cara do administrador: vira mais um motivo para anonimizar. Uma tela
 * que oferece um botão e depois estoura violação de integridade é uma tela que
 * mente.
 *
 * `audit_logs` é SET NULL: a trilha sobrevive à exclusão, órfã. Por isso o
 * registro é gravado ANTES e carrega nome, documento e contagens DENTRO do
 * payload — um log que perdeu a referência e não guardou o essencial não prova
 * nada, e o dia em que alguém perguntar "quem apagou este cliente?" é
 * exatamente o dia em que ele precisa responder sozinho.
 */

/** Só dígitos: o admin digita com ou sem máscara, e as duas formas valem. */
const soDigitos = (v: string) => v.replace(/\D+/g, '');

export type ModoDeExclusao = 'EXCLUIDA' | 'ANONIMIZADA';

export interface SondagemDeExclusao {
  organizationId: string;
  nome: string;
  cnpj: string | null;
  modo: ModoDeExclusao;
  /** Por que este modo, em português, para a tela repetir sem interpretar. */
  motivo: string;
  faturasPagas: number;
  usuarios: number;
  processosNaCarteira: number;
  processosProprios: number;
  importacoes: number;
  /** Buscas registradas na trilha — o número que faltava, e que estourava. */
  consultas: number;
}

@Injectable()
export class ClientesService {
  private readonly logger = new Logger(ClientesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * O QUE VAI ACONTECER, ANTES DE ACONTECER.
   *
   * A tela mostra isto e só então oferece o botão. Exclusão é o tipo de ação em
   * que a surpresa não tem conserto — e o administrador que acha que está
   * apagando, quando na verdade vai anonimizar (ou o contrário), toma a decisão
   * errada com a informação errada.
   */
  async sondar(organizationId: string, orgDoAtor: string): Promise<SondagemDeExclusao> {
    const org = await this.carregarCliente(organizationId, orgDoAtor);

    const [faturasPagas, processosProprios, importacoes, consultas] = await Promise.all([
      this.prisma.fatura.count({
        where: { assinatura: { organizationId }, status: 'PAGA' },
      }),
      this.prisma.processo.count({ where: { organizationId } }),
      this.prisma.importacao.count({ where: { organizationId } }),
      /* A conta que faltava. `consultas_cliente.userId` é ON DELETE RESTRICT e
         nada apaga essas linhas — então uma org com trilha simplesmente NÃO
         pode ser apagada, e prometer o contrário entregava um 500 sem
         explicação. Escopo por `user`, e não por organização: a tabela guarda
         quem consultou, não a organização dele. */
      this.prisma.consultaCliente.count({ where: { user: { organizationId } } }),
    ]);

    const { modo, motivo } = this.decidir({ faturasPagas, processosProprios, importacoes, consultas });

    return {
      organizationId,
      nome: org.nome,
      cnpj: org.cnpj,
      modo,
      motivo,
      faturasPagas,
      usuarios: org._count.usuarios,
      processosNaCarteira: org._count.carteira,
      processosProprios,
      importacoes,
      consultas,
    };
  }

  /**
   * A ação destrutiva.
   *
   * `confirmacao` é o documento da conta digitado à mão. Clicar na linha errada
   * de uma lista é fácil; digitar o CNPJ de outra empresa, não. É a mesma ideia
   * do "digite o nome do repositório" — atrito de propósito, no único lugar
   * onde atrito salva.
   */
  async excluir(
    organizationId: string,
    confirmacao: string,
    ator: { userId: string; organizationId: string; ip?: string; userAgent?: string },
  ): Promise<{ modo: ModoDeExclusao; nome: string }> {
    const sondagem = await this.sondar(organizationId, ator.organizationId);

    /* Conta sem documento não tem o que digitar: nesse caso o nome exato faz o
       papel de confirmação. Nunca aceitar vazio — seria o mesmo que não pedir. */
    const esperado = sondagem.cnpj ? soDigitos(sondagem.cnpj) : sondagem.nome.trim();
    const recebido = sondagem.cnpj ? soDigitos(confirmacao ?? '') : (confirmacao ?? '').trim();
    if (!recebido || recebido !== esperado) {
      throw new BadRequestException(
        sondagem.cnpj
          ? 'Digite o CNPJ desta conta para confirmar a exclusão.'
          : 'Digite o nome exato desta conta para confirmar a exclusão.',
      );
    }

    /* ── A TRILHA VEM PRIMEIRO, E O QUE ELA GUARDA DEPENDE DO MODO ──
       Depois da exclusão o `organizationId` do log vira nulo (SET NULL), então
       o registro precisa bastar-se. Mas "bastar-se" quer dizer coisas
       diferentes nos dois caminhos, e tratá-los igual era o defeito:

       EXCLUIDA — a organização e os usuários deixam de existir. O log é o ÚNICO
       lugar que ainda sabe que aquela conta existiu, e uma trilha que não diz
       QUEM foi apagado não presta contas de nada. Nome e documento ficam, com
       amparo no art. 16, I: guardar para cumprir obrigação legal, aqui a de
       demonstrar o próprio atendimento.

       ANONIMIZADA — a organização CONTINUA no banco, com nome e documento
       removidos de propósito. Gravá-los aqui recriava, dentro de `audit_logs`,
       exatamente a cópia identificável que a operação existe para destruir — e o
       cron de retenção só limpa `ip` e `userAgent`, nunca este campo. Então
       ficam só os NÚMEROS; quem precisar ligar o registro à conta usa
       `entidadeId`, que é o uuid da organização que segue lá, anonimizada. */
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: ator.userId,
        acao: sondagem.modo === 'EXCLUIDA' ? 'EXCLUIR_CLIENTE' : 'ANONIMIZAR_CLIENTE',
        entidade: 'Organization',
        entidadeId: organizationId,
        ip: ator.ip,
        userAgent: ator.userAgent?.slice(0, 500),
        dadosAntes: {
          ...(sondagem.modo === 'EXCLUIDA'
            ? { nome: sondagem.nome, cnpj: sondagem.cnpj }
            : {}),
          faturasPagas: sondagem.faturasPagas,
          consultas: sondagem.consultas,
          usuarios: sondagem.usuarios,
          processosNaCarteira: sondagem.processosNaCarteira,
          processosProprios: sondagem.processosProprios,
          importacoes: sondagem.importacoes,
          motivo: sondagem.motivo,
        },
      },
    });

    if (sondagem.modo === 'EXCLUIDA') {
      /* A cascata faz o resto: usuários, carteira, liberações, CRM, etiquetas,
         assinatura e faturas em aberto. Medido nas constraints, não suposto. */
      await this.prisma.organization.delete({ where: { id: organizationId } });
      this.logger.warn(
        `Cliente EXCLUÍDO: "${sondagem.nome}" (${sondagem.cnpj ?? 'sem documento'}) — ` +
          `${sondagem.usuarios} usuário(s), ${sondagem.processosNaCarteira} na carteira. ` +
          `Ator: ${ator.userId}.`,
      );
      return { modo: 'EXCLUIDA', nome: sondagem.nome };
    }

    await this.anonimizar(organizationId);
    this.logger.warn(
      `Cliente ANONIMIZADO: "${sondagem.nome}" (${sondagem.cnpj ?? 'sem documento'}) — ` +
        `${sondagem.motivo} Assinatura e faturas preservadas. Ator: ${ator.userId}.`,
    );
    return { modo: 'ANONIMIZADA', nome: sondagem.nome };
  }

  // ── Bastidores ──

  /** Carrega e recusa tudo que não pode ser alvo. */
  private async carregarCliente(organizationId: string, orgDoAtor: string) {
    if (organizationId === orgDoAtor) {
      /* Não é zelo excessivo: o ADMIN opera de dentro de uma organização, e
         apagar a própria derrubaria a sessão dele no meio da transação. */
      throw new ForbiddenException('Você não pode excluir a sua própria organização.');
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        nome: true,
        cnpj: true,
        tipo: true,
        _count: { select: { usuarios: true, carteira: true } },
      },
    });
    if (!org) throw new NotFoundException('Cliente não encontrado.');

    if (org.tipo !== 'CLIENTE') {
      /* INTERNA é a Leão Amorim: dona da base inteira. Apagá-la não é um erro
         grave, é o fim do produto. */
      throw new ForbiddenException(
        'Esta é a organização interna, dona da base — ela não pode ser excluída.',
      );
    }

    return org;
  }

  /** A regra, isolada para ser testável sem banco e óbvia de ler. */
  private decidir(n: {
    faturasPagas: number;
    processosProprios: number;
    importacoes: number;
    consultas: number;
  }): { modo: ModoDeExclusao; motivo: string } {
    if (n.faturasPagas > 0) {
      return {
        modo: 'ANONIMIZADA',
        motivo:
          `Esta conta tem ${n.faturasPagas} fatura(s) paga(s), que são comprovação de ` +
          'receita. O dado pessoal será removido e o histórico financeiro preservado.',
      };
    }
    /* ── A TRILHA DE CONSULTA ──
       Vem ANTES do teste de processos e importações porque é a mais comum:
       basta o cliente ter usado a busca uma vez. `consultas_cliente` guarda
       quem viu qual CPF, é a prestação de contas perante a LGPD, e o art. 16
       admite guardar para cumprimento de obrigação legal — apagá-la a pedido
       destruiria justamente o registro que demonstra conformidade.

       Se ela não sai, a conta não sai por completo. A correção aqui não é fazer
       o DELETE funcionar: é parar de prometer o que o banco (com razão) recusa.
       A anonimização entrega o mesmo resultado que importa — a pessoa some,
       sobra um registro sem identidade. */
    if (n.consultas > 0) {
      return {
        modo: 'ANONIMIZADA',
        motivo:
          `Esta conta tem ${n.consultas} consulta(s) registrada(s) na trilha de acesso, que a lei ` +
          'manda preservar. O dado pessoal será removido e a trilha permanecerá sem identificação.',
      };
    }
    if (n.processosProprios > 0 || n.importacoes > 0) {
      return {
        modo: 'ANONIMIZADA',
        motivo:
          `Esta conta tem ${n.processosProprios} processo(s) e ${n.importacoes} importação(ões) ` +
          'no nome dela, que o banco protege contra exclusão. O dado pessoal será removido e ' +
          'esses registros preservados.',
      };
    }
    return {
      modo: 'EXCLUIDA',
      motivo: 'Esta conta nunca pagou e não tem registros protegidos: será removida por completo.',
    };
  }

  /**
   * Tira a PESSOA de dentro da conta e deixa o registro contábil.
   *
   * O documento vira nulo em vez de virar marcador: a coluna é `@unique` e
   * aceita vários nulos, e "não existe" é a representação honesta de um dado que
   * foi removido — marcador falso ainda é informação sobre quem era.
   */
  private async anonimizar(organizationId: string) {
    const usuarios = await this.prisma.user.findMany({
      where: { organizationId },
      select: { id: true },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.organization.update({
        where: { id: organizationId },
        data: {
          nome: `Cliente removido ${organizationId.slice(0, 8)}`,
          cnpj: null,
          telefone: null,
          ativo: false,
        },
      });

      for (const u of usuarios) {
        await tx.user.update({
          where: { id: u.id },
          data: {
            /* `@unique` no e-mail: cada um precisa de um valor próprio, e o
               domínio reservado `.invalid` (RFC 2606) garante que ninguém
               jamais entregue mensagem nele por acidente. */
            email: `removido-${u.id}@removido.invalid`,
            nome: 'Usuário removido',
            /* Hash aleatório e descartado: não existe senha que case com ele.
               Melhor que string fixa — string fixa é a mesma para todo mundo e
               um dia alguém descobre que ela é "senha inválida". */
            senhaHash: randomBytes(32).toString('hex'),
            ativo: false,
            mfaSegredo: null,
            mfaConfirmadoEm: null,
            mfaUltimoContador: null,
            emailConfirmacaoTokenHash: null,
            emailConfirmacaoExpiraEm: null,
            /* O par de redefinição de senha era o único esquecido: todos os
               outros tokens são limpos aqui, e um link de "esqueci minha senha"
               emitido antes da anonimização continuaria válido até vencer —
               dando a quem tivesse o e-mail original o poder de definir a senha
               de uma conta que deveria estar morta. */
            senhaResetTokenHash: null,
            senhaResetExpiraEm: null,
            /* Derruba quem estiver logado agora: sem isso, a conta anonimizada
               continuaria navegando com o token que já tinha em mãos. */
            familiaSessaoAtual: null,
            sessoesRevogadasEm: new Date(),
          },
        });
      }

      await tx.refreshToken.updateMany({
        where: { userId: { in: usuarios.map((u) => u.id) }, revogadoEm: null },
        data: { revogadoEm: new Date() },
      });

      /* Carteira e CRM são o conteúdo pessoal do cliente e não têm valor fiscal:
         saem. É também o que esvazia a poluição de verdade — assinatura e
         faturas são punhados de linhas; carteira são milhares. */
      await tx.carteiraProcesso.deleteMany({ where: { organizationId } });
      await tx.processoLiberado.deleteMany({ where: { organizationId } });
      await tx.anotacaoProcesso.deleteMany({ where: { organizationId } });
      await tx.contatoProcesso.deleteMany({ where: { organizationId } });
      await tx.tarefaProcesso.deleteMany({ where: { organizationId } });
      await tx.eventoProcesso.deleteMany({ where: { organizationId } });
      await tx.parcelaCessao.deleteMany({ where: { organizationId } });
      await tx.propostaNegociacao.deleteMany({ where: { organizationId } });
      await tx.etiqueta.deleteMany({ where: { organizationId } });

      /* A assinatura FICA (as faturas penduram nela), mas encerrada: nenhum cron
         deve emitir cobrança para uma conta que não existe mais. */
      await tx.assinatura.updateMany({
        where: { organizationId },
        data: { status: 'CANCELADA' },
      });
    });
  }
}
