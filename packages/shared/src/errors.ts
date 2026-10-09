import { z } from 'zod';
import { flagSchema } from './admin.js';

/** Bodies for the error table in SPEC.md. */
export const errorResponseSchema = z.object({ error: z.string() });

export const validationErrorResponseSchema = z.object({
  error: z.string(),
  details: z.array(z.object({ path: z.string(), message: z.string() })),
});

export const limitErrorResponseSchema = z.object({
  error: z.string(),
  limit: z.number(),
  actual: z.number(),
});

/** 409 is either a duplicate key, or a stale `expectedUpdatedAt` carrying the current flag. */
export const conflictErrorResponseSchema = z.object({
  error: z.string(),
  current: flagSchema.optional(),
});
