import { z } from 'zod';
import { INTERNAL_LIMITS, LIMITS } from './limits.js';

/**
 * Charset matches the database CHECK `^[a-z0-9][a-z0-9._-]{0,63}$`. Length is a separate
 * `.max()` so an over-long but otherwise valid key fails with a single size issue, which the
 * API reports as a 422 limit breach rather than a 400 format error.
 */
export const keySchema = z
  .string()
  .min(1)
  .max(LIMITS.flagKeyLength)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'must start with a-z or 0-9 and contain only a-z 0-9 . _ -');

/** Variant keys are values returned to application code, so case is allowed. */
export const variantKeySchema = z
  .string()
  .min(1)
  .max(LIMITS.flagKeyLength)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must start with a letter or digit and contain only letters, digits . _ -');

export const flagKindSchema = z.enum(['boolean', 'multivariate']);
export type FlagKind = z.infer<typeof flagKindSchema>;

/** Boolean flags are two-variant flags with fixed keys, in this declared order. */
export const BOOLEAN_VARIANTS = ['off', 'on'] as const;

export const clauseOpSchema = z.enum(['in', 'not_in']);
export type ClauseOp = z.infer<typeof clauseOpSchema>;

export const clauseSchema = z.object({
  attribute: z.string().min(1).max(INTERNAL_LIMITS.attributeNameLength),
  op: clauseOpSchema,
  values: z
    .array(z.string().max(INTERNAL_LIMITS.clauseValueLength))
    .min(1)
    .max(INTERNAL_LIMITS.valuesPerClause),
});
export type Clause = z.infer<typeof clauseSchema>;

export const segmentRuleSchema = z.object({
  kind: z.literal('segment'),
  clauses: z.array(clauseSchema).min(1).max(LIMITS.clausesPerSegmentRule),
  serve: variantKeySchema,
});
export type SegmentRule = z.infer<typeof segmentRuleSchema>;

/** Weights are percentages with at most two decimals: the bucket resolution is 0.01. */
const weightSchema = z
  .number()
  .min(0)
  .max(100)
  .refine((w) => Math.abs(w * 100 - Math.round(w * 100)) < 1e-9, 'at most two decimal places');

/** Weights in integer hundredths of a percent, which is the unit the engine compares in. */
export function toHundredths(weight: number): number {
  return Math.round(weight * 100);
}

/**
 * A percentage rule matches the share of users covered by its weights. Weights summing to
 * 100 match everyone; weights summing to less let the remaining users fall through to the
 * next rule, which is how "10% get `on`, everyone else keeps evaluating" is expressed.
 */
export const weightsSchema = z
  .record(variantKeySchema, weightSchema)
  .refine(
    (weights) => Object.values(weights).reduce((sum, w) => sum + toHundredths(w), 0) <= 10_000,
    'weights must sum to at most 100',
  );

export const percentageRuleSchema = z.object({
  kind: z.literal('percentage'),
  weights: weightsSchema,
});
export type PercentageRule = z.infer<typeof percentageRuleSchema>;

/** A rule as written through the Admin API. */
export const ruleSchema = z.discriminatedUnion('kind', [segmentRuleSchema, percentageRuleSchema]);
export type Rule = z.infer<typeof ruleSchema>;

/**
 * A percentage rule as shipped to SDKs. `salt` is the flag's salt, repeated on every
 * percentage rule of that flag so the SDK can bucket without other context. It is the
 * flag's salt, not a per-rule one, because a salt that changed when rules are replaced
 * would reshuffle every user and break monotonic rollout (A5).
 */
export const rulesetPercentageRuleSchema = percentageRuleSchema.extend({ salt: z.string() });
export const rulesetRuleSchema = z.discriminatedUnion('kind', [
  segmentRuleSchema,
  rulesetPercentageRuleSchema,
]);
export type RulesetRule = z.infer<typeof rulesetRuleSchema>;

export const rulesetFlagSchema = z.object({
  key: keySchema,
  kind: flagKindSchema,
  default: variantKeySchema,
  variants: z.array(z.object({ key: variantKeySchema })),
  rules: z.array(rulesetRuleSchema),
});
export type RulesetFlag = z.infer<typeof rulesetFlagSchema>;

export const rulesetResponseSchema = z.object({
  environmentId: z.uuid(),
  version: z.number().int(),
  flags: z.array(rulesetFlagSchema),
});
export type RulesetResponse = z.infer<typeof rulesetResponseSchema>;

/** What an application passes when evaluating: a user key plus arbitrary attributes. */
export interface EvaluationContext {
  key?: string;
  [attribute: string]: unknown;
}
