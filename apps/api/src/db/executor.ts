import type { Db } from './client.js';

/** A transaction handle, as passed to the callback of `db.transaction`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything a repository can run a query on: the pool, or an open transaction. */
export type Executor = Db | Tx;

/**
 * If `err` is a PostgreSQL unique violation, the name of the violated constraint; else null.
 * Drizzle wraps driver errors, so the cause chain is walked rather than the top error read.
 */
export function uniqueViolation(err: unknown): string | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if (typeof e !== 'object') break;
    const record = e as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (record.code === '23505') {
      return typeof record.constraint_name === 'string' ? record.constraint_name : '';
    }
    e = record.cause;
  }
  return null;
}
