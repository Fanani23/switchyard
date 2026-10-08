import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { LIMITS } from '@switchyard/shared';
import { db } from '../src/db/client.js';
import type { AppInstance } from '../src/types.js';
import {
  call,
  createBooleanFlag,
  createWorld,
  ROOT_KEY,
  testApp,
  type Env,
  type FlagBody,
  type World,
} from './helpers.js';

let app: AppInstance;
let world: World;
let env: Env;

beforeAll(async () => {
  app = await testApp();
  world = await createWorld(app);
  env = world.production;
});
afterAll(async () => {
  await app.close();
});

const flagsUrl = () => `/v1/environments/${env.id}/flags`;

/** Inserts `n` boolean flags directly, faster than n API calls. Variants satisfy the trigger. */
async function seedFlags(environmentId: string, n: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO flags (environment_id, key, kind, default_variant, salt)
      SELECT ${environmentId}, 'seed-' || g, 'boolean', 'off', md5(random()::text)
      FROM generate_series(1, ${n}) AS g`);
    await tx.execute(sql`
      INSERT INTO variants (flag_id, key, position)
      SELECT f.id, v.key, v.position
      FROM flags f, (VALUES ('off', 0), ('on', 1)) AS v(key, position)
      WHERE f.environment_id = ${environmentId} AND f.key LIKE 'seed-%'`);
  });
}

describe('flag lifecycle', () => {
  it('creates boolean and multivariate flags', async () => {
    const bool = await createBooleanFlag(app, env, 'dark-mode');
    expect(bool).toMatchObject({
      key: 'dark-mode',
      default: 'off',
      enabled: true,
      variants: [{ key: 'off' }, { key: 'on' }],
      rules: [],
      lastChangedBy: `key:${env.adminKeyId}`,
    });

    const mv = await call<FlagBody>(app, 'POST', flagsUrl(), env.adminKey, {
      kind: 'multivariate',
      key: 'new-checkout',
      variants: [{ key: 'control' }, { key: 'treatment' }],
      default: 'control',
    });
    expect(mv.status).toBe(201);
    expect(mv.body.variants).toEqual([{ key: 'control' }, { key: 'treatment' }]);
  });

  it('error.409-duplicate-flag-key', async () => {
    await createBooleanFlag(app, env, 'dupe');
    const res = await call(app, 'POST', flagsUrl(), env.adminKey, { kind: 'boolean', key: 'dupe' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Flag key already exists' });

    // The same key in another environment is a different flag.
    const elsewhere = await call(
      app,
      'POST',
      `/v1/environments/${world.staging.id}/flags`,
      world.staging.adminKey,
      {
        kind: 'boolean',
        key: 'dupe',
      },
    );
    expect(elsewhere.status).toBe(201);

    // Renaming onto an existing key is the same conflict.
    const other = await createBooleanFlag(app, env, 'dupe-2');
    const rename = await call(app, 'PATCH', `/v1/flags/${other.id}`, env.adminKey, { key: 'dupe' });
    expect(rename.status).toBe(409);
  });

  it('error.404-unknown-flag-or-environment', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    for (const [method, url] of [
      ['GET', `/v1/flags/${missing}`],
      ['PATCH', `/v1/flags/${missing}`],
      ['PUT', `/v1/flags/${missing}/rules`],
      ['DELETE', `/v1/flags/${missing}`],
      ['GET', `/v1/environments/${missing}/flags`],
      ['POST', `/v1/environments/${missing}/flags`],
      ['GET', `/v1/environments/${missing}/audit`],
    ] as const) {
      const payload =
        method === 'PATCH'
          ? { enabled: false }
          : method === 'PUT'
            ? { rules: [] }
            : method === 'POST'
              ? { kind: 'boolean', key: 'x' }
              : undefined;
      const res = await call(app, method, url, ROOT_KEY, payload);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
  });

  it('error.400-malformed: bad ids, bad keys, bad kinds', async () => {
    expect((await call(app, 'GET', '/v1/flags/not-a-uuid', env.adminKey)).status).toBe(400);
    for (const body of [
      { kind: 'boolean', key: 'Has-Capitals' },
      { kind: 'boolean', key: '-leading-dash' },
      { kind: 'boolean', key: 'spaces not allowed' },
      { kind: 'ternary', key: 'x' },
      { kind: 'multivariate', key: 'mv', variants: [{ key: 'a' }], default: 'a' },
      { kind: 'multivariate', key: 'mv', variants: [{ key: 'a' }, { key: 'a' }], default: 'a' },
      { kind: 'multivariate', key: 'mv', variants: [{ key: 'a' }, { key: 'b' }], default: 'c' },
    ]) {
      const res = await call<{ error: string; details: unknown[] }>(
        app,
        'POST',
        flagsUrl(),
        env.adminKey,
        body,
      );
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.details.length).toBeGreaterThan(0);
    }
  });

  it('PATCH renames, changes the default, and toggles', async () => {
    const flag = await createBooleanFlag(app, env, 'to-patch');
    const res = await call<FlagBody>(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      key: 'patched',
      default: 'on',
      enabled: false,
      description: 'now documented',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: 'patched',
      default: 'on',
      enabled: false,
      description: 'now documented',
    });

    const badDefault = await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      default: 'maybe',
    });
    expect(badDefault.status).toBe(400);
    expect(badDefault.body).toMatchObject({ details: [{ path: 'default' }] });

    expect((await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {})).status).toBe(400);
  });

  it('PUT rules replaces the ordered list and rejects variants the flag does not have', async () => {
    const flag = await createBooleanFlag(app, env, 'ruled');
    const rules = [
      { kind: 'segment', clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: 'on' },
      { kind: 'percentage', weights: { on: 10 } },
    ];
    const res = await call<FlagBody>(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules,
    });
    expect(res.status).toBe(200);
    expect(res.body.rules).toEqual(rules);

    const bad = await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: [
        {
          kind: 'segment',
          clauses: [{ attribute: 'a', op: 'in', values: ['x'] }],
          serve: 'treatment',
        },
        { kind: 'percentage', weights: { ghost: 5 } },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({
      details: [{ path: 'rules.0.serve' }, { path: 'rules.1.weights.ghost' }],
    });

    const overweight = await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: [{ kind: 'percentage', weights: { on: 60, off: 41 } }],
    });
    expect(overweight.status).toBe(400);

    // Rejected writes changed nothing.
    const now = await call<FlagBody>(app, 'GET', `/v1/flags/${flag.id}`, env.adminKey);
    expect(now.body.rules).toEqual(rules);
  });

  it('DELETE removes the flag', async () => {
    const flag = await createBooleanFlag(app, env, 'doomed');
    expect((await call(app, 'DELETE', `/v1/flags/${flag.id}`, env.adminKey)).status).toBe(204);
    expect((await call(app, 'GET', `/v1/flags/${flag.id}`, env.adminKey)).status).toBe(404);
    expect((await call(app, 'DELETE', `/v1/flags/${flag.id}`, env.adminKey)).status).toBe(404);
  });
});

describe('conflict detection (UX.md flag detail: conflict state)', () => {
  it('refuses a write based on a stale updatedAt and returns the current flag', async () => {
    const flag = await createBooleanFlag(app, env, 'contended');
    const loaded = flag.updatedAt;

    const first = await call<FlagBody>(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      enabled: false,
      expectedUpdatedAt: loaded,
    });
    expect(first.status).toBe(200);
    expect(first.body.updatedAt).not.toBe(loaded);

    // A second editor, still holding the version they loaded.
    const stale = await call<{ error: string; current: FlagBody }>(
      app,
      'PUT',
      `/v1/flags/${flag.id}/rules`,
      env.adminKey,
      { rules: [{ kind: 'percentage', weights: { on: 50 } }], expectedUpdatedAt: loaded },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({
      enabled: false,
      rules: [],
      updatedAt: first.body.updatedAt,
    });

    // "Overwrite" is the same write with the token it was just given.
    const overwrite = await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: [{ kind: 'percentage', weights: { on: 50 } }],
      expectedUpdatedAt: stale.body.current.updatedAt,
    });
    expect(overwrite.status).toBe(200);
  });

  it('issues a distinct token for every write, even within one millisecond', async () => {
    const flag = await createBooleanFlag(app, env, 'rapid');
    const seen = new Set<string>([flag.updatedAt]);
    for (let i = 0; i < 10; i++) {
      const res = await call<FlagBody>(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
        enabled: i % 2 === 0,
      });
      expect(seen.has(res.body.updatedAt)).toBe(false);
      seen.add(res.body.updatedAt);
    }
  });
});

describe('listing (UX.md flag list: partial and filtered states)', () => {
  it('pages by key with a total, and filters by substring', async () => {
    const fresh = (await createWorld(app)).production;
    for (const key of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'beta-two']) {
      await createBooleanFlag(app, fresh, key);
    }
    const url = `/v1/environments/${fresh.id}/flags`;
    type Page = { items: FlagBody[]; total: number; nextCursor: string | null };

    const p1 = await call<Page>(app, 'GET', `${url}?limit=4`, fresh.adminKey);
    expect(p1.body.items.map((f) => f.key)).toEqual(['alpha', 'beta', 'beta-two', 'delta']);
    expect(p1.body.total).toBe(6);
    const p2 = await call<Page>(
      app,
      'GET',
      `${url}?limit=4&cursor=${p1.body.nextCursor}`,
      fresh.adminKey,
    );
    expect(p2.body.items.map((f) => f.key)).toEqual(['epsilon', 'gamma']);
    expect(p2.body.nextCursor).toBeNull();

    const filtered = await call<Page>(app, 'GET', `${url}?q=BETA`, fresh.adminKey);
    expect(filtered.body.items.map((f) => f.key)).toEqual(['beta', 'beta-two']);
    expect(filtered.body.total).toBe(2);

    // LIKE wildcards in the filter are literal.
    const wildcard = await call<Page>(app, 'GET', `${url}?q=%25`, fresh.adminKey);
    expect(wildcard.body.total).toBe(0);
  });
});

describe('limits enforced at the create endpoint and the schema', () => {
  it('limit.flags-per-environment', async () => {
    const fresh = (await createWorld(app)).production;
    await seedFlags(fresh.id, LIMITS.flagsPerEnvironment);
    const res = await call(app, 'POST', `/v1/environments/${fresh.id}/flags`, fresh.adminKey, {
      kind: 'boolean',
      key: 'one-too-many',
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Flags per environment exceeded', limit: 500, actual: 501 });
  });

  it('limit.flags-per-environment holds under concurrent creates', async () => {
    const fresh = (await createWorld(app)).production;
    await seedFlags(fresh.id, LIMITS.flagsPerEnvironment - 1);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(app, 'POST', `/v1/environments/${fresh.id}/flags`, fresh.adminKey, {
          kind: 'boolean',
          key: `race-${i}`,
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 422)).toHaveLength(7);
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM flags WHERE environment_id = ${fresh.id}`,
    );
    expect(row?.n).toBe(LIMITS.flagsPerEnvironment);
  });

  it('limit.variants-per-flag', async () => {
    const variants = Array.from({ length: LIMITS.variantsPerFlag + 1 }, (_, i) => ({
      key: `v${i}`,
    }));
    const res = await call(app, 'POST', flagsUrl(), env.adminKey, {
      kind: 'multivariate',
      key: 'too-many-variants',
      variants,
      default: 'v0',
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Variants per flag exceeded', limit: 10, actual: 11 });

    const ok = await call(app, 'POST', flagsUrl(), env.adminKey, {
      kind: 'multivariate',
      key: 'ten-variants',
      variants: variants.slice(0, 10),
      default: 'v0',
    });
    expect(ok.status).toBe(201);
  });

  it('limit.rules-per-flag, against a real flag', async () => {
    const flag = await createBooleanFlag(app, env, 'many-rules');
    const rule = { kind: 'percentage', weights: { on: 1 } };
    const res = await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: Array(21).fill(rule),
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Rules per flag exceeded', limit: 20, actual: 21 });
    const ok = await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: Array(20).fill(rule),
    });
    expect(ok.status).toBe(200);
  });

  it('limit.flag-key-length', async () => {
    const res = await call(app, 'POST', flagsUrl(), env.adminKey, {
      kind: 'boolean',
      key: 'k'.repeat(65),
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'Key length exceeded', limit: 64, actual: 65 });
    expect(
      (await call(app, 'POST', flagsUrl(), env.adminKey, { kind: 'boolean', key: 'k'.repeat(64) }))
        .status,
    ).toBe(201);
  });
});
