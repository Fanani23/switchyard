import { z } from 'zod';
import { LIMITS } from '@switchyard/shared';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url().default('postgres://starter:starter@localhost:5432/starter'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /** Comma-separated list of browser origins allowed to call this API. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  /** Admin API requests per window, per API key (SPEC.md: 100/minute). */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(LIMITS.adminRequestsPerMinute),
  /** `GET /v1/ruleset` requests per window, per API key (SPEC.md: 1,000/minute). */
  RULESET_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(LIMITS.rulesetRequestsPerMinute),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** Reject request bodies larger than this, in bytes (SPEC.md: 256 KB). */
  BODY_LIMIT: z.coerce.number().int().min(1024).default(LIMITS.requestBodyBytes),
  /**
   * Bootstrap credential for creating projects and environments, which no
   * environment-scoped key can do. Unset disables root access. Store it like any secret.
   */
  SWITCHYARD_ROOT_KEY: z
    .string()
    .min(32, 'SWITCHYARD_ROOT_KEY must be at least 32 characters')
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

export const env = envSchema.parse(process.env);
