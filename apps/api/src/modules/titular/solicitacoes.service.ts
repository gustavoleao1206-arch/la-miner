import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { StatusSolicitacaoTitular, TipoSolicitacaoTitular } from '@miner/database';

import { PrismaService } from '../../prisma/prisma.service';
import { TitularService } from './titular.service';

/**
 * O alfabeto do sufixo do protocolo — 32 símbolos, sem `I`, `O`, `0` e `1`.
 *
 * ── DUAS RAZÕES, E A PRIMEIRA FOI UM DEFEITO REAL ──
 *
 * A versão anterior tirava o sufixo de `randomBytes(4).toString('base64url')` e
 * removia o que não fosse alfanumérico. Só que base64url usa `-` e `_`: quando
 * um deles saía no sorteio, o sufixo terminava com MENOS de seis caracteres.
 * Acontecia em cerca de 17% dos protocolos — o bastante para o teste falhar de
 * vez em quando e passar na tentativa seguinte, que é o pior modo de falhar.
 * Protocolo de tamanho variável também colide mais, e colisão aqui é um pedido
 * de titular sobrescrevendo outro.
 *
 * A segunda razão é de uso: este número é lido em voz alta ao telefone e
 * digitado de volta. `I` e `1`, `O` e `0` são a fonte clássica do protocolo que
 * "não existe". Tirá-los custa dois símbolos do espaço e evita a ligação.
 *
 * 32 é potência de dois de propósito: `byte % 32` distribui sem viés, porque
 * 256 divide certinho. Com um alfabeto de tamanho arbitrário, os primeiros
 * símbolos sairiam mais que os últimos.
 */
const ALFABETO_PROTOCOLO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * A CENTRAL DE PRIVACIDADE — o processo, e não só o efeito.
 *
 * ── O QUE ESTAVA ERRADO ──
 *
 * `SolicitacaoTitular` existe no schema desde a primeira etapa, com protocolo,
 * tipo, status e prazo — e NENHUMA linha de código lia ou escrevia nela. A
 * tabela era citada como justificativa de várias decisões de arquitetura
 * ("um pedido de exclusão não conseguiria apagar isto") e nunca foi ligada a
 * rota nenhuma.
 *
 * O efeito existia: `TitularService.excluir` faz o trabalho pesado. O PROCESSO
 * não. Um pedido chegava por e-mail, alguém atendia, e não sobrava protocolo,
 * prazo nem prova de tempestividade — que é justamente o que se apresenta à
 * ANPD. A Política prometia "responderemos no prazo legal" sem nada que medisse
 * o prazo.
 *
 * ── POR QUE NÃO HÁ ROTA PÚBLICA DE AUTOATENDIMENTO ──
 *
 * A correção óbvia seria uma página onde o titular digita o próprio CPF. É a
 * perigosa. `Pessoa` não tem login, e-mail verificado nem qualquer credencial —
 * não existe como autenticar quem não é usuário do sistema. Uma rota assim vira
 * oráculo de enumeração: quem tiver uma lista de CPFs descobre quem está na
 * base, e o pedido de acesso entrega nome, telefone e endereço de qualquer um.
 *
 * Então o canal continua sendo o e-mail publicado na Política, e o que muda é
 * que agora ele DEIXA RASTRO: quem recebe registra aqui, o protocolo nasce, o
 * relógio começa a correr e o atendimento fica provado.
 */

@Injectable()
export class SolicitacoesService {
  private readonly logger = new Logger(SolicitacoesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly titular: TitularService,
  ) {}

  /**
   * Dias para responder.
   *
   * 15 é o prazo do art. 19, II da LGPD para a declaração completa de acesso.
   * Para os demais direitos a lei não fixa número, e a ANPD trata caso a caso —
   * por isso o valor é CONFIGURÁVEL e o padrão é o mais curto: prometer menos
   * tempo do que se tem é erro barato; o contrário não.
   *
   * ⚠ O número exato por tipo de pedido é VALIDAÇÃO JURÍDICA. O que o código
   * garante é que existe um prazo, que ele é medido e que aparece na tela.
   */
  private get prazoDias(): number {
    return Number(this.config.get('PRAZO_SOLICITACAO_TITULAR_DIAS', 15));
  }

  /**
   * `LGPD-20260821-K3F9QP` — data para quem lê, aleatório para não colidir.
   *
   * Sem contador sequencial de propósito: dois pedidos no mesmo instante
   * disputariam o mesmo número, e a saída seria uma transação a mais em troca
   * de um formato mais bonito. O `@unique` da coluna é a rede — e com 6
   * caracteres de base32 a chance de colisão no mesmo dia é desprezível.
   */
  private gerarProtocolo(agora: Date): string {
    const dia = agora.toISOString().slice(0, 10).replace(/-/g, '');
    const sufixo = Array.from(randomBytes(6), (b) => ALFABETO_PROTOCOLO[b % 32]).join('');
    return `LGPD-${dia}-${sufixo}`;
  }

  /** Registra um pedido que chegou pelo canal publicado. */
  async registrar(dados: {
    cpf: string;
    tipo: TipoSolicitacaoTitular;
    nome?: string;
    email?: string;
    descricao?: string;
  }) {
    const agora = new Date();
    const prazoLimite = new Date(agora.getTime() + this.prazoDias * 86_400_000);

    const solicitacao = await this.prisma.solicitacaoTitular.create({
      data: {
        protocolo: this.gerarProtocolo(agora),
        /* O CPF fica em claro, e é coerente com o resto: `excluir` preserva CPF
           e nome porque vêm do precatório, que é ato público. Alguém vai notar
           e achar que é esquecimento — não é. Sem o CPF, o pedido não tem como
           ser ligado à pessoa na hora de atender. */
        cpf: dados.cpf,
        nome: dados.nome ?? null,
        email: dados.email ?? null,
        tipo: dados.tipo,
        descricao: dados.descricao ?? null,
        prazoLimite,
      },
    });

    /* Sem o CPF no log: a linha do banco é apagável, a do log não. */
    this.logger.log(
      `Pedido de titular registrado: ${solicitacao.protocolo} (${dados.tipo}), ` +
        `prazo até ${prazoLimite.toISOString().slice(0, 10)}.`,
    );
    return solicitacao;
  }

  /** Fila de atendimento — o que vence primeiro aparece primeiro. */
  async listar(filtros: { status?: StatusSolicitacaoTitular }) {
    const pedidos = await this.prisma.solicitacaoTitular.findMany({
      where: filtros.status ? { status: filtros.status } : {},
      /* Em aberto por PRAZO (o que vence antes é o que importa); resolvido por
         data de resposta. Ordenar tudo por prazo deixaria pedido já atendido
         disputando o topo com quem ainda espera. */
      orderBy: [{ status: 'asc' }, { prazoLimite: 'asc' }],
      take: 200,
    });

    const agora = Date.now();
    return pedidos.map((p) => ({
      ...p,
      /* Calculado na leitura, nunca guardado: prazo gravado envelhece no banco
         e passa a mentir na tela sem ninguém tocar em nada. */
      diasParaVencer:
        p.prazoLimite === null
          ? null
          : Math.ceil((p.prazoLimite.getTime() - agora) / 86_400_000),
      vencido:
        p.prazoLimite !== null &&
        p.prazoLimite.getTime() < agora &&
        p.status !== 'ATENDIDA' &&
        p.status !== 'RECUSADA',
    }));
  }

  async porId(id: string) {
    const p = await this.prisma.solicitacaoTitular.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pedido não encontrado.');
    return p;
  }

  /** Anota andamento sem encerrar — o "estamos analisando" que a lei admite. */
  async atualizar(id: string, dados: { status?: StatusSolicitacaoTitular; resposta?: string }) {
    const atual = await this.porId(id);
    if (atual.status === 'ATENDIDA') {
      throw new BadRequestException('Este pedido já foi atendido e não pode ser reaberto.');
    }

    return this.prisma.solicitacaoTitular.update({
      where: { id },
      data: {
        ...(dados.status ? { status: dados.status } : {}),
        ...(dados.resposta ? { resposta: dados.resposta } : {}),
        ...(dados.status === 'ATENDIDA' || dados.status === 'RECUSADA'
          ? { respondidoEm: new Date() }
          : {}),
      },
    });
  }

  /**
   * EXECUTA o pedido, ligando o registro ao efeito.
   *
   * É esta função que faz a Central deixar de ser papelada: o mesmo clique que
   * marca "atendido" é o que apaga ou reúne o dado. Separar as duas coisas
   * criaria o pior estado possível — um protocolo dizendo que foi atendido sem
   * nada ter acontecido no banco.
   *
   * Só EXCLUSAO e ACESSO são executáveis hoje, porque são os dois que o produto
   * sabe fazer sozinho. Os demais (correção, oposição, portabilidade, revisão)
   * seguem pelo caminho manual, com a resposta escrita à mão — e é melhor
   * recusar com clareza do que fingir automação.
   */
  async atender(id: string, ator: { id: string; organizationId: string }) {
    const pedido = await this.porId(id);
    if (pedido.status === 'ATENDIDA') {
      throw new BadRequestException(`Pedido ${pedido.protocolo} já foi atendido.`);
    }

    if (pedido.tipo === 'EXCLUSAO') {
      const r = await this.titular.excluir(
        pedido.cpf,
        `Pedido ${pedido.protocolo} recebido em ${pedido.recebidoEm.toISOString().slice(0, 10)}`,
        ator.id,
      );
      const resumo =
        `Dados de contato removidos e processo retirado de circulação. ` +
        `Telefones: ${r.apagados.telefones}, e-mails: ${r.apagados.emails}, ` +
        `endereços: ${r.apagados.enderecos}, liberações revogadas: ${r.apagados.liberacoesRevogadas}.`;
      await this.atualizar(id, { status: 'ATENDIDA', resposta: resumo });
      return { protocolo: pedido.protocolo, tipo: pedido.tipo, resultado: r };
    }

    if (pedido.tipo === 'ACESSO' || pedido.tipo === 'PORTABILIDADE') {
      /* O documento NÃO é guardado na coluna `resposta`: ele traz telefone,
         e-mail e endereço, e `resposta` sobreviveria a um pedido de exclusão
         posterior — o atendimento do acesso viraria a cópia que a exclusão não
         alcança. Fica o registro DE QUE foi entregue; o conteúdo vai ao titular
         pelo canal de sempre. */
      const documento = await this.titular.dados(pedido.cpf, ator);
      await this.atualizar(id, {
        status: 'ATENDIDA',
        resposta: `Relatório de dados gerado em ${new Date().toISOString().slice(0, 10)} e enviado ao titular pelo canal do pedido.`,
      });
      return { protocolo: pedido.protocolo, tipo: pedido.tipo, documento };
    }

    throw new BadRequestException(
      `Pedido do tipo ${pedido.tipo} é atendido manualmente: escreva a resposta e mude o status. ` +
        'O sistema executa automaticamente apenas EXCLUSAO, ACESSO e PORTABILIDADE.',
    );
  }
}
