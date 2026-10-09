import type { ChangeFeed, ChangeFeedHandlers } from './change-feed.js';

/**
 * One change feed (one LISTEN connection per instance), many subscribers. Handlers run
 * synchronously in subscription order, so a subscriber registered first (the ruleset cache)
 * has invalidated its entry before a later one (the stream fan-out) reads it again.
 */
export class ChangeHub {
  private readonly subscribers: ChangeFeedHandlers[] = [];
  private started: Promise<void> | null = null;
  private failedAt = 0;

  constructor(
    private readonly feed: ChangeFeed,
    /** After a failed start, wait this long before trying again. */
    private readonly retryAfterMs = 5000,
  ) {}

  subscribe(handlers: ChangeFeedHandlers): void {
    this.subscribers.push(handlers);
  }

  /** Starts listening once; concurrent callers share the attempt. Rejects if it fails. */
  start(): Promise<void> {
    if (!this.started) {
      this.started = this.feed
        .start({
          onChange: (environmentId) => {
            for (const s of this.subscribers) s.onChange(environmentId);
          },
          onListen: () => {
            for (const s of this.subscribers) s.onListen();
          },
        })
        .catch((err: unknown) => {
          this.started = null;
          this.failedAt = Date.now();
          throw err;
        });
    }
    return this.started;
  }

  /** True when a start attempt failed recently enough that callers should not retry yet. */
  get coolingDown(): boolean {
    return this.started === null && Date.now() - this.failedAt < this.retryAfterMs;
  }

  async close(): Promise<void> {
    this.started = null;
    await this.feed.close();
  }
}
