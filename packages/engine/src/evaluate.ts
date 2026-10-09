import type { Clause, EvaluationContext, RulesetFlag, RulesetRule } from '@switchyard/shared';
import { murmur3_32 } from './murmur3.js';

/** Number of buckets: SPEC.md divides the hash into 0.00–99.99, i.e. 10,000 slots. */
export const BUCKETS = 10_000;

/**
 * The bucket as an integer slot, 0–9999. The engine compares in integer hundredths of a
 * percent so no floating-point rounding can move a user across a range boundary.
 */
export function bucketSlot(salt: string, userKey: string): number {
  return murmur3_32(`${salt}:${userKey}`) % BUCKETS;
}

/** `bucket(flagSalt, userKey)` exactly as written in SPEC.md: 0.00–99.99. */
export function bucket(salt: string, userKey: string): number {
  return bucketSlot(salt, userKey) / 100;
}

export type EvaluationReason = 'rule_match' | 'default' | 'error';

export interface EvaluationResult {
  variant: string;
  reason: EvaluationReason;
  /** Index of the matching rule, or null when the default was served. */
  ruleIndex: number | null;
}

/**
 * Evaluate one flag for one user. Never throws: any malformed input, from either the
 * ruleset or the context, yields the flag's default (or `fallback` when the flag has no
 * usable default), with reason `error`.
 */
export function evaluate(
  flag: RulesetFlag,
  context: EvaluationContext,
  fallback = '',
): EvaluationResult {
  try {
    return evaluateUnsafe(flag, context);
  } catch {
    const variant = isRecord(flag) && typeof flag.default === 'string' ? flag.default : fallback;
    return { variant, reason: 'error', ruleIndex: null };
  }
}

class MalformedRuleset extends Error {}

function evaluateUnsafe(flag: RulesetFlag, context: EvaluationContext): EvaluationResult {
  if (!isRecord(flag) || typeof flag.default !== 'string' || !Array.isArray(flag.rules)) {
    throw new MalformedRuleset('flag');
  }
  const ctx: Record<string, unknown> = isRecord(context) ? context : {};

  for (let i = 0; i < flag.rules.length; i++) {
    const served = matchRule(flag, flag.rules[i], ctx);
    if (served !== null) return { variant: served, reason: 'rule_match', ruleIndex: i };
  }
  return { variant: flag.default, reason: 'default', ruleIndex: null };
}

/** The variant a rule serves to this context, or null when the rule does not match. */
function matchRule(
  flag: RulesetFlag,
  rule: RulesetRule | undefined,
  ctx: Record<string, unknown>,
): string | null {
  if (!isRecord(rule)) throw new MalformedRuleset('rule');
  switch (rule.kind) {
    case 'segment': {
      if (!Array.isArray(rule.clauses) || typeof rule.serve !== 'string') {
        throw new MalformedRuleset('segment');
      }
      return rule.clauses.every((c) => matchClause(c, ctx)) ? rule.serve : null;
    }
    case 'percentage':
      return matchPercentage(flag, rule.weights, rule.salt, ctx);
    default:
      // A rule kind this engine does not know (for example, from a newer API) never
      // matches. Skipping it is safer for an SDK than refusing the whole flag.
      return null;
  }
}

function matchClause(clause: Clause, ctx: Record<string, unknown>): boolean {
  if (!isRecord(clause) || !Array.isArray(clause.values)) return false;
  // Own properties only: `toString` or `__proto__` must not resolve through the prototype.
  if (typeof clause.attribute !== 'string' || !Object.hasOwn(ctx, clause.attribute)) {
    return false;
  }
  const raw = ctx[clause.attribute];
  // A missing or non-scalar attribute never matches, for `not_in` as much as for `in`:
  // "we don't know this user's country" must not count as "country is not ID" (A8).
  if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    return false;
  }
  const value = String(raw);
  switch (clause.op) {
    case 'in':
      return clause.values.includes(value);
    case 'not_in':
      return !clause.values.includes(value);
    default:
      return false;
  }
}

/**
 * Variants occupy contiguous ranges in the flag's declared variant order, not in the order
 * of the `weights` object's keys: object key order is not something JSON guarantees, and
 * JavaScript reorders integer-like keys ahead of the rest.
 */
function matchPercentage(
  flag: RulesetFlag,
  weights: Record<string, number>,
  salt: string,
  ctx: Record<string, unknown>,
): string | null {
  if (!isRecord(weights) || typeof salt !== 'string' || !Array.isArray(flag.variants)) {
    throw new MalformedRuleset('percentage');
  }
  const userKey = ctx.key;
  // Without a key there is nothing stable to hash; the rule does not match.
  if (typeof userKey !== 'string' || userKey.length === 0) return null;

  const slot = bucketSlot(salt, userKey);
  for (const range of rangesFor(flag.variants, weights)) {
    if (slot < range.upper) return range.variant;
  }
  return null;
}

interface Range {
  variant: string;
  /** Exclusive upper bound, in slots (hundredths of a percent). */
  upper: number;
}

/**
 * Validated, cumulative ranges per percentage rule, computed once per rule object rather
 * than on every check. A ruleset is never mutated once parsed (the SDK replaces it whole),
 * so the memo is invisible except in speed: SPEC.md F2 runs a million checks a second, and
 * re-validating weights on each was most of their cost. Keyed weakly, so replaced rulesets
 * are collected; and checked against the variants it was built for. Malformed weights
 * throw and are never memoized.
 */
const ranges = new WeakMap<object, { variants: unknown; ranges: Range[] }>();

function rangesFor(variants: RulesetFlag['variants'], weights: Record<string, number>): Range[] {
  const memo = ranges.get(weights);
  if (memo && memo.variants === variants) return memo.ranges;

  const declared = new Set<string>();
  for (const v of variants) declared.add(v.key);
  for (const k of Object.keys(weights)) {
    if (!declared.has(k)) throw new MalformedRuleset(`weight for undeclared variant`);
  }
  let total = 0;
  for (const weight of Object.values(weights)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new MalformedRuleset('weight');
    }
    total += Math.round(weight * 100);
  }
  if (total > BUCKETS) throw new MalformedRuleset('weights exceed 100');

  const built: Range[] = [];
  let upper = 0;
  for (const variant of variants) {
    upper += Math.round((weights[variant.key] ?? 0) * 100);
    built.push({ variant: variant.key, upper });
  }
  ranges.set(weights, { variants, ranges: built });
  return built;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
