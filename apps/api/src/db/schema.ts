import { sql, relations } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';

export const flagKind = pgEnum('flag_kind', ['boolean', 'multivariate']);
export const ruleKind = pgEnum('rule_kind', ['segment', 'percentage']);
export const keyScope = pgEnum('key_scope', ['admin', 'client']);

/** Flag keys are used in source code and in URLs, so the charset is restricted. */
const FLAG_KEY_PATTERN = '^[a-z0-9][a-z0-9._-]{0,63}$';

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('projects_slug_format', sql`${t.slug} ~ ${sql.raw(`'${FLAG_KEY_PATTERN}'`)}`)],
);

export const environments = pgTable(
  'environments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    key: text('key').notNull(),
    /**
     * Incremented by a trigger on every change to this environment's flags, variants or
     * rules. SDKs compare it to decide whether a pushed ruleset is new, which makes
     * redelivery harmless. A trigger rather than application code, so no write path can
     * forget to bump it.
     */
    rulesetVersion: integer('ruleset_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('environments_project_key_uq').on(t.projectId, t.key),
    check('environments_key_format', sql`${t.key} ~ ${sql.raw(`'${FLAG_KEY_PATTERN}'`)}`),
  ],
);

export const flags = pgTable(
  'flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    description: text('description'),
    kind: flagKind('kind').notNull(),
    /** Variant key served when no rule matches, or when the flag is disabled. */
    defaultVariant: text('default_variant').notNull(),
    /**
     * Per-flag hash salt. Without it two flags at the same percentage would select the
     * same users, correlating every rollout in the environment (spec A6).
     */
    salt: text('salt').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('flags_environment_key_uq').on(t.environmentId, t.key),
    index('flags_environment_idx').on(t.environmentId),
    check('flags_key_format', sql`${t.key} ~ ${sql.raw(`'${FLAG_KEY_PATTERN}'`)}`),
    check('flags_salt_not_blank', sql`length(${t.salt}) >= 8`),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flagId: uuid('flag_id')
      .notNull()
      .references(() => flags.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Declared order. Bucket ranges are assigned in this order, so it must be stable. */
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('variants_flag_key_uq').on(t.flagId, t.key),
    uniqueIndex('variants_flag_position_uq').on(t.flagId, t.position),
    check('variants_position_range', sql`${t.position} >= 0 AND ${t.position} < 10`),
  ],
);

export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flagId: uuid('flag_id')
      .notNull()
      .references(() => flags.id, { onDelete: 'cascade' }),
    /** Evaluation order. The first matching rule wins (spec A3). */
    position: integer('position').notNull(),
    kind: ruleKind('kind').notNull(),
    /**
     * Shape depends on kind, which is why this is jsonb rather than columns:
     *   segment    -> { clauses: [{ attribute, op, values }], serve: "<variantKey>" }
     *   percentage -> { weights: { "<variantKey>": 0-100, ... } }
     * The service validates the shape with Zod before writing; the CHECK below stops a
     * rule from being stored with no payload at all.
     */
    config: jsonb('config').notNull(),
  },
  (t) => [
    uniqueIndex('rules_flag_position_uq').on(t.flagId, t.position),
    index('rules_flag_idx').on(t.flagId),
    check('rules_position_range', sql`${t.position} >= 0 AND ${t.position} < 20`),
    check('rules_config_is_object', sql`jsonb_typeof(${t.config}) = 'object'`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /**
     * SHA-256 of the key. The plaintext is shown once at creation and never stored, so a
     * database disclosure does not hand over working credentials.
     */
    tokenHash: text('token_hash').notNull().unique(),
    /** Leading characters, stored so the dashboard can identify a key without holding it. */
    tokenPrefix: text('token_prefix').notNull(),
    scope: keyScope('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('api_keys_environment_idx').on(t.environmentId),
    check('api_keys_hash_length', sql`length(${t.tokenHash}) = 64`),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Deliberately no foreign key. A row that is never updated cannot participate in a
     * cascade: ON DELETE CASCADE would erase history with the environment, and SET NULL
     * is an UPDATE, which the append-only trigger must reject. Decoupling the log is what
     * lets "never modified after insert" be an absolute rule rather than a rule with an
     * exception the database itself uses.
     */
    environmentId: uuid('environment_id').notNull(),
    /** Denormalized so the entry stays readable after its environment is deleted. */
    environmentKey: text('environment_key').notNull(),
    /** Which key performed the change. Kept as text so the entry survives key deletion. */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('audit_log_environment_created_idx').on(t.environmentId, t.createdAt),
    index('audit_log_created_idx').on(t.createdAt),
    check('audit_log_has_a_side', sql`${t.before} IS NOT NULL OR ${t.after} IS NOT NULL`),
  ],
);

export const projectsRelations = relations(projects, ({ many }) => ({
  environments: many(environments),
}));

export const environmentsRelations = relations(environments, ({ one, many }) => ({
  project: one(projects, { fields: [environments.projectId], references: [projects.id] }),
  flags: many(flags),
  apiKeys: many(apiKeys),
}));

export const flagsRelations = relations(flags, ({ one, many }) => ({
  environment: one(environments, {
    fields: [flags.environmentId],
    references: [environments.id],
  }),
  variants: many(variants),
  rules: many(rules),
}));

export const variantsRelations = relations(variants, ({ one }) => ({
  flag: one(flags, { fields: [variants.flagId], references: [flags.id] }),
}));

export const rulesRelations = relations(rules, ({ one }) => ({
  flag: one(flags, { fields: [rules.flagId], references: [flags.id] }),
}));

export type Project = typeof projects.$inferSelect;
export type Environment = typeof environments.$inferSelect;
export type Flag = typeof flags.$inferSelect;
export type Variant = typeof variants.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
