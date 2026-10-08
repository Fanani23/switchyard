import { z } from 'zod';

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
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** Reject request bodies larger than this, in bytes. */
  BODY_LIMIT: z.coerce.number().int().min(1024).default(1_048_576),
});

export const env = envSchema.parse(process.env);
