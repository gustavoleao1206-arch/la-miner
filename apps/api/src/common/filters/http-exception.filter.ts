import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mascararDocumento } from '../mascarar-documento';

interface CorpoErro {
  statusCode: number;
  mensagem: string | string[];
  erro: string;
  caminho: string;
  timestamp: string;
  /** Identificador para casar o erro do cliente com a linha do log. */
  referencia: string;
}

/**
 * Filtro global. Duas garantias:
 *  1. O cliente nunca recebe stack trace, SQL ou detalhe interno.
 *  2. Todo erro 5xx vira uma linha de log com referência rastreável.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const referencia = randomUUID().slice(0, 8);

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let mensagem: string | string[] = 'Erro interno do servidor';
    let erro = 'Internal Server Error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resposta = exception.getResponse();
      if (typeof resposta === 'string') {
        mensagem = resposta;
        erro = exception.name;
      } else {
        const r = resposta as Record<string, unknown>;
        mensagem = (r.message as string | string[]) ?? exception.message;
        erro = (r.error as string) ?? exception.name;
      }
    }

    /**
     * ⚠ URL SANEADA ANTES DE IR PARA O LOG.
     *
     * Este filtro monta a PRÓPRIA linha de log, fora do serializer do pino que
     * o B2 saneou — então ele escapava daquela correção. Um 500 em
     * `/auditoria/consultas?cpfConsultado=390…` gravava o CPF em claro, e
     * justamente no caminho de erro, que é o mais copiado para fora quando
     * alguém pede ajuda com um problema.
     *
     * A mesma função do B2, para as duas fronteiras usarem uma regra só.
     */
    const url = mascararDocumento(req.url);

    // 5xx é falha nossa: loga completo. 4xx é erro do cliente: loga resumido.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${referencia}] ${req.method} ${url} → ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${referencia}] ${req.method} ${url} → ${status}: ${String(mensagem)}`);
    }

    const corpo: CorpoErro = {
      statusCode: status,
      mensagem,
      erro,
      /* No CORPO a URL vai inteira, de propósito: ela volta para quem já a
         enviou, e mascarar aqui esconderia do próprio cliente o que ele pediu.
         O que não pode é ir para o LOG, que é onde o dado fica. */
      caminho: req.url,
      timestamp: new Date().toISOString(),
      referencia,
    };

    res.status(status).json(corpo);
  }
}
