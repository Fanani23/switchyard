import {
  ruleSchema,
  type FlagDto,
  type Rule as RuleContract,
  type RulesetFlag,
} from '@switchyard/shared';
import type { Rule as RuleRow } from '../db/schema.js';
import type { FlagAggregate, NewRule } from './flags.repository.js';

/**
 * Rules are stored as `kind` plus a jsonb `config`. Reading them back goes through the same
 * Zod schema that admitted them, so a row edited by hand into an invalid shape fails here,
 * loudly, rather than shipping to every SDK.
 */
export function ruleFromRow(row: RuleRow): RuleContract {
  return ruleSchema.parse({ ...(row.config as Record<string, unknown>), kind: row.kind });
}

export function ruleToRow(rule: RuleContract): NewRule {
  if (rule.kind === 'segment') {
    return { kind: 'segment', config: { clauses: rule.clauses, serve: rule.serve } };
  }
  return { kind: 'percentage', config: { weights: rule.weights } };
}

/** A flag's state as an audit entry records it: the DTO without derived fields. */
export function toAuditSnapshot(aggregate: FlagAggregate): Omit<FlagDto, 'lastChangedBy'> {
  const { flag } = aggregate;
  return {
    id: flag.id,
    environmentId: flag.environmentId,
    key: flag.key,
    description: flag.description,
    kind: flag.kind,
    default: flag.defaultVariant,
    enabled: flag.enabled,
    variants: aggregate.variants.map((v) => ({ key: v.key })),
    rules: aggregate.rules.map(ruleFromRow),
    createdAt: flag.createdAt.toISOString(),
    updatedAt: flag.updatedAt.toISOString(),
  };
}

export function toFlagDto(aggregate: FlagAggregate, lastChangedBy: string | null): FlagDto {
  return { ...toAuditSnapshot(aggregate), lastChangedBy };
}

/**
 * The SDK-facing shape. A disabled flag ships with no rules, so every SDK serves its
 * default without needing to know about `enabled`; the ruleset shape stays exactly SPEC.md's.
 */
export function toRulesetFlag(aggregate: FlagAggregate): RulesetFlag {
  const { flag } = aggregate;
  return {
    key: flag.key,
    kind: flag.kind,
    default: flag.defaultVariant,
    variants: aggregate.variants.map((v) => ({ key: v.key })),
    rules: flag.enabled
      ? aggregate.rules.map((row) => {
          const rule = ruleFromRow(row);
          return rule.kind === 'percentage' ? { ...rule, salt: flag.salt } : rule;
        })
      : [],
  };
}
