import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import { auditLog, type AuditEntry } from '../db/schema.js';

export interface NewAuditEntry {
  environmentId: string;
  environmentKey: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
}

export const auditRepository = {
  async insert(ex: Executor, entry: NewAuditEntry): Promise<AuditEntry> {
    const [row] = await ex
      .insert(auditLog)
      .values({ ...entry, before: entry.before ?? null, after: entry.after ?? null })
      .returning();
    if (!row) throw new Error('insert returned no row');
    return row;
  },

  async findInEnvironment(
    ex: Executor,
    environmentId: string,
    id: string,
  ): Promise<AuditEntry | null> {
    const [row] = await ex
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.environmentId, environmentId), eq(auditLog.id, id)));
    return row ?? null;
  },

  /**
   * Newest first, keyset-paginated on (created_at, id). The cursor is compared in SQL
   * against the cursor row's own timestamp, so microsecond precision is never round-tripped
   * through a JavaScript Date (which keeps milliseconds) and no entry is skipped or repeated.
   */
  async listPage(
    ex: Executor,
    environmentId: string,
    opts: { limit: number; after?: AuditEntry },
  ): Promise<AuditEntry[]> {
    const { after } = opts;
    const cursor = after
      ? or(
          lt(auditLog.createdAt, sql`(SELECT created_at FROM audit_log WHERE id = ${after.id})`),
          and(
            eq(auditLog.createdAt, sql`(SELECT created_at FROM audit_log WHERE id = ${after.id})`),
            lt(auditLog.id, after.id),
          ),
        )
      : undefined;
    return ex
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.environmentId, environmentId), cursor))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(opts.limit);
  },

  /** The actor of the most recent entry for each entity, keyed by entity id. */
  async latestActors(ex: Executor, entityIds: string[]): Promise<Map<string, string>> {
    if (entityIds.length === 0) return new Map();
    const rows = await ex
      .selectDistinctOn([auditLog.entityId], { entityId: auditLog.entityId, actor: auditLog.actor })
      .from(auditLog)
      .where(inArray(auditLog.entityId, entityIds))
      .orderBy(auditLog.entityId, desc(auditLog.createdAt));
    const actors = new Map<string, string>();
    for (const row of rows) if (row.entityId) actors.set(row.entityId, row.actor);
    return actors;
  },

  /**
   * Deletes entries older than the retention window. The append-only trigger permits
   * exactly this and nothing newer, so the two rules cannot drift apart silently: a
   * shorter window here would fail loudly at the trigger.
   */
  async purgeOlderThan(ex: Executor, days: number): Promise<number> {
    const deleted = await ex
      .delete(auditLog)
      .where(lt(auditLog.createdAt, sql`now() - make_interval(days => ${days})`))
      .returning({ id: auditLog.id });
    return deleted.length;
  },
};

export type AuditRepository = typeof auditRepository;
