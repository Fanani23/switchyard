import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { apiKeys } from '../src/db/schema.js';
import { hashApiKey } from '../src/auth/api-key.js';
import type { AppInstance } from '../src/types.js';
import { call, createBooleanFlag, createWorld, ROOT_KEY, testApp, type World } from './helpers.js';

let app: AppInstance;
let world: World;

beforeAll(async () => {
  app = await testApp();
  world = await createWorld(app);
});
afterAll(async () => {
  await app.close();
});

describe('D1 — a key scoped to staging cannot read production', () => {
  it('auth.key-is-environment-scoped', async () => {
    const { production, staging } = world;
    const prodFlag = await createBooleanFlag(app, production, 'prod-only');

    // Staging's admin key, against every production resource: 403, never the data.
    const attempts: Array<[Parameters<typeof call>[1], string, unknown?]> = [
      ['GET', `/v1/environments/${production.id}/flags`],
      ['POST', `/v1/environments/${production.id}/flags`, { kind: 'boolean', key: 'sneaky' }],
      ['GET', `/v1/flags/${prodFlag.id}`],
      ['PATCH', `/v1/flags/${prodFlag.id}`, { enabled: false }],
      ['PUT', `/v1/flags/${prodFlag.id}/rules`, { rules: [] }],
      ['DELETE', `/v1/flags/${prodFlag.id}`],
      ['GET', `/v1/environments/${production.id}/audit`],
      ['GET', `/v1/environments/${production.id}/keys`],
      ['POST', `/v1/environments/${production.id}/keys`, { name: 'x', scope: 'admin' }],
      ['DELETE', `/v1/keys/${production.adminKeyId}`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await call(app, method, url, staging.adminKey, payload);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    }

    // The ruleset is chosen by the key, so staging's key can only ever see staging.
    const ruleset = await call<{ environmentId: string; flags: Array<{ key: string }> }>(
      app,
      'GET',
      '/v1/ruleset',
      staging.clientKey,
    );
    expect(ruleset.status).toBe(200);
    expect(ruleset.body.environmentId).toBe(staging.id);
    expect(ruleset.body.flags.map((f) => f.key)).not.toContain('prod-only');

    // Nothing changed in production.
    const after = await call<{ enabled: boolean }>(
      app,
      'GET',
      `/v1/flags/${prodFlag.id}`,
      production.adminKey,
    );
    expect(after.body.enabled).toBe(true);
  });

  it('an admin key lists only its own project', async () => {
    const other = await createWorld(app);
    const res = await call<{ items: Array<{ id: string }> }>(
      app,
      'GET',
      '/v1/projects',
      world.staging.adminKey,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.map((p) => p.id)).toEqual([world.projectId]);
    expect(res.body.items.map((p) => p.id)).not.toContain(other.projectId);
  });

  it('only the root key creates projects and environments', async () => {
    const { production } = world;
    expect(
      (await call(app, 'POST', '/v1/projects', production.adminKey, { name: 'x', slug: 'x-y' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          app,
          'POST',
          `/v1/projects/${world.projectId}/environments`,
          production.adminKey,
          { name: 'qa', key: 'qa' },
        )
      ).status,
    ).toBe(403);
  });
});

describe('D2 — a client key reads the ruleset but cannot modify a flag', () => {
  it('auth.client-key-is-read-only', async () => {
    const { production } = world;
    const flag = await createBooleanFlag(app, production, 'client-cannot-touch');

    expect((await call(app, 'GET', '/v1/ruleset', production.clientKey)).status).toBe(200);

    const writes: Array<[Parameters<typeof call>[1], string, unknown?]> = [
      ['POST', `/v1/environments/${production.id}/flags`, { kind: 'boolean', key: 'nope' }],
      ['PATCH', `/v1/flags/${flag.id}`, { enabled: false }],
      ['PUT', `/v1/flags/${flag.id}/rules`, { rules: [] }],
      ['DELETE', `/v1/flags/${flag.id}`],
      ['POST', `/v1/environments/${production.id}/keys`, { name: 'escalate', scope: 'admin' }],
      ['DELETE', `/v1/keys/${production.adminKeyId}`],
      // Client keys ship inside applications; the admin read surface is not theirs either.
      ['GET', `/v1/environments/${production.id}/flags`],
      ['GET', `/v1/environments/${production.id}/audit`],
      ['GET', '/v1/projects'],
    ];
    for (const [method, url, payload] of writes) {
      const res = await call(app, method, url, production.clientKey, payload);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    const after = await call<{ enabled: boolean }>(
      app,
      'GET',
      `/v1/flags/${flag.id}`,
      production.adminKey,
    );
    expect(after.body.enabled).toBe(true);
  });
});

describe('D3 — no key or an unknown key is rejected with 401', () => {
  it('auth.rejects-missing-and-unknown-keys', async () => {
    const unknown = [
      null,
      'sy_admin_thisKeyDoesNotExistAnywhereInTheDatabase000000',
      `${world.production.adminKey}x`, // one character off a real key
      world.production.adminKey.slice(0, -1),
    ];
    for (const key of unknown) {
      for (const url of [
        '/v1/ruleset',
        '/v1/projects',
        `/v1/environments/${world.production.id}/flags`,
      ]) {
        const res = await call(app, 'GET', url, key);
        expect(res.status, `${url} with ${key}`).toBe(401);
        expect(res.body).toEqual({ error: 'Unauthorized' });
      }
    }
  });

  it('stores only the SHA-256 of a key; the plaintext appears in the create response only', async () => {
    const created = await call<{ id: string; key: string; prefix: string }>(
      app,
      'POST',
      `/v1/environments/${world.production.id}/keys`,
      world.production.adminKey,
      { name: 'ci', scope: 'client' },
    );
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.body.id));
    expect(row?.tokenHash).toBe(hashApiKey(created.body.key));
    expect(JSON.stringify(row)).not.toContain(created.body.key);

    const listed = await call(
      app,
      'GET',
      `/v1/environments/${world.production.id}/keys`,
      world.production.adminKey,
    );
    expect(JSON.stringify(listed.body)).not.toContain(created.body.key);
    expect(JSON.stringify(listed.body)).not.toContain(hashApiKey(created.body.key));
    expect(JSON.stringify(listed.body)).toContain(created.body.prefix);
  });

  it('records when a key was last used', async () => {
    const res = await call<{ items: Array<{ id: string; lastUsedAt: string | null }> }>(
      app,
      'GET',
      `/v1/environments/${world.production.id}/keys`,
      world.production.adminKey,
    );
    const admin = res.body.items.find((k) => k.id === world.production.adminKeyId);
    expect(admin?.lastUsedAt).not.toBeNull();
  });
});

describe('D4 — a revoked key stops working within 60 seconds', () => {
  it('auth.revocation-takes-effect', async () => {
    const fresh = await createWorld(app);
    const { production } = fresh;
    expect((await call(app, 'GET', '/v1/ruleset', production.clientKey)).status).toBe(200);

    // A second API instance, which has the key cached and is not told about the revocation.
    const ttlMs = 300;
    const other = await testApp({ authCacheTtlMs: ttlMs });
    try {
      expect((await call(other, 'GET', '/v1/ruleset', production.clientKey)).status).toBe(200);

      const revoked = await call(
        app,
        'DELETE',
        `/v1/keys/${production.clientKeyId}`,
        production.adminKey,
      );
      expect(revoked.status).toBe(204);

      // The instance that revoked it refuses the key at once.
      expect((await call(app, 'GET', '/v1/ruleset', production.clientKey)).status).toBe(401);

      // The other instance refuses it once its cache entry expires (30 s in production,
      // shortened here); the unit test pins the production TTL under SPEC.md's 60 s.
      await new Promise((r) => setTimeout(r, ttlMs + 50));
      expect((await call(other, 'GET', '/v1/ruleset', production.clientKey)).status).toBe(401);
    } finally {
      await other.close();
    }

    // Revoking twice is harmless.
    expect(
      (await call(app, 'DELETE', `/v1/keys/${production.clientKeyId}`, production.adminKey)).status,
    ).toBe(204);
    // Revocation is visible in the key list.
    const list = await call<{ items: Array<{ id: string; revokedAt: string | null }> }>(
      app,
      'GET',
      `/v1/environments/${production.id}/keys`,
      production.adminKey,
    );
    expect(list.body.items.find((k) => k.id === production.clientKeyId)?.revokedAt).not.toBeNull();
  });

  it('unknown key id is 404, not a silent success', async () => {
    const res = await call(
      app,
      'DELETE',
      '/v1/keys/00000000-0000-4000-8000-000000000000',
      ROOT_KEY,
    );
    expect(res.status).toBe(404);
  });
});
