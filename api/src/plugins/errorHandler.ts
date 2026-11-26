import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { activeSpan, recordError } from '../telemetry.js';

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  if ((error.statusCode ?? 500) < 500) {
    return reply.send(error);
  }

  request.log.error({ err: error }, 'erro interno');
  recordError(activeSpan(), error);
  return reply.status(500).send({
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    error: 'Internal Server Error',
    message: 'Erro interno no Jardim das Sombras',
  });
}
