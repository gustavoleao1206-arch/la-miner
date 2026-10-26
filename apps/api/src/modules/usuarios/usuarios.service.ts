import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Papel } from '@miner/database';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/application/auth.service';
import { TokenService } from '../auth/application/token.service';
import type { UsuarioAutenticado } from '../../common/decorators/papeis.decorator';

/** Quem pede a operação. Sempre do JWT, nunca do corpo. */
export type Ator = Pick<UsuarioAutenticado, 'id' | 'papel' | 'organizationId' | 'tipo' | 'gestor'>;

/**
 * Quem pode administrar a equipe da PRÓPRIA organização.
 *
 * Duas portas de entrada, e as duas param no limite do próprio tenant: o ADMIN
 * da plataforma (que já administrava tudo) e o GESTOR, que é como o assinante
 * ganha autonomia sem ganhar alcance.
 */
export function podeGerenciarEquipe(ator: Ator): boolean {
  return ator.papel === 'ADMIN' || ator.gestor;
}

@Injectable()
export class UsuariosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  private exigirGestao(ator: Ator) {
    if (!podeGerenciarEquipe(ator)) {
      throw new ForbiddenException('Só um gestor pode administrar a equipe.');
    }
  }

  /**
   * O papel do NOVO usuário — a trava contra escalada de privilégio.
   *
   * Ninguém cria alguém com mais alcance do que tem. Só quem JÁ é ADMIN escolhe
   * papel; qualquer outro gera um par do seu próprio papel.
   *
   * ⚠ Por que não basta "cliente não escolhe": a senha do novo usuário é EXIBIDA
   * a quem o cria. Se um OPERADOR com gestão pudesse criar um ADMIN, ele leria a
   * senha e entraria como esse ADMIN — teria se promovido sozinho, sem tocar no
   * próprio registro. O mesmo caminho, partindo de um gestor CLIENTE, chegaria
   * aos dados de todos os assinantes da plataforma. Por isso o papel é DERIVADO
   * do ator, e o campo do corpo só é consultado quando ele já é ADMIN.
   */
  private papelParaNovo(ator: Ator, pedido?: Papel): Papel {
    if (ator.papel === 'ADMIN') return pedido ?? 'OPERADOR';
    return ator.papel;
  }

  /**
   * Alcance de cada papel na PLATAFORMA — a régua que ordena quem pode agir
   * sobre quem.
   *
   * ADMIN abre distribuição, cobrança e auditoria; OPERADOR abre importação,
   * fila e auditoria; CLIENTE abre só a carteira liberada a ele.
   */
  private static readonly ALCANCE: Record<Papel, number> = {
    ADMIN: 3,
    OPERADOR: 2,
    CLIENTE: 1,
  };

  /**
   * Ninguém MEXE em alguém com mais alcance do que tem.
   *
   * A mesma regra do `papelParaNovo`, que a auditoria mostrou faltar nos métodos
   * vizinhos. O ataque era direto e não precisava de nenhum truque: um OPERADOR
   * com `gestor` chamava `redefinirSenha` no ADMIN da própria organização, LIA A
   * SENHA EM CLARO na resposta (ela é devolvida de propósito, para o gestor
   * repassar ao colega) e entrava como ADMIN — sem tocar no próprio registro,
   * sem violar nenhuma checagem, sem deixar rastro.
   *
   * A cadeia estava toda aberta: `listar` já devolve o `papel` de todo mundo,
   * então o alvo era escolhido a olho; e o `jwt.strategy` relê o papel do banco,
   * de modo que o token emitido no login seguinte era ADMIN de verdade.
   *
   * Não atravessa tenant (numa org CLIENTE todo mundo é CLIENTE), mas entregava
   * a operação interna inteira a quem só deveria importar planilha.
   */
  private exigirAlcanceSobre(ator: Ator, alvo: { papel: Papel }) {
    if (UsuariosService.ALCANCE[alvo.papel] > UsuariosService.ALCANCE[ator.papel]) {
      throw new ForbiddenException(
        'Você não pode administrar um usuário com mais permissões que as suas.',
      );
    }
  }

  private readonly selecao = {
    id: true,
    nome: true,
    email: true,
    papel: true,
    gestor: true,
    ativo: true,
    ultimoLoginEm: true,
    criadoEm: true,
  } as const;

  // ── Assentos do plano ──

  /**
   * O teto de quem é CLIENTE e ficou sem assinatura.
   *
   * Não deveria acontecer — o cadastro público cria org e assinatura na mesma
   * transação —, mas se acontecer o padrão precisa ser o teto comercial, e não
   * "sem limite". Um `?? null` aqui transformaria a linha faltante numa conta
   * ilimitada, que é exatamente o oposto do que se está protegendo.
   */
  private static readonly ASSENTOS_SEM_PLANO = 5;

  /**
   * Quantos perfis a organização gasta e quantos o plano dela dá.
   *
   * ── QUEM CONTA ──
   *
   * Só os ATIVOS. Desativar alguém devolve o assento, porque o que o plano vende
   * é acesso simultâneo, não histórico: um escritório que trocou de estagiário
   * três vezes não pode ficar preso a três assentos mortos. Em troca, REATIVAR
   * volta a consumir — senão o teto seria contornado desativando e reativando à
   * vontade.
   *
   * ── `limite: null` = SEM TETO ──
   *
   * E só a operação interna cai nesse caso: ela não assina plano nenhum, e um
   * teto de 5 ali trancaria a própria equipe da Leão Amorim ao sexto operador.
   * O tipo vem do ATOR (do token), como todo o resto deste serviço.
   */
  private async assentos(ator: Ator): Promise<{ usados: number; limite: number | null }> {
    const usados = await this.prisma.user.count({
      where: { organizationId: ator.organizationId, ativo: true },
    });
    if (ator.tipo === 'INTERNA') return { usados, limite: null };

    const assinatura = await this.prisma.assinatura.findUnique({
      where: { organizationId: ator.organizationId },
      select: { plano: { select: { usuariosPorPlano: true } } },
    });
    return {
      usados,
      limite: assinatura?.plano.usuariosPorPlano ?? UsuariosService.ASSENTOS_SEM_PLANO,
    };
  }

  /** A mensagem é a mesma nas duas portas (convite e reativação) de propósito. */
  private recusarPorLotacao(limite: number): never {
    throw new ConflictException(
      `O seu plano permite ${limite} perfis e todos estão em uso. ` +
        'Desative alguém da equipe para abrir uma vaga.',
    );
  }

  private async exigirAssentoLivre(ator: Ator) {
    const { usados, limite } = await this.assentos(ator);
    if (limite !== null && usados >= limite) this.recusarPorLotacao(limite);
  }

  /** A equipe da própria organização. Nunca de outra. */
  async listar(ator: Ator) {
    this.exigirGestao(ator);
    /* Os assentos vêm JUNTO com a lista, e não numa rota à parte, porque a tela
       imprime "3 de 5" ao lado dos mesmos nomes: em duas requisições, o convite
       de outro gestor entre uma e outra faria a contagem discordar da lista logo
       abaixo dela. */
    const [usuarios, assentos] = await Promise.all([
      this.prisma.user.findMany({
        where: { organizationId: ator.organizationId },
        orderBy: [{ ativo: 'desc' }, { nome: 'asc' }],
        select: this.selecao,
      }),
      this.assentos(ator),
    ]);
    return { usuarios, assentos };
  }

  /**
   * Cria um colega na própria organização.
   *
   * A senha é gerada aqui e devolvida UMA vez — não há e-mail configurado, então
   * quem convida transmite a credencial pelo canal que quiser. O hash sai antes
   * de qualquer escrita porque argon2 leva ~100ms de propósito, e segurar
   * transação aberta nesse tempo prende conexão do pool à toa.
   */
  async criar(ator: Ator, dados: { nome: string; email: string; papel?: Papel; gestor?: boolean }) {
    this.exigirGestao(ator);
    /* Antes do hash: argon2 leva ~100ms e não faz sentido gastá-los para recusar
       logo em seguida. */
    await this.exigirAssentoLivre(ator);

    const email = dados.email.toLowerCase().trim();
    /* E-mail é @unique GLOBAL: sem esta checagem, cadastrar um e-mail que já
       existe em OUTRO tenant devolveria violação de constraint como 500 — e a
       mensagem de erro do banco confirmaria que aquele e-mail existe em algum
       lugar da plataforma. 409 genérico não revela onde. */
    const jaExiste = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (jaExiste) throw new BadRequestException('Já existe um usuário com este e-mail.');

    const senhaInicial = randomBytes(12).toString('base64url');
    const senhaHash = await AuthService.gerarHash(senhaInicial);

    const usuario = await this.prisma.user.create({
      data: {
        /* Do ATOR, nunca do corpo: é o que impede criar gente em outro tenant. */
        organizationId: ator.organizationId,
        email,
        nome: dados.nome.trim(),
        papel: this.papelParaNovo(ator, dados.papel),
        gestor: dados.gestor ?? false,
        senhaHash,
      },
      select: this.selecao,
    });

    /* CONFERE DE NOVO, agora com a linha gravada — e desfaz se estourou.
       Duas requisições simultâneas passam as duas pela checagem de cima: cada uma
       conta 4 de 5 antes de a outra inserir, e a organização acorda com 6 perfis
       pagando por 5. Verificar depois é o mesmo remédio que `atualizar` já usa
       para o último gestor, pelo mesmo motivo — a checagem prévia não enxerga a
       escrita alheia em READ COMMITTED.
       O usuário recém-criado ainda não tem nenhum vínculo, então apagá-lo não
       deixa órfão: é literalmente a linha que acabou de nascer.
       ⚠ No empate as DUAS desfazem, e a organização fica com a vaga sobrando em
       vez de estourada. Preferi errar para o lado que não cobra a mais: quem foi
       recusado clica de novo e entra. */
    const { usados, limite } = await this.assentos(ator);
    if (limite !== null && usados > limite) {
      await this.prisma.user.delete({ where: { id: usuario.id } });
      this.recusarPorLotacao(limite);
    }

    return {
      usuario,
      acesso: {
        email,
        senhaInicial,
        aviso: 'Senha exibida uma única vez. Entregue ao usuário e peça a troca no primeiro acesso.',
      },
    };
  }

  /**
   * Ativa/desativa e promove/rebaixa gestão.
   *
   * As duas travas de auto-trancamento moram aqui — e existem porque o estrago
   * é irreversível pela própria interface: uma organização sem nenhum gestor
   * ativo não consegue promover ninguém, e só sai disso por intervenção no banco.
   */
  async atualizar(ator: Ator, id: string, dados: { ativo?: boolean; gestor?: boolean }) {
    this.exigirGestao(ator);

    const alvo = await this.prisma.user.findFirst({
      where: { id, organizationId: ator.organizationId },
      select: { id: true, papel: true, gestor: true, ativo: true },
    });
    /* Filtrado por organização junto: sem isso, o UUID de um usuário de outro
       tenant passaria pela checagem e seria desativado daqui. Devolve "não
       encontrado" — o mesmo de um id inexistente, para não confirmar a
       existência do usuário alheio a quem estiver sondando. */
    if (!alvo) throw new NotFoundException('Usuário não encontrado nesta organização.');
    /* Desativar um ADMIN também é ato de poder: um gestor rebaixado poderia
       trancar a operação inteira. */
    this.exigirAlcanceSobre(ator, alvo);

    /* Reativar consome assento igual a convidar. Sem isto, o teto seria contornado
       por quem já tem gente desativada: desativa um, convida outro, reativa o
       primeiro — e o plano de 5 vira 6. Só quando o alvo está de fato INATIVO;
       um PATCH `{ativo: true}` em quem já está ativo não muda contagem nenhuma e
       não pode ser recusado por lotação. */
    if (dados.ativo === true && !alvo.ativo) {
      await this.exigirAssentoLivre(ator);
    }

    if (alvo.id === ator.id) {
      if (dados.ativo === false) {
        throw new BadRequestException('Você não pode desativar o próprio acesso.');
      }
      if (dados.gestor === false) {
        throw new BadRequestException('Você não pode remover a própria gestão.');
      }
    }

    const atualizado = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dados.ativo !== undefined ? { ativo: dados.ativo } : {}),
        ...(dados.gestor !== undefined ? { gestor: dados.gestor } : {}),
      },
      select: this.selecao,
    });

    /* Confere DEPOIS de gravar e desfaz se sobrou ninguém no comando. Verificar
       antes exigiria simular o resultado da própria escrita — e uma corrida entre
       dois gestores se rebaixando ao mesmo tempo passaria pelas duas checagens
       prévias e trancaria a organização assim mesmo. */
    const comandantes = await this.prisma.user.count({
      where: {
        organizationId: ator.organizationId,
        ativo: true,
        OR: [{ gestor: true }, { papel: 'ADMIN' }],
      },
    });
    if (comandantes === 0) {
      await this.prisma.user.update({
        where: { id },
        data: { ativo: alvo.ativo, gestor: alvo.gestor },
      });
      throw new BadRequestException(
        'A organização ficaria sem nenhum gestor ativo. Promova outra pessoa antes.',
      );
    }

    return atualizado;
  }

  /**
   * Redefine a senha de um colega — o caminho para "esqueci a senha" enquanto
   * não há e-mail configurado.
   *
   * Derruba TODAS as sessões do alvo: se a redefinição foi feita porque a conta
   * pode estar comprometida, deixar a sessão do invasor viva anularia o gesto.
   */
  async redefinirSenha(ator: Ator, id: string) {
    this.exigirGestao(ator);

    const alvo = await this.prisma.user.findFirst({
      where: { id, organizationId: ator.organizationId },
      select: { id: true, email: true, papel: true },
    });
    if (!alvo) throw new NotFoundException('Usuário não encontrado nesta organização.');
    /* A trava do ataque: sem ela, quem tem gestão redefine a senha de um ADMIN e
       a lê em claro logo abaixo. */
    this.exigirAlcanceSobre(ator, alvo);

    const senhaInicial = randomBytes(12).toString('base64url');
    const senhaHash = await AuthService.gerarHash(senhaInicial);

    const agora = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: {
          senhaHash,
          tentativasFalhas: 0,
          bloqueadoAte: null,
          /* Sem este marco, quem estava dentro seguia dentro por até 15 min: o
             access token é auto-contido e não morre com a revogação do refresh.
             Redefinir a senha de alguém é resposta a suspeita — não pode deixar
             um quarto de hora de acesso para o suspeito. */
          sessoesRevogadasEm: agora,
          /* E a sessão única some junto. O carimbo acima já derrubaria tudo,
             mas deixar o marco apontando para uma família morta faria o
             `rotacionar` concluir "outro login" onde houve redefinição de
             senha — e mandaria a pessoa para a explicação errada. */
          familiaSessaoAtual: null,
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: id, revogadoEm: null },
        data: { revogadoEm: agora },
      }),
      /* Redefinir a senha de outra pessoa é ato sensível e precisa de rastro:
         é por ele que se descobre, depois, quem teve acesso à conta de quem. */
      this.prisma.auditLog.create({
        data: {
          organizationId: ator.organizationId,
          userId: ator.id,
          acao: 'SENHA_REDEFINIDA',
          entidade: 'User',
          entidadeId: id,
        },
      }),
    ]);

    return {
      acesso: {
        email: alvo.email,
        senhaInicial,
        aviso: 'Senha exibida uma única vez. As sessões abertas deste usuário foram encerradas.',
      },
    };
  }

  /**
   * Encerra as sessões de alguém SEM mexer na conta.
   *
   * É o caso do desligamento e o da suspeita: até hoje as saídas eram desativar
   * o usuário (que o impede de voltar) ou redefinir a senha (que o obriga a
   * receber uma nova). Nenhuma das duas serve para "derrube os acessos e me
   * explique depois" — nem para o próprio usuário encerrar a sessão que
   * esqueceu aberta noutro computador.
   *
   * A mesma trava do A6 vale aqui: sem ela, quem tem gestão derrubaria as
   * sessões de um ADMIN. Não é escalada de privilégio, mas é negação de serviço
   * contra quem está acima — e não custa nada impedir.
   */
  async encerrarSessoes(ator: Ator, id: string) {
    this.exigirGestao(ator);

    const alvo = await this.prisma.user.findFirst({
      where: { id, organizationId: ator.organizationId },
      select: { id: true, nome: true, papel: true },
    });
    if (!alvo) throw new NotFoundException('Usuário não encontrado nesta organização.');
    this.exigirAlcanceSobre(ator, alvo);

    const { sessoesEncerradas } = await this.tokens.revogarTodasDoUsuario(id);

    /* Derrubar o acesso de alguém precisa de rastro — é por ele que se
       reconstrói, depois, quem tirou quem de dentro e quando. */
    await this.prisma.auditLog.create({
      data: {
        organizationId: ator.organizationId,
        userId: ator.id,
        acao: 'SESSOES_ENCERRADAS',
        entidade: 'User',
        entidadeId: id,
      },
    });

    return {
      usuario: alvo.nome,
      sessoesEncerradas,
      /* O que o operador precisa saber para não repetir a ação achando que
         não funcionou: o efeito é imediato, não em 15 minutos. */
      aviso: 'Efeito imediato: os tokens já emitidos foram recusados a partir de agora.',
    };
  }

  /** Sessões vivas de um usuário — para decidir se vale encerrar. */
  async sessoes(ator: Ator, id: string) {
    this.exigirGestao(ator);

    const alvo = await this.prisma.user.findFirst({
      where: { id, organizationId: ator.organizationId },
      select: { id: true, papel: true },
    });
    if (!alvo) throw new NotFoundException('Usuário não encontrado nesta organização.');
    this.exigirAlcanceSobre(ator, alvo);

    return this.tokens.sessoesDe(id);
  }
}
