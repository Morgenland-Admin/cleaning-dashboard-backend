import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { HttpError } from '../lib/http-errors.js';

const errorHandler: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.message, code: error.code ?? 'ERROR' });
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'Validation failed', code: 'VALIDATION', issues: error.flatten() });
    }
    request.log.error({ err: error }, 'unhandled error');
    const fastifyErr = error as { statusCode?: number; message: string };
    const status = fastifyErr.statusCode ?? 500;
    return reply.code(status).send({
      error: status >= 500 ? 'Internal Server Error' : fastifyErr.message,
      code: 'INTERNAL',
    });
  });
};

export default fp(errorHandler, { name: 'error-handler' });
