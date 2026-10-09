import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from './limits.js';
export * from './ruleset.js';
export * from './admin.js';
export * from './errors.js';
