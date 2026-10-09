import { and, asc, count, eq, gt, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import type { FlagKind } from '@switchyard/shared';
import type { Executor } from '../db/executor.js';
import { flags, rules, variants, type Flag, type Rule, type Variant } from '../db/schema.js';

/** A flag with its variants and rules, each in declared position order. */
export interface FlagAggregate {
  flag: Flag;
  variants: Variant[];
  rules: Rule[];
}

export interface NewFlag {
  environmentId: string;
  key: string;
  description: string | null;
  kind: FlagKind;
  defaultVariant: string;
  salt: string;
  enabled: boolean;
}

export interface FlagChanges {
  key?: string;
  description?: string | null;
  defaultVariant?: string;
  enabled?: boolean;
}

export interface NewRule {
  kind: Rule['kind'];
  config: Record<string, unknown>;
}

/**
 * `updated_at` is kept at millisecond precision and strictly increasing per flag, because
 * it doubles as the optimistic-concurrency token the dashboard echoes back as
 * `expectedUpdatedAt`. A JavaScript Date holds milliseconds; a microsecond timestamp would
 * never compare equal after the round trip, and two writes in one millisecond must still
 * produce two distinct tokens.
 */
const nowMs = sql`date_trunc('milliseconds', now())`;
const nextUpdatedAt = sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${flags.updatedAt} + interval '1 millisecond')`;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function withChildren(ex: Executor, rows: Flag[]): Promise<FlagAggregate[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((f) => f.id);
  const [variantRows, ruleRows] = await Promise.all([
    ex.select().from(variants).where(inArray(variants.flagId, ids)).orderBy(asc(variants.position)),
    ex.select().from(rules).where(inArray(rules.flagId, ids)).orderBy(asc(rules.position)),
  ]);
  return assemble(rows, variantRows, ruleRows);
}

/** Attaches children to their flags in one pass each, keeping each list's order. */
function assemble(rows: Flag[], variantRows: Variant[], ruleRows: Rule[]): FlagAggregate[] {
  const byId = new Map<string, FlagAggregate>();
  const out = rows.map((flag) => {
    const aggregate: FlagAggregate = { flag, variants: [], rules: [] };
    byId.set(flag.id, aggregate);
    return aggregate;
  });
  for (const v of variantRows) byId.get(v.flagId)?.variants.push(v);
  for (const r of ruleRows) byId.get(r.flagId)?.rules.push(r);
  return out;
}

export const flagsRepository = {
  async countInEnvironment(ex: Executor, environmentId: string): Promise<number> {
    const [row] = await ex
      .select({ n: count() })
      .from(flags)
      .where(eq(flags.environmentId, environmentId));
    return row?.n ?? 0;
  },

  /** Inserts a flag and its variants. Must run in a transaction: see the deferred trigger. */
  async insert(ex: Executor, flag: NewFlag, variantKeys: string[]): Promise<FlagAggregate> {
    const [created] = await ex
      .insert(flags)
      .values({ ...flag, createdAt: nowMs, updatedAt: nowMs })
      .returning();
    if (!created) throw new Error('insert returned no row');
    const variantRows = await ex
      .insert(variants)
      .values(variantKeys.map((key, position) => ({ flagId: created.id, key, position })))
      .returning();
    variantRows.sort((a, b) => a.position - b.position);
    return { flag: created, variants: variantRows, rules: [] };
  },

  async findById(ex: Executor, id: string): Promise<FlagAggregate | null> {
    const rows = await ex.select().from(flags).where(eq(flags.id, id));
    const [aggregate] = await withChildren(ex, rows);
    return aggregate ?? null;
  },

  /** Reads a flag and holds its row lock to the end of the transaction. */
  async findByIdForUpdate(ex: Executor, id: string): Promise<FlagAggregate | null> {
    const rows = await ex.select().from(flags).where(eq(flags.id, id)).for('update');
    const [aggregate] = await withChildren(ex, rows);
    return aggregate ?? null;
  },

  /** One page ordered by key, after `cursor` (a key), optionally filtered by substring. */
  async listPage(
    ex: Executor,
    environmentId: string,
    opts: { limit: number; cursor?: string; q?: string },
  ): Promise<{ items: FlagAggregate[]; total: number }> {
    const filter: SQL[] = [eq(flags.environmentId, environmentId)];
    if (opts.q) filter.push(ilike(flags.key, `%${escapeLike(opts.q)}%`));
    const where = and(...filter);

    const [rows, totals] = await Promise.all([
      ex
        .select()
        .from(flags)
        .where(opts.cursor ? and(where, gt(flags.key, opts.cursor)) : where)
        .orderBy(asc(flags.key))
        .limit(opts.limit),
      ex.select({ n: count() }).from(flags).where(where),
    ]);
    return { items: await withChildren(ex, rows), total: totals[0]?.n ?? 0 };
  },

  /** Every flag of an environment, for the ruleset. */
  /**
   * Every flag of an environment, for the ruleset. Children are selected by joining on the
   * environment rather than by a list of up to 500 flag ids, which is what the per-change
   * rebuild of a full ruleset spends its time on (Stage 6, F1).
   */
  async listAll(ex: Executor, environmentId: string): Promise<FlagAggregate[]> {
    const [rows, variantRows, ruleRows] = await Promise.all([
      ex.select().from(flags).where(eq(flags.environmentId, environmentId)).orderBy(asc(flags.key)),
      ex
        .select({ variant: variants })
        .from(variants)
        .innerJoin(flags, eq(flags.id, variants.flagId))
        .where(eq(flags.environmentId, environmentId))
        .orderBy(asc(variants.flagId), asc(variants.position)),
      ex
        .select({ rule: rules })
        .from(rules)
        .innerJoin(flags, eq(flags.id, rules.flagId))
        .where(eq(flags.environmentId, environmentId))
        .orderBy(asc(rules.flagId), asc(rules.position)),
    ]);
    return assemble(
      rows,
      variantRows.map((r) => r.variant),
      ruleRows.map((r) => r.rule),
    );
  },

  async update(ex: Executor, id: string, changes: FlagChanges): Promise<void> {
    await ex
      .update(flags)
      .set({ ...changes, updatedAt: nextUpdatedAt })
      .where(eq(flags.id, id));
  },

  /** Replaces the ordered rule list and advances the flag's `updated_at`. */
  async replaceRules(ex: Executor, flagId: string, newRules: NewRule[]): Promise<void> {
    await ex.delete(rules).where(eq(rules.flagId, flagId));
    if (newRules.length > 0) {
      await ex
        .insert(rules)
        .values(
          newRules.map((r, position) => ({ flagId, position, kind: r.kind, config: r.config })),
        );
    }
    await ex.update(flags).set({ updatedAt: nextUpdatedAt }).where(eq(flags.id, flagId));
  },

  async delete(ex: Executor, id: string): Promise<void> {
    await ex.delete(flags).where(eq(flags.id, id));
  },
};

export type FlagsRepository = typeof flagsRepository;
