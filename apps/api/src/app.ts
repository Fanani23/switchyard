import Fastify, { type FastifyError, type FastifyRequest } from 'fastify';
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
import { bearerToken, hashApiKey } from './auth/api-key.js';
import { createServices } from './container.js';
import { db as defaultDb, type Db } from './db/client.js';
import { env } from './env.js';
import { ConflictError, LimitExceededError, ValidationError } from './errors.js';
import { registerRoutes } from './http/routes.js';
import { postgresChangeFeed, type ChangeFeed } from './stream/change-feed.js';
import type { AppInstance } from './types.js';

export interface AppOptions {
  logLevel?: string;
  db?: Db;
  /** Root key plaintext; defaults to SWITCHYARD_ROOT_KEY. */
  rootKey?: string;
  authCacheTtlMs?: number;
  rateLimits?: { admin?: number; ruleset?: number };
  /** Run the 90-day audit cleanup on this interval; 0 or absent disables it. */
  auditPurgeIntervalMs?: number;
  /** SSE heartbeat; SPEC.md fixes it at 30 s, tests shorten it. */
  streamHeartbeatMs?: number;
  /** Source of ruleset change notifications; defaults to LISTEN on DATABASE_URL. */
  changeFeed?: ChangeFeed;
}

/** Friendly names for the limits in SPEC.md's table, keyed by the offending field path. */
const LIMIT_NAMES: Array<[RegExp, string]> = [
  [/^rules$/, 'Rules per flag exceeded'],
  [/^variants$/, 'Variants per flag exceeded'],
  [/^rules\.\d+\.clauses$/, 'Clauses per segment rule exceeded'],
  [/^(key|slug)$/, 'Key length exceeded'],
];

function dotted(instancePath: string): string {
  return instancePath.replace(/^\//, '').replaceAll('/', '.');
}

/**
 * A request whose only problems are size limits (too many items, too long a string) is a
 * 422 per SPEC.md, not a 400: the shape is right, it is just bigger than allowed. Any other
 * issue alongside makes it malformed, and malformed wins.
 */
function limitBreach(
  err: FastifyError,
  req: FastifyRequest,
): { error: string; limit: number; actual: number } | null {
  const issues = err.validation ?? [];
  const sizeOnly = issues.every(
    (i) => i.keyword === 'too_big' && (i.params.origin === 'array' || i.params.origin === 'string'),
  );
  const first = issues[0];
  if (!sizeOnly || !first) return null;

  const sources: Record<string, unknown> = {
    body: req.body,
    querystring: req.query,
    params: req.params,
  };
  let value: unknown = sources[err.validationContext ?? 'body'];
  for (const segment of first.instancePath.split('/').filter(Boolean)) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[segment]
        : undefined;
  }
  const path = dotted(first.instancePath);
  const limit = Number(first.params.maximum);
  return {
    error: LIMIT_NAMES.find(([re]) => re.test(path))?.[1] ?? `Limit exceeded: ${path}`,
    limit,
    actual: typeof value === 'string' || Array.isArray(value) ? value.length : limit + 1,
  };
}

export async function buildApp(opts: AppOptions = {}): Promise<AppInstance> {
  const bodyLimit = env.BODY_LIMIT;
  const app = Fastify({
    logger: opts.logLevel === 'silent' ? false : { level: opts.logLevel ?? env.LOG_LEVEL },
    bodyLimit,
    // Trust the proxy so rate limiting keys on the real client IP behind Fly/Vercel.
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const services = createServices(opts.db ?? defaultDb, {
    rootKey: opts.rootKey ?? env.SWITCHYARD_ROOT_KEY,
    authCacheTtlMs: opts.authCacheTtlMs,
    changeFeed: opts.changeFeed ?? postgresChangeFeed(env.DATABASE_URL),
    streamHeartbeatMs: opts.streamHeartbeatMs,
    onError: (err, context) => app.log.error({ err }, context),
  });
  // Streams never finish on their own; end them before the server waits for connections.
  app.addHook('preClose', async () => services.stream.closeAll());
  app.decorateRequest('principal', null);

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS, credentials: true });
  await app.register(rateLimit, {
    // SPEC.md limits per key, not per IP: many SDK instances share one egress IP, and one
    // abusive key must not spend the budget of others behind the same NAT. The token is
    // hashed so the limiter's store never holds a usable credential.
    keyGenerator: (req) => {
      const token = bearerToken(req.headers.authorization);
      return token ? `key:${hashApiKey(token)}` : `ip:${req.ip}`;
    },
    max: opts.rateLimits?.admin ?? env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    errorResponseBuilder: (_req, ctx) =>
      Object.assign(new Error('Too Many Requests'), { statusCode: ctx.statusCode }),
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Switchyard API', version: '0.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Request validation failed: the client's fault, safe to describe field by field.
    if (hasZodFastifySchemaValidationErrors(err)) {
      const breach = limitBreach(err, req);
      if (breach) return reply.status(422).send(breach);
      return reply.status(400).send({
        error: 'Validation failed',
        details: err.validation.map((i) => ({
          // instancePath is a JSON pointer such as "/name" or "/items/0/id".
          path: dotted(i.instancePath),
          message: i.message ?? 'invalid value',
        })),
      });
    }

    // Response serialization failed: our bug, never the client's. Say nothing specific.
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response did not match its declared schema');
      return reply.status(500).send({ error: 'Internal Server Error' });
    }

    // Domain errors: each is one row of SPEC.md's error table.
    if (err instanceof LimitExceededError) {
      return reply.status(422).send({ error: err.message, limit: err.limit, actual: err.actual });
    }
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.message, details: err.details });
    }
    if (err instanceof ConflictError) {
      return reply
        .status(409)
        .send(err.current ? { error: err.message, current: err.current } : { error: err.message });
    }

    // The request body limit is a SPEC.md limit, so it answers 422 like the others.
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const declared = Number(req.headers['content-length']);
      return reply.status(422).send({
        error: 'Request body too large',
        limit: bodyLimit,
        actual: Number.isFinite(declared) && declared > 0 ? declared : bodyLimit + 1,
      });
    }

    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'unhandled error');
      // Never leak an internal message: it can carry SQL, paths, or secrets.
      return reply.status(statusCode).send({ error: 'Internal Server Error' });
    }
    // Other 400s from Fastify itself (unparseable JSON, bad content type) keep the
    // 400 body shape: an error plus details the client can act on.
    if (statusCode === 400) {
      return reply
        .status(400)
        .send({ error: 'Malformed request', details: [{ path: '', message: err.message }] });
    }
    return reply.status(statusCode).send({ error: err.message });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));

  app.get(
    '/health',
    { config: { rateLimit: false }, schema: { response: { 200: healthResponseSchema } } },
    async () => ({ status: 'ok' as const, uptimeSeconds: process.uptime() }),
  );

  registerRoutes(app, {
    services,
    authenticate: async (req) => {
      req.principal = await services.auth.authenticate(req.headers.authorization);
    },
    rulesetRateLimit: opts.rateLimits?.ruleset ?? env.RULESET_RATE_LIMIT_MAX,
  });

  if (opts.auditPurgeIntervalMs) {
    const timer = setInterval(() => {
      services.audit
        .purgeExpired()
        .then((n) => n > 0 && app.log.info({ deleted: n }, 'purged expired audit entries'))
        .catch((err: unknown) => app.log.error({ err }, 'audit purge failed'));
    }, opts.auditPurgeIntervalMs);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return app;
}
