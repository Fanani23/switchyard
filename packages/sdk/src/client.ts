import { evaluate } from '@switchyard/engine';
import {
  rulesetResponseSchema,
  type EvaluationContext,
  type RulesetFlag,
  type RulesetResponse,
} from '@switchyard/shared';
import { SseParser } from './sse.js';

export type Fallback = string | boolean;

export interface BackoffOptions {
  /** First retry delay. UX.md: 1 s. */
  initialMs: number;
  /** Ceiling before jitter. UX.md: 30 s. */
  maxMs: number;
  /** Fractional jitter either side of the delay. UX.md: ±20%. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { initialMs: 1000, maxMs: 30_000, jitter: 0.2 };

/**
 * Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s, 8 s … capped at 30 s,
 * each ±20%. The jitter keeps a fleet of SDKs from reconnecting in lockstep after an API
 * restart, which would otherwise arrive as a synchronized wave every cycle.
 */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const base = Math.min(options.initialMs * 2 ** Math.min(attempt, 30), options.maxMs);
  return Math.round(base * (1 + options.jitter * (2 * random() - 1)));
}

export interface SwitchyardOptions {
  /** A client (or admin) key; it decides which environment's ruleset is served. */
  apiKey: string;
  baseUrl?: string;
  /** Served for a flag the SDK has no ruleset for: before the first fetch, or offline. */
  fallbacks?: Record<string, Fallback>;
  /** How long `ready()` waits for the first ruleset before resolving anyway. */
  readyTimeoutMs?: number;
  /**
   * A stream silent for this long is presumed dead (a half-open TCP connection never
   * errors) and replaced. The API pings every 30 s, so the default allows two misses.
   */
  idleTimeoutMs?: number;
  /**
   * A connection must stay up this long before the backoff resets to its first step. A
   * server that accepts and immediately drops connections therefore still backs off,
   * instead of being retried every second forever.
   */
  stableAfterMs?: number;
  backoff?: Partial<BackoffOptions>;
  /** Called with errors the SDK absorbed. Never required; never allowed to throw through. */
  onError?: (error: unknown) => void;
  /** Called after each new ruleset is applied. */
  onUpdate?: (version: number) => void;
  fetch?: typeof fetch;
  random?: () => number;
}

type Outcome = 'retry' | 'stable' | 'fatal';

/**
 * Holds one environment's ruleset in memory and evaluates in process. A flag check is a
 * map lookup and a hash: no network, and no failure mode (SPEC.md C1–C3). The ruleset
 * arrives over one long-lived SSE connection, whose first event is always the current
 * ruleset, so a reconnect is also a full resync (B2).
 */
export class Switchyard {
  private flags: Map<string, RulesetFlag> | null = null;
  private version = -1;
  private environmentId: string | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  private readonly readyPromise: Promise<void>;
  private resolveReady: () => void = () => {};
  private readonly options: Required<
    Pick<SwitchyardOptions, 'baseUrl' | 'readyTimeoutMs' | 'idleTimeoutMs' | 'stableAfterMs'>
  > & { backoff: BackoffOptions };

  constructor(private readonly config: SwitchyardOptions) {
    this.options = {
      baseUrl: (config.baseUrl ?? 'http://localhost:4000').replace(/\/+$/, ''),
      readyTimeoutMs: config.readyTimeoutMs ?? 5000,
      idleTimeoutMs: config.idleTimeoutMs ?? 75_000,
      stableAfterMs: config.stableAfterMs ?? 30_000,
      backoff: { ...DEFAULT_BACKOFF, ...config.backoff },
    };
    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
      const timer = setTimeout(resolve, this.options.readyTimeoutMs);
      unref(timer);
    });
    void this.run();
  }

  /** Resolves on the first ruleset, or when `readyTimeoutMs` passes. Never rejects. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** The ruleset version held, or null before the first one arrives. */
  get rulesetVersion(): number | null {
    return this.flags ? this.version : null;
  }

  /** The variant for this user. Never throws, whatever the SDK's state or the input. */
  variant(flagKey: string, context: EvaluationContext = {}): string {
    try {
      const fallback = this.fallbackVariant(flagKey);
      const flag = this.flags?.get(flagKey);
      if (!flag) return fallback;
      return evaluate(flag, context, fallback).variant;
    } catch (err) {
      this.report(err);
      return safeFallback(this.config.fallbacks, flagKey);
    }
  }

  /** Whether a boolean flag is on for this user. Never throws. */
  enabled(flagKey: string, context: EvaluationContext = {}): boolean {
    try {
      return this.variant(flagKey, context) === 'on';
    } catch {
      return false;
    }
  }

  /** Stops the stream and any pending retry. Evaluation keeps working on the last ruleset. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.wake?.();
    this.resolveReady();
  }

  private fallbackVariant(flagKey: string): string {
    const fallback = this.config.fallbacks?.[flagKey];
    if (typeof fallback === 'boolean') return fallback ? 'on' : 'off';
    return typeof fallback === 'string' ? fallback : '';
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      let outcome: Outcome;
      try {
        outcome = await this.connectOnce();
      } catch (err) {
        if (!this.closed) this.report(err);
        outcome = 'retry';
      }
      if (this.closed) return;
      if (outcome === 'fatal') {
        // A revoked or wrong key will not start working by retrying it; keep serving the
        // cached ruleset (or fallbacks) and stop knocking.
        this.resolveReady();
        return;
      }
      if (outcome === 'stable') attempt = 0;
      await this.sleep(backoffDelay(attempt, this.options.backoff, this.config.random));
      attempt++;
    }
  }

  private async connectOnce(): Promise<Outcome> {
    const doFetch = this.config.fetch ?? globalThis.fetch;
    const connection = new AbortController();
    const onClose = () => connection.abort();
    this.abort.signal.addEventListener('abort', onClose);
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), this.options.idleTimeoutMs);
      unref(idle);
    };
    const openedAt = Date.now();

    try {
      touch();
      const res = await doFetch(`${this.options.baseUrl}/v1/stream`, {
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: 'text/event-stream' },
        signal: connection.signal,
      });
      if (res.status === 401 || res.status === 403) {
        this.report(new Error(`Switchyard rejected the API key (HTTP ${res.status})`));
        return 'fatal';
      }
      if (!res.ok || !res.body) {
        this.report(new Error(`Switchyard stream unavailable (HTTP ${res.status})`));
        return 'retry';
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        touch();
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.event === 'ruleset') this.apply(event.data);
        }
      }
    } catch (err) {
      if (!this.closed && !connection.signal.aborted) this.report(err);
    } finally {
      if (idle) clearTimeout(idle);
      this.abort.signal.removeEventListener('abort', onClose);
    }
    return Date.now() - openedAt >= this.options.stableAfterMs ? 'stable' : 'retry';
  }

  /**
   * Applies a pushed ruleset. Anything that does not parse is ignored and the current
   * ruleset kept: a bad push must never replace good rules. A version at or below the one
   * held is ignored too, which makes redelivery harmless (SPEC.md).
   */
  private apply(data: string): void {
    let parsed: RulesetResponse;
    try {
      parsed = rulesetResponseSchema.parse(JSON.parse(data));
    } catch (err) {
      this.report(err);
      return;
    }
    const sameEnvironment = this.environmentId === parsed.environmentId;
    if (sameEnvironment && parsed.version <= this.version) return;
    this.flags = new Map(parsed.flags.map((f) => [f.key, f]));
    this.version = parsed.version;
    this.environmentId = parsed.environmentId;
    this.resolveReady();
    try {
      this.config.onUpdate?.(parsed.version);
    } catch (err) {
      this.report(err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
      unref(this.sleepTimer);
    });
  }

  private report(err: unknown): void {
    try {
      this.config.onError?.(err);
    } catch {
      // A throwing error handler must not take the SDK down with it.
    }
  }
}

function safeFallback(fallbacks: Record<string, Fallback> | undefined, flagKey: string): string {
  try {
    const fallback = fallbacks?.[flagKey];
    if (typeof fallback === 'boolean') return fallback ? 'on' : 'off';
    return typeof fallback === 'string' ? fallback : '';
  } catch {
    return '';
  }
}

/** Background timers must not keep a Node process alive on their own. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
}
