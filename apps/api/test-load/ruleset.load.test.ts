import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '@switchyard/shared';
import {
  openLoop,
  processStats,
  report,
  seed,
  sleep,
  startServer,
  type Seeded,
  type ServerProcess,
} from './harness.js';

/**
 * F1 at the worst case the limits allow: an environment with 500 flags (the per-environment
 * maximum), each with a segment rule and a percentage rule, about 170 KiB of JSON per
 * response. While the load runs a flag changes every 2 s, so cache misses and invalidation
 * are part of the measurement rather than a best case it never leaves.
 *
 * The ruleset rate limit is 1,000 requests/minute per key, about 17/s, so 500 requests/s
 * comes from 40 client keys (12.5/s each), as it would from a fleet of SDK instances.
 */
const RPS = Number(process.env.LOAD_RULESET_RPS ?? 500);
const DURATION_MS = Number(process.env.LOAD_RULESET_DURATION_MS ?? 60_000);
const KEYS = 40;

let server: ServerProcess;
let seeded: Seeded;

beforeAll(async () => {
  server = await startServer();
  seeded = await seed(server, { flags: LIMITS.flagsPerEnvironment, keys: KEYS });
});
afterAll(async () => {
  await server?.stop();
});

describe('F1 — GET /ruleset serves p99 under 50 ms at 500 requests/second', () => {
  it('load.ruleset-p99', async () => {
    const run = (rps: number, durationMs: number) =>
      openLoop({
        url: `${server.url}/v1/ruleset`,
        rps,
        durationMs,
        headers: (i) => ({ authorization: `Bearer ${seeded.clientKeys[i % KEYS]}` }),
      });

    await run(100, 5000); // warm-up: JIT, connection pool, cache

    const flagId = (
      await fetch(`${server.url}/v1/environments/${seeded.environmentId}/flags?limit=1`, {
        headers: { authorization: `Bearer ${seeded.adminKey}` },
      }).then((r) => r.json() as Promise<{ items: Array<{ id: string }> }>)
    ).items[0]!.id;

    let changes = 0;
    let churning = true;
    const churn = (async () => {
      while (churning) {
        const res = await fetch(`${server.url}/v1/flags/${flagId}`, {
          method: 'PATCH',
          headers: {
            authorization: `Bearer ${seeded.adminKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ enabled: changes % 2 === 1 }),
        });
        if (res.ok) changes++;
        await sleep(2000);
      }
    })();

    const result = await run(RPS, DURATION_MS);
    churning = false;
    await churn;
    const stats = processStats(server.pid);

    console.info(report(`F1 ${RPS} rps x ${DURATION_MS / 1000} s, 500 flags`, result));
    console.info(
      `F1 flag changes during the run: ${changes}; server RSS ${stats.rssMb.toFixed(0)} MiB`,
    );

    expect(result.errors).toEqual({});
    expect(result.ok).toBe(result.sent);
    expect(result.achievedRps).toBeGreaterThan(RPS * 0.98);
    expect(result.p99).toBeLessThan(50);
    expect(changes).toBeGreaterThanOrEqual(Math.floor(DURATION_MS / 2000) - 2);
  });
});
