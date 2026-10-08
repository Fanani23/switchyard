import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AuditEntryDto } from '@switchyard/shared';
import { db } from '../src/db/client.js';
import { auditLog } from '../src/db/schema.js';
import type { AppInstance } from '../src/types.js';
import {
  call,
  createBooleanFlag,
  createWorld,
  ROOT_KEY,
  testApp,
  type FlagBody,
  type World,
} from './helpers.js';

let app: AppInstance;
let world: World;

beforeAll(async () => {
  app = await testApp();
  world = await createWorld(app);
});
afterAll(async () => {
  await app.close();
});

type Page = { items: AuditEntryDto[]; nextCursor: string | null };

async function auditOf(envId: string, key = ROOT_KEY): Promise<AuditEntryDto[]> {
  const all: AuditEntryDto[] = [];
  let cursor: string | null = null;
  do {
    const url: string = `/v1/environments/${envId}/audit?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const res: { status: number; body: Page } = await call<Page>(app, 'GET', url, key);
    expect(res.status).toBe(200);
    all.push(...res.body.items);
    cursor = res.body.nextCursor;
  } while (cursor);
  return all;
}

describe('E1 — every change records actor, timestamp, before and after', () => {
  it('audit.records-change', async () => {
    const { production: env } = await createWorld(app);
    const actor = `key:${env.adminKeyId}`;
    const startedAt = Date.now();

    const flag = await createBooleanFlag(app, env, 'audited');
    const patched = await call<FlagBody>(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      enabled: false,
    });
    const ruled = await call<FlagBody>(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: [{ kind: 'percentage', weights: { on: 25 } }],
    });
    const renamed = await call<FlagBody>(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      key: 'audited-2',
    });
    await call(app, 'DELETE', `/v1/flags/${flag.id}`, env.adminKey);
    const minted = await call<{ id: string }>(
      app,
      'POST',
      `/v1/environments/${env.id}/keys`,
      env.adminKey,
      {
        name: 'temp',
        scope: 'client',
      },
    );
    await call(app, 'DELETE', `/v1/keys/${minted.body.id}`, env.adminKey);

    // Newest first, so reverse into the order the changes were made.
    const entries = (await auditOf(env.id)).reverse();
    expect(entries.map((e) => e.action)).toEqual([
      'environment.created',
      'api_key.created', // the admin key the world was set up with
      'api_key.created', // the client key
      'flag.created',
      'flag.disabled',
      'flag.rules_replaced',
      'flag.updated',
      'flag.deleted',
      'api_key.created',
      'api_key.revoked',
    ]);

    const [, , , created, disabled, rulesReplaced, updated, deleted, keyCreated, keyRevoked] =
      entries;
    for (const e of [created, disabled, rulesReplaced, updated, deleted, keyCreated, keyRevoked]) {
      expect(e?.actor).toBe(actor);
      expect(e?.environmentId).toBe(env.id);
      expect(e?.environmentKey).toBe('production');
      expect(Date.parse(e!.createdAt)).toBeGreaterThanOrEqual(startedAt - 1000);
    }
    expect(entries[0]?.actor).toBe('root');

    expect(created).toMatchObject({
      entityType: 'flag',
      entityId: flag.id,
      before: null,
      after: { enabled: true },
    });
    expect(disabled).toMatchObject({ before: { enabled: true }, after: { enabled: false } });
    expect(disabled?.after).toMatchObject({ updatedAt: patched.body.updatedAt });
    expect(rulesReplaced).toMatchObject({
      before: { rules: [] },
      after: {
        rules: [{ kind: 'percentage', weights: { on: 25 } }],
        updatedAt: ruled.body.updatedAt,
      },
    });
    expect(updated).toMatchObject({ before: { key: 'audited' }, after: { key: renamed.body.key } });
    expect(deleted).toMatchObject({ before: { key: 'audited-2' }, after: null });
    expect(keyCreated).toMatchObject({
      entityType: 'api_key',
      before: null,
      after: { scope: 'client' },
    });
    expect(keyRevoked).toMatchObject({
      before: { revokedAt: null },
      after: { revokedAt: expect.any(String) },
    });

    // No secret ever reaches the log.
    expect(JSON.stringify(entries)).not.toMatch(/sy_(admin|client)_[A-Za-z0-9_-]{20,}/);
  });

  it('the flag list shows who changed each flag last', async () => {
    const { production: env } = world;
    const flag = await createBooleanFlag(app, env, 'who-changed');
    await call(app, 'PATCH', `/v1/flags/${flag.id}`, ROOT_KEY, { enabled: false });
    const list = await call<{ items: FlagBody[] }>(
      app,
      'GET',
      `/v1/environments/${env.id}/flags?q=who-changed`,
      env.adminKey,
    );
    expect(list.body.items[0]?.lastChangedBy).toBe('root');
  });

  it('a change and its audit entry commit together or not at all', async () => {
    const { production: env } = world;
    const flag = await createBooleanFlag(app, env, 'atomic');
    const before = (await auditOf(env.id)).length;
    // Rejected after validation, inside the transaction: no change and no entry.
    const res = await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, {
      default: 'nonexistent',
    });
    expect(res.status).toBe(400);
    expect((await auditOf(env.id)).length).toBe(before);
  });

  it('entries survive the deletion of their environment', async () => {
    const doomed = await createWorld(app);
    await createBooleanFlag(app, doomed.production, 'outlives-env');
    const envId = doomed.production.id;
    await db.execute(sql`DELETE FROM environments WHERE id = ${envId}`);
    const rows = await db.select().from(auditLog).where(eq(auditLog.environmentId, envId));
    expect(rows.map((r) => r.action)).toContain('flag.created');
    expect(rows.every((r) => r.environmentKey === 'production')).toBe(true);
  });
});

describe('E2 — audit entries cannot be edited or deleted through the API', () => {
  it('audit.is-append-only', async () => {
    const { production: env } = world;
    await createBooleanFlag(app, env, 'immutable-history');
    const entries = await auditOf(env.id);
    const target = entries[0]!;

    // No route mutates the audit log, for any key, root included.
    for (const method of ['PUT', 'PATCH', 'DELETE', 'POST'] as const) {
      for (const url of [
        `/v1/environments/${env.id}/audit`,
        `/v1/environments/${env.id}/audit/${target.id}`,
        `/v1/audit/${target.id}`,
      ]) {
        const res = await call(
          app,
          method,
          url,
          ROOT_KEY,
          method === 'DELETE' ? undefined : { action: 'forged' },
        );
        expect(res.status, `${method} ${url}`).toBe(404);
      }
    }

    // And the database refuses even a direct attempt.
    await expect(
      db.update(auditLog).set({ actor: 'forged' }).where(eq(auditLog.id, target.id)),
    ).rejects.toThrow();
    await expect(db.delete(auditLog).where(eq(auditLog.id, target.id))).rejects.toThrow();
    await expect(db.execute(sql`TRUNCATE audit_log`)).rejects.toThrow();

    expect(await auditOf(env.id)).toEqual(entries);
  });
});

describe('audit reads', () => {
  it('pages newest first with a stable cursor and no gaps or repeats', async () => {
    const { production: env } = await createWorld(app);
    const flag = await createBooleanFlag(app, env, 'paged');
    for (let i = 0; i < 12; i++) {
      await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, { enabled: i % 2 === 1 });
    }
    const everything = await auditOf(env.id);

    const pages: AuditEntryDto[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/environments/${env.id}/audit?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
      const res: { body: Page } = await call<Page>(app, 'GET', url, env.adminKey);
      expect(res.body.items.length).toBeLessThanOrEqual(5);
      pages.push(...res.body.items);
      cursor = res.body.nextCursor;
    } while (cursor);

    expect(pages.map((e) => e.id)).toEqual(everything.map((e) => e.id));
    const times = pages.map((e) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('rejects a cursor from another environment', async () => {
    const prodEntry = (await auditOf(world.production.id))[0]!;
    const res = await call(
      app,
      'GET',
      `/v1/environments/${world.staging.id}/audit?cursor=${prodEntry.id}`,
      ROOT_KEY,
    );
    expect(res.status).toBe(400);
  });

  it('retention: the cleanup removes entries past 90 days and nothing newer', async () => {
    const envId = world.staging.id;
    const [old] = await db
      .insert(auditLog)
      .values({
        environmentId: envId,
        environmentKey: 'staging',
        actor: 'test',
        action: 'test.ancient',
        entityType: 'test',
        after: {},
        createdAt: sql`now() - interval '91 days'`,
      })
      .returning();
    const recentBefore = (await auditOf(envId)).filter((e) => e.action !== 'test.ancient').length;

    const { AuditService } = await import('../src/audit/audit.service.js');
    const { auditRepository } = await import('../src/audit/audit.repository.js');
    const { environmentsRepository } =
      await import('../src/environments/environments.repository.js');
    const purged = await new AuditService({
      db,
      audit: auditRepository,
      environments: environmentsRepository,
    }).purgeExpired();

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.id, old!.id))).toEqual([]);
    expect((await auditOf(envId)).length).toBe(recentBefore);
  });
});
