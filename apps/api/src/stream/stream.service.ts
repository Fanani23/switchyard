import { LIMITS, type RulesetResponse } from '@switchyard/shared';
import type { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/principal.js';
import { ForbiddenError, LimitExceededError, NotFoundError, UnauthorizedError } from '../errors.js';
import type { RulesetService } from '../ruleset/ruleset.service.js';
import type { ChangeFeed } from './change-feed.js';

/**
 * Where a stream's events go. The route implements it over an HTTP response; the service
 * never sees HTTP, which keeps connection policy testable and in one place.
 */
export interface StreamSink {
  send(event: 'ruleset' | 'ping', data: unknown, id?: string): void;
  /** Bytes written but not yet flushed to the client. */
  buffered(): number;
  end(): void;
  onClose(callback: () => void): void;
}

export interface StreamServiceOptions {
  auth: AuthService;
  ruleset: RulesetService;
  feed: ChangeFeed;
  heartbeatMs?: number;
  maxConnectionsPerKey?: number;
  /** A client this far behind is dropped rather than buffered without bound. */
  maxBufferedBytes?: number;
  onError?: (err: unknown, context: string) => void;
}

interface Connection {
  keyId: string;
  environmentId: string;
  authorization: string | undefined;
  sink: StreamSink;
  version: number;
  heartbeat: NodeJS.Timeout;
}

/** A reserved slot: the ruleset to send first, and how to attach the client to it. */
export interface StreamSession {
  initial: RulesetResponse;
  attach(sink: StreamSink): void;
  /** Gives the slot back if the caller fails before attaching. */
  release(): void;
}

export class StreamService {
  private readonly byEnvironment = new Map<string, Set<Connection>>();
  private readonly perKey = new Map<string, number>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  /** Notifications seen per environment, to detect one landing while a stream attaches. */
  private readonly notified = new Map<string, number>();
  private feedStarted: Promise<void> | null = null;
  private readonly heartbeatMs: number;
  private readonly maxPerKey: number;
  private readonly maxBuffered: number;

  constructor(private readonly opts: StreamServiceOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? LIMITS.sseHeartbeatSeconds * 1000;
    this.maxPerKey = opts.maxConnectionsPerKey ?? LIMITS.sseConnectionsPerKey;
    this.maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024;
  }

  /** Open connections, for tests and for the load stage's leak checks (F3). */
  get connectionCount(): number {
    let n = 0;
    for (const set of this.byEnvironment.values()) n += set.size;
    return n;
  }

  /**
   * Admits a stream: a key (not root) with a free slot under the per-key limit. The slot is
   * reserved before any await, so concurrent opens cannot overshoot the limit.
   */
  async open(principal: Principal, authorization: string | undefined): Promise<StreamSession> {
    if (principal.kind !== 'key') throw new ForbiddenError();
    const { keyId, environmentId } = principal;

    const current = this.perKey.get(keyId) ?? 0;
    if (current >= this.maxPerKey) {
      throw new LimitExceededError(
        'Stream connections per key exceeded',
        this.maxPerKey,
        current + 1,
      );
    }
    this.perKey.set(keyId, current + 1);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.perKey.get(keyId) ?? 1) - 1;
      if (n <= 0) this.perKey.delete(keyId);
      else this.perKey.set(keyId, n);
    };

    try {
      await this.ensureFeed();
      const seenAtOpen = this.notified.get(environmentId) ?? 0;
      // Read after the feed is listening: a change committed in between is then either in
      // this snapshot or announced by a notification, never lost between the two.
      const initial = await this.opts.ruleset.load(environmentId);
      return {
        initial,
        release,
        attach: (sink) => {
          this.attach(keyId, environmentId, authorization, initial, sink, release);
          // A change announced between the read above and now found no listener for this
          // environment; read again so the new stream does not start one change behind.
          if ((this.notified.get(environmentId) ?? 0) !== seenAtOpen) this.changed(environmentId);
        },
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Ends every stream. Called before the server stops, so shutdown does not hang on them. */
  async closeAll(): Promise<void> {
    for (const set of this.byEnvironment.values()) {
      for (const conn of set) conn.sink.end();
    }
    await this.opts.feed.close();
    this.feedStarted = null;
  }

  private attach(
    keyId: string,
    environmentId: string,
    authorization: string | undefined,
    initial: RulesetResponse,
    sink: StreamSink,
    release: () => void,
  ): void {
    const conn: Connection = {
      keyId,
      environmentId,
      authorization,
      sink,
      version: initial.version,
      heartbeat: setInterval(() => void this.beat(conn), this.heartbeatMs),
    };
    conn.heartbeat.unref();

    let set = this.byEnvironment.get(environmentId);
    if (!set) this.byEnvironment.set(environmentId, (set = new Set()));
    set.add(conn);

    sink.onClose(() => {
      clearInterval(conn.heartbeat);
      const members = this.byEnvironment.get(environmentId);
      members?.delete(conn);
      if (members?.size === 0) this.byEnvironment.delete(environmentId);
      release();
    });

    sink.send('ruleset', initial, String(initial.version));
  }

  /**
   * Every heartbeat re-checks the key. With the auth cache's 30 s TTL and a 30 s heartbeat,
   * a stream opened with a key that is later revoked is closed within 60 s (D4), on every
   * instance, not only the one that performed the revocation.
   */
  private async beat(conn: Connection): Promise<void> {
    try {
      await this.opts.auth.authenticate(conn.authorization);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        conn.sink.end();
        return;
      }
      // The database being briefly unreachable is not a reason to drop healthy clients.
      this.opts.onError?.(err, 'stream re-authentication');
    }
    this.deliver(conn, 'ping', {});
  }

  private deliver(conn: Connection, event: 'ruleset' | 'ping', data: unknown, id?: string): void {
    if (conn.sink.buffered() > this.maxBuffered) {
      conn.sink.end();
      return;
    }
    conn.sink.send(event, data, id);
  }

  private ensureFeed(): Promise<void> {
    if (!this.feedStarted) {
      this.feedStarted = this.opts.feed
        .start({
          onChange: (environmentId) => {
            this.notified.set(environmentId, (this.notified.get(environmentId) ?? 0) + 1);
            this.changed(environmentId);
          },
          onListen: () => {
            for (const environmentId of this.byEnvironment.keys()) this.changed(environmentId);
          },
        })
        .catch((err: unknown) => {
          this.feedStarted = null;
          throw err;
        });
    }
    return this.feedStarted;
  }

  /**
   * Coalesces bursts: while one read of an environment's ruleset is in flight, further
   * notifications for it only mark it dirty, and one more read follows. A PUT that replaces
   * twenty rules triggers one read, not twenty.
   */
  private changed(environmentId: string): void {
    if (!this.byEnvironment.has(environmentId)) return;
    if (this.refreshing.has(environmentId)) {
      this.dirty.add(environmentId);
      return;
    }
    const run = this.push(environmentId).finally(() => {
      this.refreshing.delete(environmentId);
      if (this.dirty.delete(environmentId)) this.changed(environmentId);
    });
    this.refreshing.set(environmentId, run);
  }

  private async push(environmentId: string): Promise<void> {
    let ruleset: RulesetResponse;
    try {
      ruleset = await this.opts.ruleset.load(environmentId);
    } catch (err) {
      if (err instanceof NotFoundError) {
        // The environment was deleted: its streams have nothing left to serve.
        for (const conn of this.byEnvironment.get(environmentId) ?? []) conn.sink.end();
        return;
      }
      this.opts.onError?.(err, 'stream ruleset refresh');
      return;
    }
    for (const conn of this.byEnvironment.get(environmentId) ?? []) {
      if (ruleset.version <= conn.version) continue;
      conn.version = ruleset.version;
      this.deliver(conn, 'ruleset', ruleset, String(ruleset.version));
    }
  }
}
