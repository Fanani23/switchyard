import { describe, expect, it, vi } from 'vitest';
import type { RulesetResponse } from '@switchyard/shared';
import type { Db } from '../src/db/client.js';
import type { EnvironmentsRepository } from '../src/environments/environments.repository.js';
import type { FlagsRepository } from '../src/flags/flags.repository.js';
import { RulesetService } from '../src/ruleset/ruleset.service.js';
import type { ChangeFeed, ChangeFeedHandlers } from '../src/stream/change-feed.js';
import { ChangeHub } from '../src/stream/change-hub.js';

const ENV = '11111111-1111-4111-8111-111111111111';

/**
 * The ruleset cache's consistency rules, with the database replaced by a counter whose reads
 * the test resolves by hand, so every interleaving below is deterministic.
 */
function setup(opts: { feedFails?: boolean; maxAgeMs?: number } = {}) {
  let handlers: ChangeFeedHandlers | null = null;
  const feed: ChangeFeed = {
    async start(h) {
      if (opts.feedFails) throw new Error('LISTEN failed');
      handlers = h;
    },
    async close() {},
  };
  let clock = 0;
  const service = new RulesetService({
    db: {} as unknown as Db,
    flags: {} as unknown as FlagsRepository,
    environments: {} as unknown as EnvironmentsRepository,
    hub: new ChangeHub(feed),
    maxAgeMs: opts.maxAgeMs ?? 30_000,
    now: () => clock,
  });

  // The "database": its version advances on `commit()`; reads resolve when released.
  let version = 1;
  const pending: Array<() => void> = [];
  const read = vi.spyOn(service, 'read').mockImplementation(() => {
    const snapshot = version;
    return new Promise<RulesetResponse>((resolve) => {
      pending.push(() => resolve({ environmentId: ENV, version: snapshot, flags: [] }));
    });
  });
  const release = async () => {
    while (pending.length) pending.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  };
  const load = async (o?: { fresh?: boolean }) => {
    const p = service.load(ENV, o);
    await new Promise((r) => setTimeout(r, 0));
    await release();
    return (await p).version;
  };
  return {
    service,
    read,
    load,
    release,
    commit: () => version++,
    notify: () => handlers!.onChange(ENV),
    reconnect: () => handlers!.onListen(),
    tick: (ms: number) => (clock += ms),
  };
}

describe('ruleset cache', () => {
  it('reads the database once per change, not once per request', async () => {
    const t = setup();
    expect(await t.load()).toBe(1);
    for (let i = 0; i < 100; i++) expect(await t.load()).toBe(1);
    expect(t.read).toHaveBeenCalledTimes(1);
  });

  it('concurrent misses share one read', async () => {
    const t = setup();
    const all = Array.from({ length: 50 }, () => t.service.load(ENV));
    await new Promise((r) => setTimeout(r, 0));
    await t.release();
    expect((await Promise.all(all)).every((c) => c.version === 1)).toBe(true);
    expect(t.read).toHaveBeenCalledTimes(1);
  });

  it('a read that began before a change is never cached after it', async () => {
    const t = setup();
    const slow = t.service.load(ENV); // snapshot taken at version 1...
    await new Promise((r) => setTimeout(r, 0));
    t.commit();
    t.notify(); // ...and the change lands while it is still in flight
    await t.release();
    expect((await slow).version).toBe(1);
    // The old snapshot was not stored: the next reader gets version 2.
    expect(await t.load()).toBe(2);
  });

  it('after a NOTIFY, readers get the previous bytes while the rebuild runs; fresh waits for it', async () => {
    const t = setup();
    expect(await t.load()).toBe(1);
    t.commit();
    t.notify();
    const stale = await t.service.load(ENV); // served at once, without waiting
    expect(stale.version).toBe(1);
    expect(await t.load({ fresh: true })).toBe(2);
    expect(await t.load()).toBe(2);
  });

  it('after a local write (hard invalidation) the next read waits for the new version', async () => {
    const t = setup();
    expect(await t.load()).toBe(1);
    t.commit();
    t.service.invalidate(ENV, 'hard');
    expect(await t.load()).toBe(2);
  });

  it('a LISTEN reconnect drops everything, since notifications may have been missed', async () => {
    const t = setup();
    expect(await t.load()).toBe(1);
    t.commit(); // a change whose NOTIFY was lost while disconnected
    t.reconnect();
    expect(await t.load()).toBe(2);
  });

  it('entries are re-read after maxAge even with no notification', async () => {
    const t = setup({ maxAgeMs: 1000 });
    expect(await t.load()).toBe(1);
    t.commit(); // lost notification
    t.tick(999);
    expect(await t.load()).toBe(1);
    t.tick(2);
    await t.load(); // triggers the refresh (and is served the stale entry meanwhile)
    expect(await t.load()).toBe(2);
  });

  it('without a working change feed nothing is cached: every read goes to the database', async () => {
    const t = setup({ feedFails: true });
    expect(await t.load()).toBe(1);
    t.commit();
    expect(await t.load()).toBe(2);
    expect(t.read).toHaveBeenCalledTimes(2);
  });
});
