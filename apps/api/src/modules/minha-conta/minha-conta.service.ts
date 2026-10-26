import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * EXPORTAÇÃO DOS DADOS DO PRÓPRIO CLIENTE (LGPD art. 18, V — portabilidade).
 *
 * O escritório assinante também é titular de dados: cadastro, usuários,
 * histórico financeiro. Esta rota devolve isso em formato legível por máquina,
 * sem depender de pedir a ninguém.
 *
 * ── O QUE NÃO SAI AQUI, E POR DECISÃO DO DONO ──
 *
 * A CARTEIRA NÃO ENTRA. Nem os processos liberados, nem — principalmente — os
 * telefones, e-mails e endereços dos titulares de precatório.
 *
 * A pergunta foi feita ao dono com os dois lados na mesa, e a resposta foi
 * "não". O lado que se perde é real e vale estar escrito: o escritório que
 * cancelar não leva a agenda de contatos que usava todo dia. O lado que se
 * ganha é maior: aqueles contatos são dados de MILHARES DE TERCEIROS que nunca
 * contrataram nada — nem conosco, nem com o escritório —, e concentrá-los num
 * arquivo único, baixável com um clique e fora de qualquer controle depois,
 * cria exatamente a superfície de vazamento que o resto deste sistema passou a
 * auditoria inteira tentando fechar.
 *
 * A portabilidade do art. 18, V é sobre OS DADOS DO TITULAR QUE PEDE. Os dados
 * do escritório são o cadastro, os usuários e o financeiro — e é isso que sai.
 * Os dados dos titulares de precatório pertencem a eles, e para esses existe
 * caminho próprio: `POST /titular/dados`, atendido pela Central de Privacidade.
 *
 * ── POR QUE A RESPOSTA DIZ O QUE NÃO TEM ──
 *
 * Uma exportação silenciosamente incompleta é pior que nenhuma: quem recebe
 * supõe que ali está tudo. Por isso o documento carrega a seção
 * `naoIncluido`, que nomeia o que ficou de fora e para onde ir. Custa três
 * linhas e evita a reclamação legítima de quem confiou no arquivo.
 */
@Injectable()
export class MinhaContaService {
  private readonly logger = new Logger(MinhaContaService.name);

  constructor(private readonly prisma: PrismaService) {}

  async exportar(ator: { id: string; organizationId: string }) {
    const org = await this.prisma.organization.findUnique({
      where: { id: ator.organizationId },
      /* Projeção por REMONTAGEM, campo a campo, e nunca `...usuario`.
         `User` guarda `senhaHash`, `mfaSegredo`, `mfaUltimoContador`,
         `senhaResetTokenHash`, `emailConfirmacaoTokenHash` e
         `familiaSessaoAtual` na MESMA tabela: um espalhamento distraído aqui
         entrega a senha e o segundo fator dentro de um arquivo que o cliente
         baixa e guarda onde quiser. */
      select: {
        nome: true,
        cnpj: true,
        telefone: true,
        tipo: true,
        ativo: true,
        criadoEm: true,
        usuarios: {
          select: {
            nome: true,
            email: true,
            papel: true,
            gestor: true,
            ativo: true,
            ultimoLoginEm: true,
            criadoEm: true,
          },
          orderBy: { criadoEm: 'asc' },
        },
        assinatura: {
          select: {
            status: true,
            inicioEm: true,
            proximaRenovacaoEm: true,
            pagoAte: true,
            canceladaEm: true,
            inadimplenteDesde: true,
            plano: { select: { nome: true, processosPorCiclo: true, preco: true } },
            faturas: {
              select: {
                competencia: true,
                valor: true,
                status: true,
                vencimentoEm: true,
                pagoEm: true,
                criadoEm: true,
              },
              orderBy: { competencia: 'desc' },
            },
            lotes: {
              select: { competencia: true, quantidadeAlvo: true, quantidadeLiberada: true },
              orderBy: { competencia: 'desc' },
            },
          },
        },
      },
    });
    if (!org) throw new NotFoundException('Organização não encontrada.');

    const assinatura = org.assinatura
      ? {
          status: org.assinatura.status,
          inicioEm: org.assinatura.inicioEm,
          proximaRenovacaoEm: org.assinatura.proximaRenovacaoEm,
          pagoAte: org.assinatura.pagoAte,
          canceladaEm: org.assinatura.canceladaEm,
          inadimplenteDesde: org.assinatura.inadimplenteDesde,
          plano: {
            nome: org.assinatura.plano.nome,
            processosPorCiclo: org.assinatura.plano.processosPorCiclo,
            /* Decimal do Prisma vira string, e não número: centavo em ponto
               flutuante é como se perde um centavo por linha num arquivo que a
               contabilidade do cliente vai somar. */
            preco: org.assinatura.plano.preco.toString(),
          },
          faturas: org.assinatura.faturas.map((f) => ({
            competencia: f.competencia,
            valor: f.valor.toString(),
            status: f.status,
            vencimentoEm: f.vencimentoEm,
            pagoEm: f.pagoEm,
            emitidaEm: f.criadoEm,
          })),
          ciclosRecebidos: org.assinatura.lotes.map((l) => ({
            competencia: l.competencia,
            processosPrometidos: l.quantidadeAlvo,
            processosEntregues: l.quantidadeLiberada,
          })),
        }
      : null;

    /* A trilha guarda CONTAGENS, jamais o documento. Gravar o conteudo aqui
       faria a exportacao criar, dentro de `audit_logs`, uma copia do e-mail e
       do telefone de cada usuario — e o cron de retencao nao limpa este campo.
       O mesmo raciocinio do acesso do titular. */
    await this.prisma.auditLog
      .create({
        data: {
          organizationId: ator.organizationId,
          userId: ator.id,
          acao: 'EXPORTAR_DADOS_DA_CONTA',
          entidade: 'Organization',
          entidadeId: ator.organizationId,
          dadosAntes: {
            usuarios: org.usuarios.length,
            faturas: assinatura?.faturas.length ?? 0,
            ciclos: assinatura?.ciclosRecebidos.length ?? 0,
          },
        },
      })
      .catch(() => undefined);

    this.logger.log(`Exportacao de dados da conta ${ator.organizationId} pedida por ${ator.id}.`);

    return {
      geradoEm: new Date(),
      organizacao: {
        nome: org.nome,
        documento: org.cnpj,
        telefone: org.telefone,
        tipo: org.tipo,
        ativa: org.ativo,
        clienteDesde: org.criadoEm,
      },
      usuarios: org.usuarios,
      assinatura,
      /**
       * O que NÃO está neste arquivo, dito por extenso.
       *
       * Uma exportação incompleta em silêncio é pior que nenhuma: quem recebe
       * supõe que ali está tudo. Nomear a ausência custa três linhas e evita a
       * reclamação de quem confiou no arquivo.
       */
      naoIncluido: {
        carteiraDeProcessos:
          'Os processos liberados a esta conta e os dados de contato dos titulares não ' +
          'entram nesta exportação. São dados de terceiros que não contrataram este serviço, e ' +
          'concentrá-los num arquivo único criaria um risco que não é do titular deste pedido.',
        comoOTitularPedeOsDadosDele:
          'Cada titular pode pedir os próprios dados pelo canal de privacidade ' +
          'publicado na Política. O pedido gera protocolo e prazo de resposta.',
        anotacoesEHistoricoDoCrm:
          'O texto que a sua equipe escreveu sobre titulares (anotações, observações de contato, ' +
          'tarefas) permanece na conta enquanto ela existir e não é exportado aqui.',
      },
    };
  }
}
