import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { healthResponseSchema } from '@switchyard/shared';
import { env } from './env.js';
import type { AppInstance } from './types.js';

export interface AppOptions {
  logLevel?: string;
}

export async function buildApp(opts: AppOptions = {}): Promise<AppInstance> {
  const app = Fastify({
    logger: opts.logLevel === 'silent' ? false : { level: opts.logLevel ?? env.LOG_LEVEL },
    bodyLimit: env.BODY_LIMIT,
    // Trust the proxy so rate limiting keys on the real client IP behind Fly/Vercel.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW });

  await app.register(swagger, {
    openapi: { info: { title: 'Switchyard API', version: '0.0.0' } },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Request validation failed: the client's fault, safe to describe field by field.
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: err.validation.map((i) => ({
          // instancePath is a JSON pointer such as "/name" or "/items/0/id".
          path: i.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          message: i.message ?? 'invalid value',
        })),
      });
    }

    // Response serialization failed: our bug, never the client's. Say nothing specific.
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response did not match its declared schema');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'unhandled error');
      // Never leak an internal message: it can carry SQL, paths, or secrets.
      return reply.status(statusCode).send({ error: 'Internal Server Error' });
    }
    return reply.status(statusCode).send({ error: err.message });
  });

  app.get('/health', { schema: { response: { 200: healthResponseSchema } } }, async () => ({
    status: 'ok' as const,
    uptimeSeconds: process.uptime(),
  }));


  return app;
}
