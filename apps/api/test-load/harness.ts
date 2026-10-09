import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';

/**
 * Load tests run the built server (`dist/server.js`) as its own process, configured exactly
 * as in production: real rate limits, 30 s heartbeat, 30 s auth cache. Generating load from
 * the same event loop as the server would measure the generator, not the server.
 */
export interface ServerProcess {
  url: string;
  pid: number;
  rootKey: string;
  stop(): Promise<void>;
}

const API_DIR = fileURLToPath(new URL('..', import.meta.url));

export async function startServer(env: Record<string, string> = {}): Promise<ServerProcess> {
  const port = 4600 + Math.floor(Math.random() * 300);
  const rootKey = `root-${randomBytes(24).toString('hex')}`;
  const child: ChildProcess = spawn(process.execPath, ['dist/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      SWITCHYARD_ROOT_KEY: rootKey,
      ...env,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('server did not start');
    }
    await sleep(100);
  }
  return {
    url,
    pid: child.pid ?? -1,
    rootKey,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resident memory and open file descriptors of a process, from /proc (Linux). */
export function processStats(pid: number): { rssMb: number; fds: number } {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return { rssMb: rssKb / 1024, fds: readdirSync(`/proc/${pid}/fd`).length };
}

/** Admin calls for seeding go straight to the server with the root key. */
export async function admin<T>(
  server: ServerProcess,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.rootKey}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export interface Seeded {
  environmentId: string;
  clientKeys: string[];
  adminKey: string;
}

/**
 * A project with one environment, `keys` client keys and an admin key. Flags are inserted
 * in SQL (the Admin API's own 100/min limit would make seeding 500 flags take minutes):
 * `flags` boolean flags, each with a segment rule and a percentage rule, which is the
 * shape of a typical rollout.
 */
export async function seed(
  server: ServerProcess,
  opts: { flags: number; keys: number },
): Promise<Seeded> {
  const project = await admin<{ id: string }>(server, 'POST', '/v1/projects', {
    name: 'Load',
    slug: `load-${randomBytes(4).toString('hex')}`,
  });
  const env = await admin<{ id: string }>(
    server,
    'POST',
    `/v1/projects/${project.id}/environments`,
    {
      name: 'production',
      key: 'production',
    },
  );
  const mint = (scope: 'admin' | 'client') =>
    admin<{ key: string }>(server, 'POST', `/v1/environments/${env.id}/keys`, {
      name: scope,
      scope,
    });
  const adminKey = (await mint('admin')).key;
  const clientKeys: string[] = [];
  for (let i = 0; i < opts.keys; i++) clientKeys.push((await mint('client')).key);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO flags (environment_id, key, description, kind, default_variant, salt)
      SELECT ${env.id}, 'load-flag-' || g, 'Seeded for load testing', 'boolean', 'off',
             md5(random()::text)
      FROM generate_series(1, ${opts.flags}) AS g`);
    await tx.execute(sql`
      INSERT INTO variants (flag_id, key, position)
      SELECT f.id, v.key, v.position
      FROM flags f, (VALUES ('off', 0), ('on', 1)) AS v(key, position)
      WHERE f.environment_id = ${env.id}`);
    await tx.execute(sql`
      INSERT INTO rules (flag_id, position, kind, config)
      SELECT f.id, 0, 'segment',
             '{"clauses":[{"attribute":"plan","op":"in","values":["pro","team"]},
                          {"attribute":"country","op":"in","values":["ID","SG","MY"]}],
               "serve":"on"}'::jsonb
      FROM flags f WHERE f.environment_id = ${env.id}`);
    await tx.execute(sql`
      INSERT INTO rules (flag_id, position, kind, config)
      SELECT f.id, 1, 'percentage', '{"weights":{"on":25}}'::jsonb
      FROM flags f WHERE f.environment_id = ${env.id}`);
  });
  return { environmentId: env.id, clientKeys, adminKey };
}

export interface LoadResult {
  sent: number;
  ok: number;
  errors: Record<string, number>;
  achievedRps: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  bytes: number;
}

const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });

/**
 * Open-loop load: requests are launched on a fixed schedule whether or not earlier ones have
 * returned, and latency is measured from each request's *scheduled* time. A closed loop
 * (wait, then send the next) slows down exactly when the server does and hides the queueing
 * it causes ("coordinated omission"); this cannot.
 */
export async function openLoop(opts: {
  url: string;
  rps: number;
  durationMs: number;
  headers: (i: number) => Record<string, string>;
}): Promise<LoadResult> {
  const target = new URL(opts.url);
  const total = Math.round((opts.rps * opts.durationMs) / 1000);
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let bytes = 0;
  const start = performance.now();
  const inflight: Promise<void>[] = [];

  const fire = (i: number, scheduledAt: number) =>
    new Promise<void>((resolve) => {
      const req = http.request(
        {
          agent,
          host: target.hostname,
          port: target.port,
          path: target.pathname,
          method: 'GET',
          headers: opts.headers(i),
        },
        (res) => {
          res.on('data', (chunk: Buffer) => (bytes += chunk.length));
          res.on('end', () => {
            if (res.statusCode === 200) latencies.push(performance.now() - scheduledAt);
            else errors[`HTTP ${res.statusCode}`] = (errors[`HTTP ${res.statusCode}`] ?? 0) + 1;
            resolve();
          });
        },
      );
      req.on('error', (err) => {
        errors[err.message] = (errors[err.message] ?? 0) + 1;
        resolve();
      });
      req.end();
    });

  // Launch on a 1 ms tick, catching up on every request whose scheduled time has passed.
  let next = 0;
  await new Promise<void>((done) => {
    const tick = () => {
      const now = performance.now() - start;
      while (next < total && (next * 1000) / opts.rps <= now) {
        inflight.push(fire(next, start + (next * 1000) / opts.rps));
        next++;
      }
      if (next < total) setTimeout(tick, 1);
      else done();
    };
    tick();
  });
  await Promise.all(inflight);
  const elapsed = performance.now() - start;

  latencies.sort((a, b) => a - b);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? NaN;
  return {
    sent: total,
    ok: latencies.length,
    errors,
    achievedRps: (total * 1000) / elapsed,
    p50: pct(50),
    p90: pct(90),
    p99: pct(99),
    max: latencies.at(-1) ?? NaN,
    bytes,
  };
}

export function report(label: string, r: LoadResult): string {
  return (
    `${label}: ${r.ok}/${r.sent} ok at ${r.achievedRps.toFixed(0)} rps; ` +
    `p50 ${r.p50.toFixed(1)} ms, p90 ${r.p90.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms, ` +
    `max ${r.max.toFixed(1)} ms; ${(r.bytes / r.ok / 1024).toFixed(1)} KiB/response; ` +
    `errors ${JSON.stringify(r.errors)}`
  );
}
