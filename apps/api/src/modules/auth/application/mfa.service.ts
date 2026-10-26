import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import type { Papel } from '@miner/database';
import { PrismaService } from '../../../prisma/prisma.service';
import { cifrarSegredo, decifrarSegredo } from './segredo-cifrado';
import { conferirComContador, gerarSegredo, paraBase32, uriDeProvisionamento } from './totp';

/** Quantos códigos de recuperação são entregues de uma vez. */
const QTD_CODIGOS = 10;
/** 10 bytes = 80 bits. Ver a nota do modelo sobre por que SHA-256 basta. */
const BYTES_POR_CODIGO = 10;

export type PoliticaMfa = 'nenhum' | 'admin' | 'todos';

/**
 * Segundo fator: cadastro, conferência e códigos de recuperação.
 *
 * O motor TOTP (`totp.ts`) não sabe nada de banco nem de usuário; este serviço é
 * quem liga o motor às pessoas — e é aqui que moram as decisões que a RFC não
 * toma por você: quando um código é gastado, o que acontece quando alguém erra,
 * e quem é obrigado a ter.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * A chave que cifra os segredos.
   *
   * OPCIONAL no ambiente, e isso é deliberado: exigi-la no boot quebraria todo
   * deploy existente na primeira subida depois desta mudança, para entregar um
   * recurso que ninguém ainda usa. Quem não a define simplesmente não consegue
   * ligar MFA — e recebe esta mensagem, em vez de um erro de criptografia.
   *
   * ⚠ Perder a chave depois de haver cadastros equivale a apagar os segredos: os
   * usuários entram pelos códigos de recuperação e cadastram de novo. Ela é
   * material de cofre, não de arquivo de configuração comum.
   */
  private chave(): string {
    const chave = this.config.get<string>('MFA_ENCRYPTION_KEY');
    if (!chave) {
      throw new ServiceUnavailableException(
        'MFA não está configurado neste ambiente (falta MFA_ENCRYPTION_KEY).',
      );
    }
    return chave;
  }

  politica(): PoliticaMfa {
    return this.config.get<PoliticaMfa>('MFA_OBRIGATORIO') ?? 'nenhum';
  }

  /** A política alcança este usuário? */
  exigidoPara(papel: Papel, gestor: boolean): boolean {
    const politica = this.politica();
    if (politica === 'todos') return true;
    /* `admin` cobre quem manda: o ADMIN da plataforma e o gestor de um
       escritório assinante. São as contas cujo roubo custa mais caro — a
       primeira enxerga a base inteira, a segunda comanda os acessos de uma
       organização. */
    if (politica === 'admin') return papel === 'ADMIN' || gestor;
    return false;
  }

  async situacao(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSegredo: true, mfaConfirmadoEm: true, papel: true, gestor: true },
    });

    return {
      habilitado: u.mfaConfirmadoEm !== null,
      /* Segredo gravado e não confirmado: alguém começou o cadastro e parou no
         meio. A tela precisa saber para oferecer "continuar" em vez de fingir
         que nada existe. */
      cadastroPendente: u.mfaSegredo !== null && u.mfaConfirmadoEm === null,
      obrigatorio: this.exigidoPara(u.papel, u.gestor),
      codigosDisponiveis: await this.prisma.mfaCodigoRecuperacao.count({
        where: { userId, usadoEm: null },
      }),
    };
  }

  /**
   * Passo 1: gera um segredo e devolve o QR.
   *
   * O segredo já é gravado (cifrado) aqui, mas SEM confirmação — porque o
   * telefone precisa dele para calcular o código que o passo 2 vai conferir, e
   * guardá-lo em memória entre as duas requisições não sobrevive a um restart
   * nem a duas instâncias.
   *
   * Enquanto `mfaConfirmadoEm` for nulo esse segredo não vale como fator: o
   * login não o consulta. Recomeçar o cadastro sobrescreve o anterior.
   */
  async iniciarCadastro(userId: string): Promise<{ segredo: string; uri: string }> {
    const usuario = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, mfaConfirmadoEm: true },
    });

    /* Já habilitado não recadastra por aqui. Se pudesse, quem alcançasse uma
       sessão aberta trocaria o segundo fator pelo SEU — e o dono perderia a
       conta sem nunca ver um erro. Desativar (que pede a senha) é o caminho. */
    if (usuario.mfaConfirmadoEm) {
      throw new BadRequestException(
        'O segundo fator já está ativo. Desative-o antes de cadastrar outro.',
      );
    }

    const segredo = gerarSegredo();
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfaSegredo: cifrarSegredo(segredo, this.chave()),
        mfaConfirmadoEm: null,
        mfaUltimoContador: null,
      },
    });

    return {
      segredo,
      uri: uriDeProvisionamento({
        segredoBase32: segredo,
        conta: usuario.email,
        emissor: 'Leão Amorim Miner',
      }),
    };
  }

  /**
   * Passo 2: o usuário digita um código do app e o cadastro é confirmado.
   *
   * A confirmação existe para provar que o telefone REALMENTE leu o segredo. Sem
   * ela, um QR mal escaneado só apareceria como problema no próximo login — com
   * o usuário trancado do lado de fora, sem código de recuperação nenhum.
   *
   * Os códigos de recuperação saem daqui, e é a ÚNICA vez que eles aparecem em
   * claro.
   */
  async confirmarCadastro(userId: string, codigo: string): Promise<{ codigos: string[] }> {
    const usuario = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { mfaSegredo: true, mfaConfirmadoEm: true },
    });

    if (usuario.mfaConfirmadoEm) {
      throw new BadRequestException('O segundo fator já está ativo.');
    }
    if (!usuario.mfaSegredo) {
      throw new BadRequestException('Nenhum cadastro em andamento. Comece pelo início.');
    }

    const segredo = decifrarSegredo(usuario.mfaSegredo, this.chave());
    const { confere, contador } = conferirComContador(segredo, codigo, agoraEmSegundos());
    if (!confere) {
      throw new BadRequestException('Código inválido. Confira o relógio do telefone e tente de novo.');
    }

    const codigos = Array.from({ length: QTD_CODIGOS }, () => gerarCodigoRecuperacao());

    /* Uma transação: confirmar sem gravar os códigos deixaria o usuário com MFA
       ligado e nenhuma saída se perdesse o telefone. */
    await this.prisma.$transaction([
      this.prisma.mfaCodigoRecuperacao.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { mfaConfirmadoEm: new Date(), mfaUltimoContador: BigInt(contador!) },
      }),
      this.prisma.mfaCodigoRecuperacao.createMany({
        data: codigos.map((c) => ({ userId, codigoHash: hashCodigo(c) })),
      }),
    ]);

    return { codigos };
  }

  /** Emite um jogo NOVO de códigos, invalidando os anteriores. Exige um código válido. */
  async renovarCodigos(userId: string, codigo: string): Promise<{ codigos: string[] }> {
    await this.exigirFatorValido(userId, codigo);

    const codigos = Array.from({ length: QTD_CODIGOS }, () => gerarCodigoRecuperacao());
    await this.prisma.$transaction([
      this.prisma.mfaCodigoRecuperacao.deleteMany({ where: { userId } }),
      this.prisma.mfaCodigoRecuperacao.createMany({
        data: codigos.map((c) => ({ userId, codigoHash: hashCodigo(c) })),
      }),
    ]);
    return { codigos };
  }

  /**
   * A SAÍDA DE EMERGÊNCIA: um ADMIN zera o segundo fator de outra pessoa.
   *
   * ── POR QUE ISTO PRECISA EXISTIR ──
   *
   * Com `MFA_OBRIGATORIO=todos`, quem perde o telefone usa um dos dez códigos de
   * recuperação. Quem perde o telefone E os códigos não tinha saída nenhuma pelo
   * sistema — e isso vai acontecer, porque trocar de aparelho sem migrar o app
   * autenticador é o erro mais comum que existe nesse terreno.
   *
   * A alternativa era o que restava antes desta função: `UPDATE` à mão na shell
   * do banco. Funciona e é péssimo — roda como superusuário, não reconfirma
   * quem está executando, e não deixa rastro nenhum de que o segundo fator de
   * alguém foi removido. Justamente a operação que mais precisa de rastro.
   *
   * ── AS TRÊS TRAVAS ──
   *
   * 1. A SENHA DO ADMIN é reconfirmada. Sessão aberta e desatendida não pode
   *    virar remoção de MFA alheio — é o mesmo raciocínio do `desativar`, e aqui
   *    pesa mais, porque o alvo é outra pessoa.
   * 2. O ALVO PRECISA SER DA MESMA ORGANIZAÇÃO. A rota já é restrita à operação
   *    interna pelo guard, mas o guard olha o ATOR; sem esta checagem, o id de um
   *    usuário de qualquer escritório cliente seria aceito no corpo.
   * 3. NINGUÉM ZERA O PRÓPRIO MFA por aqui. O caminho do próprio usuário é
   *    `desativar`, que a política de ambiente recusa quando o MFA é exigido.
   *    Sem esta trava, um ADMIN contornaria a política em uma requisição.
   *
   * ── O QUE NÃO SE FAZ, E POR QUÊ ──
   *
   * As sessões do alvo NÃO são revogadas. Ele fica no estado "nunca cadastrou":
   * o `MfaObrigatorioGuard` o barra na requisição seguinte e o leva à tela de
   * cadastro, onde resolve sozinho. Derrubar a sessão só o obrigaria a digitar a
   * senha de novo para chegar ao mesmo lugar.
   */
  async zerarDeOutroUsuario(
    ator: { id: string; organizationId: string },
    alvoId: string,
    senhaDoAtor: string,
    ctx: { ip?: string; userAgent?: string } = {},
  ): Promise<{ alvo: string; tinhaMfa: boolean }> {
    const admin = await this.prisma.user.findUniqueOrThrow({
      where: { id: ator.id },
      select: { senhaHash: true },
    });
    const ok = await verify(admin.senhaHash, senhaDoAtor).catch(() => false);
    if (!ok) {
      /* Erro de senha DEIXA RASTRO. Esta é a rota onde acertar a senha do admin
         vale o segundo fator alheio — uma campanha de adivinhação aqui não pode
         ser invisível. O log é o mínimo; o ideal é o mesmo contador de
         `tentativasFalhas`/`bloqueadoAte` do login, que hoje as três
         reconfirmações de senha do sistema não usam. */
      this.logger.warn(
        `Senha incorreta em mfa/zerar: ator=${ator.id} alvo=${alvoId} ip=${ctx.ip ?? '-'}`,
      );
      throw new UnauthorizedException('Senha incorreta');
    }

    const alvo = await this.prisma.user.findUnique({
      where: { id: alvoId },
      select: { id: true, email: true, organizationId: true, mfaConfirmadoEm: true },
    });
    /* Mesma resposta para "não existe" e "é de outra organização": distinguir
       transformaria a rota num oráculo de existência de usuário. E a busca vem
       DEPOIS do `verify` pela mesma razão — quem não sabe a senha não descobre
       daqui quem existe na plataforma. */
    if (!alvo || alvo.organizationId !== ator.organizationId) {
      throw new BadRequestException('Usuário não encontrado nesta organização.');
    }

    /**
     * ⚠ A COMPARAÇÃO USA `alvo.id`, O ID CANÔNICO DO BANCO — NUNCA `alvoId`.
     *
     * Esta linha já foi `if (ator.id === alvoId)`, lá em cima, antes da busca. E
     * era contornável: `@IsUUID('4')` aceita maiúsculas (o regex do
     * class-validator tem a flag `i`), a coluna é `@db.Uuid`, e o Postgres
     * compara uuid por VALOR — então `findUnique` acha a linha gravada em
     * minúsculo mesmo recebendo o id em caixa alta. Só a comparação de STRING em
     * JavaScript falhava.
     *
     * O efeito não era teórico: o ADMIN mandava o PRÓPRIO id em maiúsculo,
     * escapava desta trava e zerava o próprio segundo fator. Daí seguia para
     * `/auth/mfa/cadastrar` — que só recusa recadastro enquanto há MFA ativo — e
     * registrava o autenticador DELE. Quem tivesse a sessão e a senha do admin
     * passava a ter a conta em definitivo, e o telefone do dono parava de valer.
     * As duas travas que existem contra exatamente isso (o recadastro em
     * `iniciarCadastro` e a recusa de `desativar` sob política) eram puladas.
     *
     * Comparando o que o banco devolve, a caixa do que veio no corpo deixa de
     * importar. O `@Transform` no DTO é a segunda camada, não a primeira.
     */
    if (alvo.id === ator.id) {
      throw new BadRequestException(
        'Use "desativar" para o próprio segundo fator. Esta rota é para desbloquear OUTRA pessoa.',
      );
    }

    const tinhaMfa = alvo.mfaConfirmadoEm !== null;

    await this.prisma.$transaction([
      this.prisma.mfaCodigoRecuperacao.deleteMany({ where: { userId: alvo.id } }),
      this.prisma.user.update({
        where: { id: alvo.id },
        data: { mfaSegredo: null, mfaConfirmadoEm: null, mfaUltimoContador: null },
      }),
      /* O registro é o motivo de esta rota existir, e não um detalhe: sem ele,
         removeu-se um fator de autenticação e ninguém sabe quem fez nem quando.
         `userId` é o ATOR (quem responde pela ação) e `entidadeId` é o ALVO — a
         mesma convenção do resto da trilha. Nada de senha ou segredo no corpo:
         só o que aconteceu. */
      this.prisma.auditLog.create({
        data: {
          organizationId: ator.organizationId,
          userId: ator.id,
          acao: 'MFA_ZERADO_POR_ADMIN',
          entidade: 'User',
          /* `alvo.id`, e não `alvoId`: `AuditLog.entidadeId` é String sem
             `@db.Uuid`, então guardaria literalmente a caixa que veio no corpo.
             Um relatório de "quem mexeu no MFA deste usuário" filtrando pelo id
             canônico não encontraria o evento — rastro que existe e não é
             achável não presta contas de nada. */
          entidadeId: alvo.id,
          ip: ctx.ip,
          userAgent: ctx.userAgent?.slice(0, 500),
          dadosAntes: { mfaHabilitado: tinhaMfa },
          dadosDepois: { mfaHabilitado: false },
        },
      }),
    ]);

    this.logger.warn(
      `MFA de ${alvo.email} zerado pelo admin ${ator.id}. ` +
        'A pessoa entra com a senha e cadastra o segundo fator de novo.',
    );
    return { alvo: alvo.email, tinhaMfa };
  }

  /**
   * Desliga o segundo fator.
   *
   * Pede a SENHA, e não um código do app. O motivo é o cenário que importa: um
   * telefone desbloqueado com a sessão aberta. Quem o pegasse teria o app
   * autenticador em mãos — pedir um código ali não prova nada. A senha é o
   * fator que essa pessoa não tem.
   */
  async desativar(userId: string, senha: string): Promise<void> {
    const usuario = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { senhaHash: true, papel: true, gestor: true, organizationId: true },
    });

    const ok = await verify(usuario.senhaHash, senha).catch(() => false);
    if (!ok) throw new UnauthorizedException('Senha incorreta');

    if (this.exigidoPara(usuario.papel, usuario.gestor)) {
      throw new BadRequestException(
        'A política deste ambiente exige segundo fator para o seu perfil. Não é possível desativá-lo.',
      );
    }

    await this.prisma.$transaction([
      this.prisma.mfaCodigoRecuperacao.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { mfaSegredo: null, mfaConfirmadoEm: null, mfaUltimoContador: null },
      }),
    ]);

    await this.prisma.auditLog.create({
      data: {
        organizationId: usuario.organizationId,
        userId,
        acao: 'MFA_DESATIVADO',
        entidade: 'User',
        entidadeId: userId,
      },
    });
  }

  /**
   * Confere um código no login: TOTP do app OU código de recuperação.
   *
   * Devolve `false` — não lança — porque quem chama precisa contar a tentativa
   * errada antes de recusar.
   */
  async conferir(userId: string, codigo: string): Promise<boolean> {
    const usuario = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSegredo: true, mfaConfirmadoEm: true },
    });
    if (!usuario?.mfaSegredo || !usuario.mfaConfirmadoEm) return false;

    const limpo = codigo.trim().toUpperCase().replace(/[\s-]/g, '');

    /* Seis dígitos é o formato do app; qualquer outra coisa só pode ser código
       de recuperação (16 caracteres do alfabeto Base32). Sem essa separação, um
       código de recuperação numérico entraria no caminho do TOTP e falharia sem
       nunca ser procurado no banco. */
    if (/^\d{6}$/.test(limpo)) {
      const segredo = decifrarSegredo(usuario.mfaSegredo, this.chave());
      const { confere, contador } = conferirComContador(segredo, limpo, agoraEmSegundos());
      if (!confere) return false;

      /**
       * Replay: o mesmo código de seis dígitos vale por até 90 segundos, e
       * gastá-lo no primeiro uso é o que impede que ele sirva de novo.
       *
       * ⚠ A CONDIÇÃO VAI NO WHERE, e não num `if` antes do update — é a mesma
       * defesa que o caminho de código de recuperação, vinte linhas abaixo, já
       * usava, e pelo mesmo motivo.
       *
       * O que a versão com `if` deixava passar: ela lia `mfaUltimoContador`,
       * comparava em memória e só então gravava. Duas requisições SIMULTÂNEAS
       * com o mesmo código leem as duas o contador antigo — nenhuma enxerga a
       * escrita da outra —, passam as duas pela comparação e devolvem as duas
       * `true`. O anti-replay valia entre tentativas em SEQUÊNCIA e não valia
       * nada em paralelo, que é justamente como um código interceptado seria
       * reapresentado: ao mesmo tempo, para ganhar a corrida com o dono.
       *
       * Aqui quem compara é o banco, na mesma instrução que grava: contador
       * ESTRITAMENTE menor. Quem perde a corrida recebe `count = 0` e é
       * recusado.
       *
       * ── E O RAMO DO `null`? ──
       *
       * Ele NÃO é o "primeiro uso": `confirmarCadastro` grava o contador na
       * mesma transação em que grava `mfaConfirmadoEm`, e este método já
       * devolveu `false` lá em cima para quem não tem confirmação. O par
       * (confirmado, contador nulo) não acontece.
       *
       * O ramo fica por causa da assimetria do estrago. Sem ele, um contador
       * nulo com o MFA ativo faria TODA comparação dar `count = 0` — e a pessoa
       * jamais passaria pelo segundo fator, presa do lado de fora até um
       * administrador desligar o MFA. Com ele, o pior caso é um código valer uma
       * vez a mais. Uma trava de segurança pode errar para o lado de pedir de
       * novo; não pode errar para o lado de nunca deixar entrar.
       */
      const { count } = await this.prisma.user.updateMany({
        where: {
          id: userId,
          OR: [{ mfaUltimoContador: null }, { mfaUltimoContador: { lt: BigInt(contador!) } }],
        },
        data: { mfaUltimoContador: BigInt(contador!) },
      });
      if (count === 0) {
        /* Alguém já gastou este contador — o próprio dono repetindo o código,
           ou outra requisição no mesmo instante. As duas leituras merecem a
           mesma linha de log: é por ela que um replay aparece. */
        this.logger.warn(`Código TOTP repetido recusado (userId=${userId}).`);
        return false;
      }
      return true;
    }

    /* Busca pelo HASH, não pelo código: o banco nunca vê o valor em claro, e a
       busca continua indexada (unique em `codigoHash`) em vez de varrer as dez
       linhas comparando. */
    const registro = await this.prisma.mfaCodigoRecuperacao.findUnique({
      where: { codigoHash: hashCodigo(limpo) },
      select: { id: true, userId: true, usadoEm: true },
    });

    /* `userId` conferido aqui: o hash é único na tabela INTEIRA, então sem esta
       comparação o código de um usuário abriria a conta de outro. */
    if (!registro || registro.userId !== userId || registro.usadoEm) return false;

    /* `updateMany` com `usadoEm: null` na condição, e não `update`: duas
       requisições simultâneas com o mesmo código passariam as duas pelo `if`
       acima. Aqui só uma encontra a linha ainda não usada. */
    const { count } = await this.prisma.mfaCodigoRecuperacao.updateMany({
      where: { id: registro.id, usadoEm: null },
      data: { usadoEm: new Date() },
    });
    if (count === 0) return false;

    this.logger.log(`Entrada por código de recuperação (userId=${userId}).`);
    return true;
  }

  /** Igual ao `conferir`, mas lança — para as rotas já autenticadas. */
  private async exigirFatorValido(userId: string, codigo: string): Promise<void> {
    if (!(await this.conferir(userId, codigo))) {
      throw new UnauthorizedException('Código inválido');
    }
  }
}

function agoraEmSegundos(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Código de recuperação: 16 caracteres Base32, mostrados em dois grupos.
 *
 * Base32 e não hexadecimal por causa de quem digita: o alfabeto não tem 0/O nem
 * 1/I/L, que são os pares que geram "meu código não funciona".
 */
function gerarCodigoRecuperacao(): string {
  const bruto = paraBase32(randomBytes(BYTES_POR_CODIGO));
  return `${bruto.slice(0, 8)}-${bruto.slice(8, 16)}`;
}

/** Normaliza e hasheia. O traço e a caixa são só apresentação. */
function hashCodigo(codigo: string): string {
  const limpo = codigo.trim().toUpperCase().replace(/[\s-]/g, '');
  return createHash('sha256').update(limpo).digest('hex');
}
