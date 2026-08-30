import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { registerAuthRoutes } from './auth.js';
import { config } from './config.js';
import { pingDatabase } from './db.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'body.password', 'body.temporaryPassword', 'body.refreshToken']
    },
    trustProxy: true
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: false,
    credentials: false
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute'
  });
  await app.register(jwt, {
    secret: config.JWT_ACCESS_SECRET
  });

  app.get('/api/v2/health', async (_request, reply) => {
    const database = await pingDatabase().catch(() => false);
    if (!database) return reply.code(503).send({ status: 'degraded', database: 'down' });
    return { status: 'ok', database: 'up', version: '2.0.0-alpha.1' };
  });

  await registerAuthRoutes(app);

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    if (!reply.sent) reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}
