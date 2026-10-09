import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@switchyard/shared';
import { SseParser, Switchyard, type SseEvent } from '@switchyard/sdk';
import type { AppOptions } from '../src/app.js';
import type { AppInstance } from '../src/types.js';
import { call, createBooleanFlag, createWorld, ROOT_KEY, testApp, type Env } from './helpers.js';

/**
 * Propagation against real infrastructure: API instances listening on real ports, the real
 * SDK, and PostgreSQL LISTEN/NOTIFY carrying changes between instances.
 */
const open: Array<{ close(): unknown }> = [];
afterEach(async () => {
  for (const item of open.splice(0).reverse()) await item.close();
});

async function serve(
  opts: AppOptions = {},
  port = 0,
): Promise<{ app: AppInstance; url: string; port: number }> {
  const app = await testApp(opts);
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  open.push(app);
  return { app, url: `http://127.0.0.1:${address.port}`, port: address.port };
}

function sdk(url: string, apiKey: string): Switchyard {
  const client = new Switchyard({
    apiKey,
    baseUrl: url,
    readyTimeoutMs: 5000,
    // Real backoff shape, scaled down so the reconnect tests take milliseconds, not seconds.
    backoff: { initialMs: 50, maxMs: 400 },
  });
  open.push(client);
  return client;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<number> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 2));
  }
  return performance.now() - start;
}

/** A raw stream reader, for asserting on the wire rather than through the SDK. */
async function rawStream(url: string, key: string | null) {
  const controller = new AbortController();
  const res = await fetch(`${url}/v1/stream`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  let ended = false;
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const parser = new SseParser();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(...parser.push(decoder.decode(value, { stream: true })));
        }
      } catch {
        // aborted
      }
      ended = true;
    })();
  }
  const handle = {
    res,
    events,
    ended: () => ended,
    close: () => controller.abort(),
  };
  open.push(handle);
  return handle;
}

let admin: AppInstance;
let env: Env;
beforeAll(async () => {
  admin = await testApp();
  env = (await createWorld(admin)).production;
});
afterAll(async () => {
  await admin.close();
});

describe('B1 — a flag change reaches a connected SDK in under 1 second', () => {
  it('stream.propagates-under-1s', async () => {
    const { url } = await serve();
    const flag = await createBooleanFlag(admin, env, 'b1-latency');
    const client = sdk(url, env.clientKey);
    await client.ready();
    await until(() => client.variant('b1-latency', { key: 'u' }) === 'off');

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const target = i % 2 === 0 ? 'on' : 'off';
      const started = performance.now();
      const res = await call(admin, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
        default: target,
      });
      expect(res.status).toBe(200);
      await until(() => client.variant('b1-latency', { key: 'u' }) === target, 1000);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    // Every one of 20 changes, measured from the request until the SDK serves it.
    expect(samples.at(-1)).toBeLessThan(1000);
    console.info(
      `B1 propagation over 20 changes: p50 ${samples[10]!.toFixed(1)} ms, max ${samples.at(-1)!.toFixed(1)} ms`,
    );
  });
});

describe('B2 — an SDK that reconnects after downtime receives the current ruleset', () => {
  it('stream.resync-on-reconnect', async () => {
    const flag = await createBooleanFlag(admin, env, 'b2-resync');
    const first = await serve();
    const client = sdk(first.url, env.clientKey);
    await client.ready();
    expect(client.enabled('b2-resync', { key: 'u' })).toBe(false);
    const versionBefore = client.rulesetVersion!;

    // The API instance the SDK is connected to goes down...
    await first.app.close();
    open.splice(open.indexOf(first.app), 1);

    // ...a change is made while it is down (through another instance; nothing is pushed
    // to this SDK, because nothing is connected to it)...
    await call(admin, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, { default: 'on' });
    await new Promise((r) => setTimeout(r, 150));
    expect(client.enabled('b2-resync', { key: 'u' })).toBe(false); // still the cached ruleset

    // ...and an API comes back on the same address. The SDK reconnects on its own and the
    // first event of the new stream is the current ruleset.
    await serve({}, first.port);
    await until(() => client.enabled('b2-resync', { key: 'u' }));
    expect(client.rulesetVersion).toBeGreaterThan(versionBefore);
  });
});

describe('B3 — a change made against one API instance reaches clients on another', () => {
  it('stream.fans-out-across-instances', async () => {
    const instanceA = await serve();
    const instanceB = await serve();
    const flag = await createBooleanFlag(admin, env, 'b3-fanout');
    const onB = sdk(instanceB.url, env.clientKey);
    await onB.ready();
    await until(() => onB.variant('b3-fanout', { key: 'u' }) === 'off');

    // Over real HTTP to instance A, which has no streams of its own.
    const started = performance.now();
    const res = await fetch(`${instanceA.url}/v1/flags/${flag.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${env.adminKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ default: 'on' }),
    });
    expect(res.status).toBe(200);
    await until(() => onB.enabled('b3-fanout', { key: 'u' }), 1000);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('/v1/stream policy', () => {
  it('starts with the current ruleset, then pings on the heartbeat', async () => {
    const { url } = await serve({ streamHeartbeatMs: 100 });
    const stream = await rawStream(url, env.clientKey);
    expect(stream.res.status).toBe(200);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
    await until(() => stream.events.filter((e) => e.event === 'ping').length >= 2, 2000);
    expect(stream.events[0]?.event).toBe('ruleset');
    expect(JSON.parse(stream.events[0]!.data)).toMatchObject({ environmentId: env.id });
  });

  it('rejects missing keys (401) and the root key (403) as ordinary JSON errors', async () => {
    const { url } = await serve();
    const none = await fetch(`${url}/v1/stream`);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: 'Unauthorized' });
    const root = await fetch(`${url}/v1/stream`, {
      headers: { authorization: `Bearer ${ROOT_KEY}` },
    });
    expect(root.status).toBe(403);
    expect(await root.json()).toEqual({ error: 'Forbidden' });
  });

  it('limit.sse-connections-per-key', async () => {
    const fresh = (await createWorld(admin)).staging;
    const { url } = await serve();
    const streams = await Promise.all(
      Array.from({ length: LIMITS.sseConnectionsPerKey }, () => rawStream(url, fresh.clientKey)),
    );
    expect(streams.every((s) => s.res.status === 200)).toBe(true);

    const over = await fetch(`${url}/v1/stream`, {
      headers: { authorization: `Bearer ${fresh.clientKey}` },
    });
    expect(over.status).toBe(422);
    expect(await over.json()).toEqual({
      error: 'Stream connections per key exceeded',
      limit: 50,
      actual: 51,
    });

    // Another key is unaffected; and closing a stream frees its slot.
    const other = await rawStream(url, fresh.adminKey);
    expect(other.res.status).toBe(200);
    streams[0]!.close();
    let status = 0;
    for (let i = 0; i < 100 && status !== 200; i++) {
      const res = await fetch(`${url}/v1/stream`, {
        headers: { authorization: `Bearer ${fresh.clientKey}` },
      });
      status = res.status;
      if (status === 200) void res.body?.cancel();
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe(200);
  });

  it('a stream opened with a key that is later revoked is closed (D4 for streams)', async () => {
    const fresh = (await createWorld(admin)).production;
    // Production timings are 30 s heartbeat and 30 s auth cache, so 60 s at most.
    const { url } = await serve({ streamHeartbeatMs: 100, authCacheTtlMs: 100 });
    const stream = await rawStream(url, fresh.clientKey);
    await until(() => stream.events.length > 0);

    const revoked = await call(admin, 'DELETE', `/v1/keys/${fresh.clientKeyId}`, fresh.adminKey);
    expect(revoked.status).toBe(204);
    const waited = await until(() => stream.ended(), 2000);
    expect(waited).toBeLessThan(1000);
  });

  it('shutting an instance down ends its streams instead of hanging on them', async () => {
    const { app, url } = await serve();
    const streams = await Promise.all([1, 2, 3].map(() => rawStream(url, env.clientKey)));
    const started = performance.now();
    await app.close();
    open.splice(open.indexOf(app), 1);
    expect(performance.now() - started).toBeLessThan(2000);
    await until(() => streams.every((s) => s.ended()));
  });
});
