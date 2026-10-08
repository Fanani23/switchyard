import { describe, expect, it } from 'vitest';
import { bearerToken, digestsEqual, generateApiKey, hashApiKey } from '../src/auth/api-key.js';
import { AuthService, DEFAULT_AUTH_CACHE_TTL_MS } from '../src/auth/auth.service.js';
import type { Db } from '../src/db/client.js';
import type { ApiKey } from '../src/db/schema.js';
import type { KeysRepository, KeyWithProject } from '../src/keys/keys.repository.js';

describe('API key material', () => {
  it('has the documented shape and stores only a 64-char SHA-256', () => {
    const k = generateApiKey('client');
    expect(k.plaintext).toMatch(/^sy_client_[A-Za-z0-9_-]{43}$/);
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).toBe(hashApiKey(k.plaintext));
    expect(k.prefix).toBe(k.plaintext.slice(0, 'sy_client_'.length + 6));
    expect(k.plaintext.startsWith(k.prefix)).toBe(true);
    expect(generateApiKey('client').plaintext).not.toBe(k.plaintext);
  });

  it('compares digests in constant time and rejects unequal or empty input', () => {
    const h = hashApiKey('a');
    expect(digestsEqual(h, hashApiKey('a'))).toBe(true);
    expect(digestsEqual(h, hashApiKey('b'))).toBe(false);
    expect(digestsEqual(h, h.slice(0, 62))).toBe(false);
    expect(digestsEqual('', '')).toBe(false);
  });

  it('parses only well-formed bearer headers', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    for (const bad of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b']) {
      expect(bearerToken(bad)).toBeNull();
    }
  });
});

/** An in-memory stand-in for the key table, so cache timing can be tested with a fake clock. */
function fakeKeys(plaintext: string) {
  const row: ApiKey = {
    id: '11111111-1111-4111-8111-111111111111',
    environmentId: '22222222-2222-4222-8222-222222222222',
    name: 'sdk',
    tokenHash: hashApiKey(plaintext),
    tokenPrefix: plaintext.slice(0, 16),
    scope: 'client',
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
  };
  let lookups = 0;
  const repo = {
    async findActiveByHash(_ex: unknown, hash: string): Promise<KeyWithProject | null> {
      lookups++;
      return hash === row.tokenHash && !row.revokedAt ? { key: row, projectId: 'p' } : null;
    },
    async touchLastUsed() {},
  } as unknown as KeysRepository;
  return {
    repo,
    revoke: () => (row.revokedAt = new Date()),
    lookups: () => lookups,
  };
}

describe('D4 — a revoked key stops working within 60 seconds', () => {
  const db = {} as unknown as Db;

  it('auth.revocation-takes-effect (cache bound): a key revoked elsewhere is refused once the cache TTL passes', async () => {
    expect(DEFAULT_AUTH_CACHE_TTL_MS).toBeLessThanOrEqual(60_000);

    let now = 0;
    const plaintext = 'sy_client_test-key-material';
    const keys = fakeKeys(plaintext);
    const auth = new AuthService({ db, keys: keys.repo, now: () => now });
    const header = `Bearer ${plaintext}`;

    await expect(auth.authenticate(header)).resolves.toMatchObject({
      kind: 'key',
      scope: 'client',
    });
    keys.revoke(); // revoked through another instance: this one's cache is not told

    now = DEFAULT_AUTH_CACHE_TTL_MS - 1;
    await expect(auth.authenticate(header)).resolves.toMatchObject({ kind: 'key' });
    now = DEFAULT_AUTH_CACHE_TTL_MS + 1;
    await expect(auth.authenticate(header)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('forget() makes revocation immediate on the instance that performed it', async () => {
    const plaintext = 'sy_client_other-key';
    const keys = fakeKeys(plaintext);
    const auth = new AuthService({ db, keys: keys.repo, now: () => 0 });
    const principal = await auth.authenticate(`Bearer ${plaintext}`);
    keys.revoke();
    auth.forget(principal.kind === 'key' ? principal.keyId : '');
    await expect(auth.authenticate(`Bearer ${plaintext}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('serves repeated requests from the cache and never caches unknown keys', async () => {
    const plaintext = 'sy_client_cached';
    const keys = fakeKeys(plaintext);
    const auth = new AuthService({ db, keys: keys.repo, now: () => 0 });
    await auth.authenticate(`Bearer ${plaintext}`);
    await auth.authenticate(`Bearer ${plaintext}`);
    expect(keys.lookups()).toBe(1);

    for (let i = 0; i < 3; i++) {
      await expect(auth.authenticate('Bearer sy_client_unknown')).rejects.toMatchObject({
        statusCode: 401,
      });
    }
    expect(keys.lookups()).toBe(4);
  });

  it('accepts the root key only when one is configured', async () => {
    const keys = fakeKeys('sy_client_x');
    const root = 'r'.repeat(40);
    const withRoot = new AuthService({ db, keys: keys.repo, rootKey: root });
    await expect(withRoot.authenticate(`Bearer ${root}`)).resolves.toEqual({ kind: 'root' });
    const withoutRoot = new AuthService({ db, keys: keys.repo });
    await expect(withoutRoot.authenticate(`Bearer ${root}`)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
