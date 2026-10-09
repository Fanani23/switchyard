import type { RulesetResponse } from '@switchyard/shared';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { toRulesetFlag } from '../flags/flag.mapper.js';
import type { FlagsRepository } from '../flags/flags.repository.js';
import type { ChangeHub } from '../stream/change-hub.js';

/** A ruleset with its JSON already built, so a hot read is a map lookup and a write. */
export interface CompiledRuleset {
  environmentId: string;
  version: number;
  json: string;
}

export interface RulesetServiceDeps {
  db: Db;
  flags: FlagsRepository;
  environments: EnvironmentsRepository;
  /** Change notifications that invalidate the cache. Without it, nothing is cached. */
  hub?: ChangeHub;
  /**
   * Upper bound on how long an entry is served without re-reading. Invalidation is by
   * notification; this only bounds staleness if a notification is lost while the LISTEN
   * connection is down and before it reconnects.
   */
  maxAgeMs?: number;
  now?: () => number;
}

interface Entry {
  compiled: CompiledRuleset;
  loadedAt: number;
  /** Superseded by a change announced over NOTIFY; served only while a refresh runs. */
  stale: boolean;
}

export class RulesetService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CompiledRuleset>>();
  /** Bumped per environment on each change, and globally on reconnect; see `load`. */
  private readonly generation = new Map<string, number>();
  private epoch = 0;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: RulesetServiceDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? 30_000;
    this.now = deps.now ?? Date.now;
    deps.hub?.subscribe({
      onChange: (environmentId) => this.invalidate(environmentId, 'soft'),
      // Notifications sent while the connection was down are lost: trust nothing cached.
      onListen: () => {
        this.epoch++;
        this.cache.clear();
        this.inflight.clear();
      },
    });
  }

  /**
   * The whole evaluable ruleset for the key's environment. Any key scope may read it (D2);
   * the root key has no environment and so has no ruleset.
   */
  async get(principal: Principal): Promise<CompiledRuleset> {
    if (principal.kind !== 'key') throw new ForbiddenError();
    return this.load(principal.environmentId);
  }

  /**
   * Served from memory while the change feed is listening. Every SDK in an environment reads
   * the same bytes until something changes, so building them once per change, instead of
   * once per request, is what lets one instance serve 500 requests a second (SPEC.md F1).
   *
   * After a change announced by NOTIFY, readers keep getting the previous bytes for the
   * few tens of milliseconds the rebuild takes (stale-while-revalidate) instead of queueing
   * behind it; a reader on another instance is that far behind anyway. `fresh` waits for
   * the rebuild instead: the stream uses it, so a push always carries the new version.
   */
  async load(environmentId: string, opts: { fresh?: boolean } = {}): Promise<CompiledRuleset> {
    if (!(await this.cacheUsable())) return compile(await this.read(environmentId));

    const hit = this.cache.get(environmentId);
    if (hit && !hit.stale && this.now() - hit.loadedAt < this.maxAgeMs) return hit.compiled;
    const refresh = this.refresh(environmentId);
    if (hit && !opts.fresh) {
      // The caller is served now; a failed refresh is retried by the next reader.
      refresh.catch(() => {});
      return hit.compiled;
    }
    return refresh;
  }

  /**
   * One rebuild per environment at a time. A read that started before a change must not be
   * cached after it: the result is stored only if no invalidation for that environment (or
   * reconnect) happened while it ran.
   */
  private refresh(environmentId: string): Promise<CompiledRuleset> {
    const pending = this.inflight.get(environmentId);
    if (pending) return pending;

    const startedAt = this.stamp(environmentId);
    const run = this.read(environmentId)
      .then((ruleset) => {
        const compiled = compile(ruleset);
        if (this.stamp(environmentId) === startedAt) {
          this.cache.set(environmentId, { compiled, loadedAt: this.now(), stale: false });
        }
        return compiled;
      })
      .finally(() => {
        if (this.inflight.get(environmentId) === run) this.inflight.delete(environmentId);
      });
    this.inflight.set(environmentId, run);
    return run;
  }

  /**
   * Version and flags are read in one REPEATABLE READ snapshot. Read separately, a write
   * landing between them would pair version N with the flags of N+1; an SDK holding N+1
   * would then ignore the real N+1 push as "already seen" and keep stale rules.
   */
  async read(environmentId: string): Promise<RulesetResponse> {
    const { db, flags, environments } = this.deps;
    return db.transaction(
      async (tx) => {
        const env = await environments.findById(tx, environmentId);
        if (!env) throw new NotFoundError();
        const all = await flags.listAll(tx, env.id);
        return {
          environmentId: env.id,
          version: env.rulesetVersion,
          flags: all.map(toRulesetFlag),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * Marks an environment's cached ruleset as superseded. `hard` (after a write on this
   * instance) drops it, so the writer reads its own write; `soft` (a NOTIFY) keeps serving
   * it until the rebuild lands.
   */
  invalidate(environmentId: string, mode: 'hard' | 'soft' = 'hard'): void {
    this.generation.set(environmentId, (this.generation.get(environmentId) ?? 0) + 1);
    // A caller arriving after the change must not join a read that began before it.
    this.inflight.delete(environmentId);
    const entry = this.cache.get(environmentId);
    if (!entry) return;
    if (mode === 'hard') this.cache.delete(environmentId);
    else entry.stale = true;
  }

  private stamp(environmentId: string): string {
    return `${this.epoch}:${this.generation.get(environmentId) ?? 0}`;
  }

  /** Caching is only safe while notifications can reach us. */
  private async cacheUsable(): Promise<boolean> {
    const { hub } = this.deps;
    if (!hub || hub.coolingDown) return false;
    try {
      await hub.start();
      return true;
    } catch {
      return false;
    }
  }
}

function compile(ruleset: RulesetResponse): CompiledRuleset {
  return {
    environmentId: ruleset.environmentId,
    version: ruleset.version,
    json: JSON.stringify(ruleset),
  };
}
