import { afterEach, describe, expect, it, vi } from 'vitest';
import { Switchyard, backoffDelay, DEFAULT_BACKOFF, SseParser } from '../src/index.js';
import { ENV_ID, fakeServer, ruleset } from './fake-server.js';

const clients: Switchyard[] = [];
function client(options: ConstructorParameters<typeof Switchyard>[0]): Switchyard {
  const c = new Switchyard(options);
  clients.push(c);
  return c;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
});

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('C1 — with the API unreachable at startup, the SDK returns caller-supplied defaults', () => {
  it('sdk.cold-start-offline', async () => {
    const server = fakeServer();
    server.setMode('down');
    const sdk = client({
      apiKey: 'sy_client_x',
      fetch: server.fetch,
      readyTimeoutMs: 50,
      fallbacks: { 'new-checkout': 'control', 'dark-mode': true, 'kill-switch': false },
    });

    const started = Date.now();
    await sdk.ready(); // resolves on the timeout; never rejects
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(sdk.rulesetVersion).toBeNull();

    expect(sdk.variant('new-checkout', { key: 'u1', plan: 'pro' })).toBe('control');
    expect(sdk.enabled('dark-mode', { key: 'u1' })).toBe(true);
    expect(sdk.enabled('kill-switch', { key: 'u1' })).toBe(false);
    // No fallback supplied: the empty variant, and "off" for a boolean check.
    expect(sdk.variant('unknown')).toBe('');
    expect(sdk.enabled('unknown')).toBe(false);
  });

  it('picks the ruleset up as soon as the API appears, without a restart', async () => {
    const server = fakeServer((conn) => conn.sendRuleset(ruleset(3)));
    server.setMode('down');
    const sdk = client({
      apiKey: 'k',
      fetch: server.fetch,
      readyTimeoutMs: 20,
      backoff: { initialMs: 10 },
      fallbacks: { 'new-checkout': 'control' },
    });
    await sdk.ready();
    expect(sdk.variant('new-checkout', { key: 'u', plan: 'pro' })).toBe('control');

    server.setMode('up');
    await until(() => sdk.rulesetVersion === 3);
    expect(sdk.variant('new-checkout', { key: 'u', plan: 'pro' })).toBe('treatment');
  });
});

describe('C2 — with the API unreachable after a successful fetch, the SDK serves the cached ruleset', () => {
  it('sdk.warm-offline', async () => {
    const server = fakeServer((conn) => conn.sendRuleset(ruleset(7)));
    const sdk = client({
      apiKey: 'k',
      fetch: server.fetch,
      backoff: { initialMs: 5, maxMs: 20 },
      // Fallbacks deliberately disagree with the ruleset, so serving them would show.
      fallbacks: { 'new-checkout': 'control', 'dark-mode': false },
    });
    await sdk.ready();
    expect(sdk.rulesetVersion).toBe(7);

    // The API goes away: the open stream ends and every reconnect is refused.
    server.setMode('down');
    server.connections[0]!.close();
    await until(() => server.attempts.length >= 4);

    expect(sdk.rulesetVersion).toBe(7);
    expect(sdk.variant('new-checkout', { key: 'u', plan: 'pro' })).toBe('treatment');
    expect(sdk.enabled('dark-mode', { key: 'u' })).toBe(true);
  });

  it('keeps the cached ruleset after close(), too', async () => {
    const server = fakeServer((conn) => conn.sendRuleset(ruleset(2)));
    const sdk = client({ apiKey: 'k', fetch: server.fetch });
    await sdk.ready();
    sdk.close();
    expect(sdk.enabled('dark-mode', { key: 'u' })).toBe(true);
  });
});

describe('C3 — evaluation never throws, whatever the state', () => {
  it('sdk.evaluation-never-throws', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('getter exploded');
        },
        has() {
          throw new Error('has exploded');
        },
        ownKeys() {
          throw new Error('ownKeys exploded');
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor exploded');
        },
      },
    );
    const contexts: unknown[] = [
      undefined,
      null,
      42,
      'user',
      [],
      { key: 7 },
      { key: 'u', plan: { nested: true } },
      hostile,
    ];
    const flagKeys: unknown[] = [
      'new-checkout',
      'dark-mode',
      'missing',
      '',
      undefined,
      null,
      5,
      {},
    ];
    const throwingFallbacks = new Proxy({} as Record<string, string>, {
      get() {
        throw new Error('fallbacks exploded');
      },
    });

    const server = fakeServer();
    const sdk = client({
      apiKey: 'k',
      fetch: server.fetch,
      readyTimeoutMs: 20,
      fallbacks: throwingFallbacks,
      onError: () => {
        throw new Error('error handler exploded');
      },
    });

    const exercise = () => {
      for (const key of flagKeys) {
        for (const ctx of contexts) {
          expect(() => sdk.variant(key as string, ctx as never)).not.toThrow();
          expect(() => sdk.enabled(key as string, ctx as never)).not.toThrow();
          expect(typeof sdk.variant(key as string, ctx as never)).toBe('string');
          expect(typeof sdk.enabled(key as string, ctx as never)).toBe('boolean');
        }
      }
    };

    exercise(); // before any ruleset
    await until(() => server.connections.length === 1);
    const conn = server.connections[0]!;

    // Garbage on the wire is ignored; it must not replace good rules or break evaluation.
    conn.push('event: ruleset\ndata: {not json\n\n');
    conn.push('event: ruleset\ndata: {"version":"seven"}\n\n');
    conn.push('event: ruleset\ndata: null\n\n');
    conn.push('event: mystery\ndata: whatever\n\n');
    conn.push('no colon line\n\n');
    exercise();

    conn.sendRuleset(ruleset(1));
    await until(() => sdk.rulesetVersion === 1);
    exercise(); // with a ruleset

    conn.push(
      `event: ruleset\ndata: ${JSON.stringify({ ...ruleset(2), flags: [{ key: 'x' }] })}\n\n`,
    );
    exercise();
    expect(sdk.rulesetVersion).toBe(1); // the malformed v2 was rejected

    sdk.close();
    exercise(); // after close
  });
});

describe('ruleset versions', () => {
  it('ignores a push at or below the version held; redelivery is harmless', async () => {
    const server = fakeServer();
    const updates: number[] = [];
    const sdk = client({ apiKey: 'k', fetch: server.fetch, onUpdate: (v) => updates.push(v) });
    await until(() => server.connections.length === 1);
    const conn = server.connections[0]!;

    conn.sendRuleset(ruleset(5));
    conn.sendRuleset(ruleset(5)); // redelivered
    conn.sendRuleset(ruleset(4, { flags: [] })); // stale
    conn.sendRuleset(ruleset(6));
    await until(() => sdk.rulesetVersion === 6);
    expect(updates).toEqual([5, 6]);
    expect(sdk.variant('dark-mode', { key: 'u' })).toBe('on');
  });

  it('accepts a lower version from a different environment (the key was re-pointed)', async () => {
    const server = fakeServer();
    const sdk = client({ apiKey: 'k', fetch: server.fetch });
    await until(() => server.connections.length === 1);
    server.connections[0]!.sendRuleset(ruleset(9));
    await until(() => sdk.rulesetVersion === 9);
    server.connections[0]!.sendRuleset(
      ruleset(2, { environmentId: '00000000-0000-4000-8000-000000000000', flags: [] }),
    );
    await until(() => sdk.rulesetVersion === 2);
    expect(ENV_ID).not.toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('B4 — a dropped connection retries with backoff and does not spin', () => {
  it('backoffDelay follows 1 s, 2 s, 4 s … capped at 30 s, within ±20%', () => {
    const mid = Array.from({ length: 8 }, (_, i) => backoffDelay(i, DEFAULT_BACKOFF, () => 0.5));
    expect(mid).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    for (let i = 0; i < 12; i++) {
      const base = Math.min(1000 * 2 ** i, 30_000);
      expect(backoffDelay(i, DEFAULT_BACKOFF, () => 0)).toBe(Math.round(base * 0.8));
      expect(backoffDelay(i, DEFAULT_BACKOFF, () => 1)).toBe(Math.round(base * 1.2));
    }
    expect(backoffDelay(10_000)).toBeLessThanOrEqual(36_000); // no overflow on huge attempts
  });

  it('stream.reconnect-backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer();
    server.setMode('down');
    client({ apiKey: 'k', fetch: server.fetch, random: () => 0.5 });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const gaps = server.attempts.slice(1).map((t, i) => t - server.attempts[i]!);
    // At t = 0, 1, 3, 7, 15 s, then every 30 s (31 … 271 s): 14 attempts in five minutes.
    expect(server.attempts.length).toBe(14);
    expect(gaps.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);
  });

  it('keeps backing off when the server accepts and then drops every connection at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer((conn) => conn.close());
    client({ apiKey: 'k', fetch: server.fetch, random: () => 0.5 });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // A flapping server must not reset the backoff: the same 14 attempts, not 300.
    expect(server.attempts.length).toBe(14);
  });

  it('resets to the first step after a connection that was stable', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer((conn) => conn.sendRuleset(ruleset(1)));
    client({ apiKey: 'k', fetch: server.fetch, random: () => 0.5, idleTimeoutMs: 10 * 60_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(server.attempts.length).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000); // up for a minute, then the API restarts
    server.setMode('down');
    server.connections[0]!.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(server.attempts.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.attempts.length).toBe(2); // retried after 1 s, not 30 s
  });

  it('replaces a silent (half-open) connection after the idle timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer((conn) => conn.sendRuleset(ruleset(1)));
    client({ apiKey: 'k', fetch: server.fetch, random: () => 0.5, idleTimeoutMs: 75_000 });
    await vi.advanceTimersByTimeAsync(74_000);
    expect(server.attempts.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000 + 30_000);
    expect(server.attempts.length).toBe(2);
  });

  it('stops retrying when the key is rejected (401/403), and still serves fallbacks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer();
    server.setMode(401);
    const errors: unknown[] = [];
    const sdk = client({
      apiKey: 'revoked',
      fetch: server.fetch,
      fallbacks: { 'dark-mode': true },
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(server.attempts.length).toBe(1);
    expect(String(errors[0])).toContain('401');
    expect(sdk.enabled('dark-mode')).toBe(true);
  });

  it('close() stops a pending retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const server = fakeServer();
    server.setMode('down');
    const sdk = client({ apiKey: 'k', fetch: server.fetch });
    await vi.advanceTimersByTimeAsync(100);
    sdk.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(server.attempts.length).toBe(1);
  });
});

describe('SseParser', () => {
  it('handles any three-way split, including a lone CR at the start of the buffer', () => {
    const wire = 'event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\rdata: 3\n\n';
    const expected = [
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
      { event: 'message', data: '3' },
    ];
    for (let a = 0; a <= wire.length; a++) {
      for (let b = a; b <= wire.length; b++) {
        const parser = new SseParser();
        const events = [
          ...parser.push(wire.slice(0, a)),
          ...parser.push(wire.slice(a, b)),
          ...parser.push(wire.slice(b)),
        ];
        expect(events, `split at ${a}/${b}`).toEqual(expected);
      }
    }
  });

  it('handles events split at any byte, CRLF, comments and multi-line data', () => {
    const wire =
      ': hello\r\nevent: ruleset\r\nid: 3\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: ping\ndata: {}\n\n';
    for (let cut = 0; cut <= wire.length; cut++) {
      const parser = new SseParser();
      const events = [...parser.push(wire.slice(0, cut)), ...parser.push(wire.slice(cut))];
      expect(events).toEqual([
        { event: 'ruleset', data: '{"a":\n1}', id: '3' },
        { event: 'ping', data: '{}', id: '3' },
      ]);
    }
  });
});
