import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@switchyard/shared';
import { SseParser } from '@switchyard/sdk';
import {
  processStats,
  seed,
  sleep,
  startServer,
  type Seeded,
  type ServerProcess,
} from './harness.js';

/**
 * F3: 1,000 concurrent SSE connections stay open for 5 minutes with no leak.
 *
 * Production timings throughout (30 s heartbeat, 30 s auth cache). The ruleset is the
 * 500-flag worst case, so every push writes ~170 KiB to each of the 1,000 clients. Two
 * changes are pushed mid-run, to show the connections are not merely open but live.
 *
 * "No leak" is checked three ways: the server's open file descriptors track the number of
 * connections and return to baseline when they close; resident memory does not grow
 * between the first and last minute of steady state; and no connection is dropped.
 */
const CONNECTIONS = Number(process.env.LOAD_SSE_CONNECTIONS ?? 1000);
const DURATION_MS = Number(process.env.LOAD_SSE_DURATION_MS ?? 5 * 60_000);
const PER_KEY = LIMITS.sseConnectionsPerKey;
const KEYS = Math.ceil(CONNECTIONS / PER_KEY);

interface Client {
  status: number;
  versions: number[];
  pings: number;
  ended: boolean;
  firstRulesetAt: number;
  versionSeenAt: Map<number, number>;
  req: http.ClientRequest;
}

let server: ServerProcess;
let seeded: Seeded;

beforeAll(async () => {
  server = await startServer();
  seeded = await seed(server, { flags: LIMITS.flagsPerEnvironment, keys: KEYS });
});
afterAll(async () => {
  await server?.stop();
});

/** A minimal stream client: Node's http, no SDK, so the measurement is of the server. */
function connect(key: string): Promise<Client> {
  const url = new URL(`${server.url}/v1/stream`);
  return new Promise((resolve) => {
    const client = {
      status: 0,
      versions: [],
      pings: 0,
      ended: false,
      firstRulesetAt: 0,
      versionSeenAt: new Map(),
    } as unknown as Client;
    const parser = new SseParser();
    client.req = http.get(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { authorization: `Bearer ${key}`, accept: 'text/event-stream' },
        agent: false,
      },
      (res) => {
        client.status = res.statusCode ?? 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          for (const event of parser.push(chunk)) {
            if (event.event === 'ping') client.pings++;
            if (event.event === 'ruleset') {
              const version = Number(event.id);
              client.versions.push(version);
              client.versionSeenAt.set(version, performance.now());
              if (!client.firstRulesetAt) {
                client.firstRulesetAt = performance.now();
                resolve(client);
              }
            }
          }
        });
        res.on('end', () => (client.ended = true));
        res.on('close', () => (client.ended = true));
        if (client.status !== 200) resolve(client);
      },
    );
    client.req.on('error', () => {
      client.ended = true;
      resolve(client);
    });
  });
}

async function patchFlag(flagId: string, enabled: boolean): Promise<number> {
  const started = performance.now();
  const res = await fetch(`${server.url}/v1/flags/${flagId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${seeded.adminKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  expect(res.status).toBe(200);
  return started;
}

describe('F3 — 1,000 concurrent SSE connections stay open for 5 minutes with no leak', () => {
  it('load.sse-connection-ceiling', async () => {
    // Warm baseline: the database pool opens connections on demand and keeps them, and the
    // LISTEN connection starts with the first stream. Open both before measuring, so the
    // comparison after close is about stream sockets, not one-time resources.
    const warm = await Promise.all(
      Array.from({ length: 20 }, () => connect(seeded.clientKeys[0]!)),
    );
    await Promise.all(
      Array.from({ length: 30 }, () =>
        fetch(`${server.url}/v1/environments/${seeded.environmentId}/keys`, {
          headers: { authorization: `Bearer ${seeded.adminKey}` },
        }),
      ),
    );
    for (const c of warm) c.req.destroy();
    await sleep(2000);
    const baseline = processStats(server.pid);

    // Open in batches, as a fleet restarting would, rather than one synchronized burst.
    const clients: Client[] = [];
    for (let i = 0; i < CONNECTIONS; i += 100) {
      const batch = Array.from({ length: Math.min(100, CONNECTIONS - i) }, (_, j) =>
        connect(seeded.clientKeys[Math.floor((i + j) / PER_KEY)]!),
      );
      clients.push(...(await Promise.all(batch)));
    }
    expect(clients.filter((c) => c.status !== 200)).toHaveLength(0);
    expect(clients.every((c) => c.versions.length === 1)).toBe(true);

    const flagId = (
      await fetch(`${server.url}/v1/environments/${seeded.environmentId}/flags?limit=1`, {
        headers: { authorization: `Bearer ${seeded.adminKey}` },
      }).then((r) => r.json() as Promise<{ items: Array<{ id: string }> }>)
    ).items[0]!.id;

    const samples: Array<{ atS: number; rssMb: number; fds: number }> = [];
    const pushLatencies: number[] = [];
    const startedAt = performance.now();
    const elapsed = () => performance.now() - startedAt;
    const pushAt = [DURATION_MS / 3, (2 * DURATION_MS) / 3];

    while (elapsed() < DURATION_MS) {
      const stats = processStats(server.pid);
      samples.push({ atS: Math.round(elapsed() / 1000), ...stats });
      if (pushAt.length && elapsed() >= pushAt[0]!) {
        pushAt.shift();
        const before = Math.max(...clients.map((c) => c.versions.at(-1) ?? 0));
        const sentAt = await patchFlag(flagId, pushAt.length === 1 ? false : true);
        // Wait until every connection has received a version newer than it held.
        const deadline = performance.now() + 10_000;
        while (
          clients.some((c) => (c.versions.at(-1) ?? 0) <= before) &&
          performance.now() < deadline
        ) {
          await sleep(5);
        }
        const lastArrival = Math.max(
          ...clients.map((c) =>
            Math.min(...[...c.versionSeenAt].filter(([v]) => v > before).map(([, t]) => t)),
          ),
        );
        pushLatencies.push(lastArrival - sentAt);
      }
      await sleep(Math.min(10_000, Math.max(100, DURATION_MS / 30)));
    }

    const open = clients.filter((c) => !c.ended).length;
    const minPings = Math.min(...clients.map((c) => c.pings));
    // Steady state starts once the first push has gone out: from then on the server holds
    // everything it needs, and only a leak would make it keep growing.
    const steady = samples.filter((s) => s.atS * 1000 >= DURATION_MS / 3 + 5000);
    const firstRss = steady[0]?.rssMb ?? NaN;
    const lastRss = steady.at(-1)?.rssMb ?? NaN;
    const peakFds = Math.max(...samples.map((s) => s.fds));

    // Close every client, then the server should be back to where it started.
    for (const c of clients) c.req.destroy();
    await sleep(3000);
    const after = processStats(server.pid);
    const health = await fetch(`${server.url}/health`);

    console.info(
      `F3 ${CONNECTIONS} connections x ${DURATION_MS / 1000} s: ${open} open at the end; ` +
        `min pings per connection ${minPings}; pushes reached all clients in ` +
        `${pushLatencies.map((l) => `${l.toFixed(0)} ms`).join(', ')}; ` +
        `server fds ${baseline.fds} -> peak ${peakFds} -> ${after.fds} after close; ` +
        `RSS ${baseline.rssMb.toFixed(0)} MiB idle, ${firstRss.toFixed(0)} -> ${lastRss.toFixed(0)} MiB ` +
        `steady state, ${after.rssMb.toFixed(0)} MiB after close`,
    );
    console.info(
      `F3 samples ${JSON.stringify(samples.map((s) => [s.atS, Math.round(s.rssMb), s.fds]))}`,
    );

    // Every connection survived the whole run and stayed live.
    expect(open).toBe(CONNECTIONS);
    expect(minPings).toBeGreaterThanOrEqual(Math.floor(DURATION_MS / 30_000) - 1);
    expect(clients.every((c) => c.versions.length === 3)).toBe(true);
    expect(pushLatencies).toHaveLength(2);
    // One socket per connection while open, and all of them released after.
    expect(peakFds).toBeGreaterThanOrEqual(baseline.fds + CONNECTIONS);
    expect(after.fds).toBeLessThanOrEqual(baseline.fds + 2);
    // No growth across steady state (allowing for GC timing noise).
    expect(lastRss).toBeLessThan(firstRss * 1.1 + 20);
    // Every change reaches all 1,000 clients within SPEC.md B1's 1 s, under this load.
    expect(Math.max(...pushLatencies)).toBeLessThan(1000);
    expect(health.status).toBe(200);
  });
});
