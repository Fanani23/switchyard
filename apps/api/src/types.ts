import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type {
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from 'fastify/types/utils.js';
import type { FastifyBaseLogger } from 'fastify/types/logger.js';
import type { Principal } from './auth/principal.js';

/** The app instance with Zod request/response inference wired in. */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` onRequest hook; null on routes that do not require a key. */
    principal: Principal | null;
  }
}
