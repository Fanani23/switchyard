import postgres from 'postgres';

/** The channel `bump_ruleset_version()` notifies on (migration 0004). */
export const RULESET_CHANNEL = 'ruleset_changed';

export interface ChangeFeedHandlers {
  /** An environment's ruleset changed; the payload is its id. */
  onChange: (environmentId: string) => void;
  /**
   * The feed (re)established its LISTEN. Notifications sent while it was down are lost,
   * so whoever holds state derived from them must re-read it.
   */
  onListen: () => void;
}

export interface ChangeFeed {
  start(handlers: ChangeFeedHandlers): Promise<void>;
  close(): Promise<void>;
}

/**
 * Ruleset changes from PostgreSQL LISTEN/NOTIFY. Every API instance holds one dedicated
 * connection; the database delivers each committed change to all of them, which is what
 * makes a change on one instance reach clients on another (SPEC.md B3) with no extra
 * infrastructure. postgres.js re-issues LISTEN after a dropped connection and calls
 * `onlisten` again, which is the hook for resynchronizing.
 */
export function postgresChangeFeed(databaseUrl: string): ChangeFeed {
  let sql: postgres.Sql | null = null;
  return {
    async start(handlers) {
      if (sql) return;
      sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
      await sql.listen(RULESET_CHANNEL, handlers.onChange, handlers.onListen);
    },
    async close() {
      const current = sql;
      sql = null;
      await current?.end({ timeout: 5 });
    },
  };
}
