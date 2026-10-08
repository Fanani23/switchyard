import { z } from 'zod';
import { INTERNAL_LIMITS, LIMITS } from './limits.js';
import {
  BOOLEAN_VARIANTS,
  flagKindSchema,
  keySchema,
  ruleSchema,
  variantKeySchema,
} from './ruleset.js';

const nameSchema = z.string().trim().min(1).max(INTERNAL_LIMITS.nameLength);
const timestampSchema = z.iso.datetime();

// ---------------------------------------------------------------------------------------
// Path parameters
// ---------------------------------------------------------------------------------------

export const projectIdParamsSchema = z.object({ projectId: z.uuid() });
export const envIdParamsSchema = z.object({ envId: z.uuid() });
export const flagIdParamsSchema = z.object({ flagId: z.uuid() });
export const keyIdParamsSchema = z.object({ keyId: z.uuid() });

// ---------------------------------------------------------------------------------------
// Projects and environments
// ---------------------------------------------------------------------------------------

export const createProjectBodySchema = z.object({ name: nameSchema, slug: keySchema });
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>;

export const createEnvironmentBodySchema = z.object({ name: nameSchema, key: keySchema });
export type CreateEnvironmentBody = z.infer<typeof createEnvironmentBodySchema>;

export const environmentSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  key: z.string(),
  rulesetVersion: z.number().int(),
  createdAt: timestampSchema,
});
export type EnvironmentDto = z.infer<typeof environmentSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: timestampSchema,
});
export type ProjectDto = z.infer<typeof projectSchema>;

/** The project list carries environments so the dashboard sidebar needs one request. */
export const projectWithEnvironmentsSchema = projectSchema.extend({
  environments: z.array(environmentSchema),
});
export const projectListResponseSchema = z.object({
  items: z.array(projectWithEnvironmentsSchema),
});

// ---------------------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------------------

const descriptionSchema = z.string().max(INTERNAL_LIMITS.descriptionLength);

export const createFlagBodySchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('boolean'),
      key: keySchema,
      description: descriptionSchema.optional(),
      default: z.enum(BOOLEAN_VARIANTS).default('off'),
      enabled: z.boolean().default(true),
    }),
    z.object({
      kind: z.literal('multivariate'),
      key: keySchema,
      description: descriptionSchema.optional(),
      variants: z
        .array(z.object({ key: variantKeySchema }))
        .min(2)
        .max(LIMITS.variantsPerFlag),
      default: variantKeySchema,
      enabled: z.boolean().default(true),
    }),
  ])
  .superRefine((body, ctx) => {
    if (body.kind !== 'multivariate') return;
    const keys = body.variants.map((v) => v.key);
    keys.forEach((key, i) => {
      if (keys.indexOf(key) !== i) {
        ctx.addIssue({ code: 'custom', path: ['variants', i, 'key'], message: 'duplicate variant key' });
      }
    });
    if (!keys.includes(body.default)) {
      ctx.addIssue({ code: 'custom', path: ['default'], message: 'must be one of the variant keys' });
    }
  });
export type CreateFlagBody = z.infer<typeof createFlagBodySchema>;

/**
 * `expectedUpdatedAt` is an optional precondition. The dashboard sends the `updatedAt` it
 * loaded; if someone else changed the flag since, the write is refused with 409 and the
 * current flag, which is what UX.md's conflict state (Reload or Overwrite) is built on.
 */
export const updateFlagBodySchema = z
  .object({
    key: keySchema.optional(),
    description: descriptionSchema.nullable().optional(),
    default: variantKeySchema.optional(),
    enabled: z.boolean().optional(),
    expectedUpdatedAt: timestampSchema.optional(),
  })
  .refine(
    (b) =>
      b.key !== undefined ||
      b.description !== undefined ||
      b.default !== undefined ||
      b.enabled !== undefined,
    'at least one of key, description, default, enabled is required',
  );
export type UpdateFlagBody = z.infer<typeof updateFlagBodySchema>;

export const replaceRulesBodySchema = z.object({
  rules: z.array(ruleSchema).max(LIMITS.rulesPerFlag),
  expectedUpdatedAt: timestampSchema.optional(),
});
export type ReplaceRulesBody = z.infer<typeof replaceRulesBodySchema>;

export const flagSchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  key: z.string(),
  description: z.string().nullable(),
  kind: flagKindSchema,
  default: z.string(),
  enabled: z.boolean(),
  variants: z.array(z.object({ key: z.string() })),
  rules: z.array(ruleSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  /** Actor of the most recent audit entry for this flag, for the flag list's "changed by". */
  lastChangedBy: z.string().nullable(),
});
export type FlagDto = z.infer<typeof flagSchema>;

export const listFlagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(INTERNAL_LIMITS.pageSize).default(50),
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor: z.string().max(LIMITS.flagKeyLength).optional(),
  /** Case-insensitive substring of the flag key. */
  q: z.string().max(LIMITS.flagKeyLength).optional(),
});
export type ListFlagsQuery = z.infer<typeof listFlagsQuerySchema>;

export const flagListResponseSchema = z.object({
  items: z.array(flagSchema),
  /** Flags matching the filter across all pages, so the UI can say how many remain. */
  total: z.number().int(),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------------------

export const keyScopeSchema = z.enum(['admin', 'client']);
export type KeyScope = z.infer<typeof keyScopeSchema>;

export const createKeyBodySchema = z.object({ name: nameSchema, scope: keyScopeSchema });
export type CreateKeyBody = z.infer<typeof createKeyBodySchema>;

export const apiKeySchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  name: z.string(),
  scope: keyScopeSchema,
  prefix: z.string(),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
});
export type ApiKeyDto = z.infer<typeof apiKeySchema>;

/** The only response that ever carries the plaintext key. */
export const createdApiKeySchema = apiKeySchema.extend({ key: z.string() });
export const apiKeyListResponseSchema = z.object({ items: z.array(apiKeySchema) });

// ---------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------

export const auditEntrySchema = z.object({
  id: z.uuid(),
  environmentId: z.uuid(),
  environmentKey: z.string(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  createdAt: timestampSchema,
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

export const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(INTERNAL_LIMITS.pageSize).default(50),
  cursor: z.uuid().optional(),
});
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;

export const auditListResponseSchema = z.object({
  items: z.array(auditEntrySchema),
  nextCursor: z.uuid().nullable(),
});
