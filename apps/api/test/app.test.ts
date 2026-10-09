import { afterEach, describe, expect, it } from 'vitest';
import { LIMITS, replaceRulesBodySchema } from '@switchyard/shared';
import { buildApp } from '../src/app.js';
import type { AppInstance } from '../src/types.js';

/**
 * The HTTP baseline: everything here is answered before any database access, so it runs
 * as a unit test. Behavior that needs PostgreSQL lives in test-integration/.
 */
let app: AppInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWithProbes(opts: Parameters<typeof buildApp>[0] = {}): Promise<AppInstance> {
  const instance = await buildApp({ logLevel: 'silent', ...opts });
  instance.get('/probe/boom', async () => {
    throw new Error('SELECT * FROM api_keys WHERE token_hash = secret');
  });
  instance.get('/probe/ok', async () => ({ ok: true }));
  instance.put('/probe/rules', { schema: { body: replaceRulesBodySchema } }, async () => ({
    ok: true,
  }));
  await instance.ready();
  return instance;
}

describe('security baseline', () => {
  it('serves /health with helmet security headers', async () => {
    app = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('error.500-hides-internal-message', async () => {
    app = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/probe/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error' });
    expect(res.body).not.toContain('SELECT');
  });

  it('error.404-unknown-route', async () => {
    app = await appWithProbes();
    const res = await app.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not found' });
  });
});

describe('CORS for the dashboard', () => {
  it('allows every method the Admin API uses, from an allowed origin', async () => {
    app = await appWithProbes();
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/flags/00000000-0000-4000-8000-000000000000',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(res.statusCode, method).toBe(204);
      expect(String(res.headers['access-control-allow-methods']), method).toContain(method);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    }
  });

  it('does not allow other origins', async () => {
    app = await appWithProbes();
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/projects',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('D3 — no key is rejected with 401 before anything else happens', () => {
  it('auth.rejects-missing-and-unknown-keys (missing and malformed headers; unknown keys are covered against PostgreSQL)', async () => {
    app = await appWithProbes();
    const routes: Array<[string, string]> = [
      ['GET', '/v1/projects'],
      ['POST', '/v1/projects'],
      ['GET', '/v1/ruleset'],
      ['GET', '/v1/environments/00000000-0000-4000-8000-000000000000/flags'],
      ['PATCH', '/v1/flags/00000000-0000-4000-8000-000000000000'],
      ['DELETE', '/v1/keys/00000000-0000-4000-8000-000000000000'],
    ];
    for (const [method, url] of routes) {
      for (const authorization of [undefined, '', 'Bearer', 'Basic abc', 'sy_admin_xyz']) {
        const res = await app.inject({
          method: method as 'GET',
          url,
          headers: authorization === undefined ? {} : { authorization },
          // A malformed body must not get a 400 ahead of the 401: no key, no feedback.
          payload: method === 'GET' || method === 'DELETE' ? undefined : { nonsense: true },
        });
        expect(res.statusCode, `${method} ${url} with ${authorization}`).toBe(401);
        expect(res.json()).toEqual({ error: 'Unauthorized' });
      }
    }
  });
});

describe('error table: 400 and 422', () => {
  const segment = {
    kind: 'segment',
    clauses: [{ attribute: 'a', op: 'in', values: ['x'] }],
    serve: 'on',
  };

  it('error.400-malformed-body carries field-level details', async () => {
    app = await appWithProbes();
    const res = await app.inject({
      method: 'PUT',
      url: '/probe/rules',
      payload: { rules: [{ kind: 'segment', clauses: [], serve: '' }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('Validation failed');
    expect(body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'rules.0.clauses' })]),
    );
  });

  it('error.400-unparseable-json keeps the 400 body shape', async () => {
    app = await appWithProbes();
    const res = await app.inject({
      method: 'PUT',
      url: '/probe/rules',
      headers: { 'content-type': 'application/json' },
      payload: '{"rules": [',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Malformed request', details: [expect.any(Object)] });
  });

  it('limit.rules-per-flag answers 422 with limit and actual', async () => {
    app = await appWithProbes();
    const rules = Array.from({ length: LIMITS.rulesPerFlag + 1 }, () => segment);
    const res = await app.inject({ method: 'PUT', url: '/probe/rules', payload: { rules } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'Rules per flag exceeded', limit: 20, actual: 21 });
  });

  it('limit.rules-per-flag accepts exactly the limit', async () => {
    app = await appWithProbes();
    const rules = Array.from({ length: LIMITS.rulesPerFlag }, () => segment);
    const res = await app.inject({ method: 'PUT', url: '/probe/rules', payload: { rules } });
    expect(res.statusCode).toBe(200);
  });

  it('limit.clauses-per-segment-rule answers 422 with limit and actual', async () => {
    app = await appWithProbes();
    const clauses = Array.from(
      { length: LIMITS.clausesPerSegmentRule + 1 },
      () => segment.clauses[0],
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/probe/rules',
      payload: { rules: [segment, { ...segment, clauses }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'Clauses per segment rule exceeded',
      limit: 10,
      actual: 11,
    });
  });

  it('a size breach mixed with a malformed field is a 400: malformed wins', async () => {
    app = await appWithProbes();
    const rules = Array.from({ length: 21 }, () => segment);
    const res = await app.inject({
      method: 'PUT',
      url: '/probe/rules',
      payload: { rules, expectedUpdatedAt: 'yesterday' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('limit.request-body answers 422 above 256 KB', async () => {
    app = await appWithProbes();
    const payload = JSON.stringify({ rules: [], padding: 'x'.repeat(LIMITS.requestBodyBytes) });
    const res = await app.inject({
      method: 'PUT',
      url: '/probe/rules',
      headers: { 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: 'Request body too large',
      limit: LIMITS.requestBodyBytes,
      actual: Buffer.byteLength(payload),
    });
  });
});

describe('error table: 429', () => {
  it('error.429-rate-limited carries Retry-After, keyed per API key', async () => {
    app = await appWithProbes({ rateLimits: { admin: 2 } });
    const as = (key: string) =>
      app!.inject({ method: 'GET', url: '/probe/ok', headers: { authorization: `Bearer ${key}` } });

    expect((await as('key-one')).statusCode).toBe(200);
    expect((await as('key-one')).statusCode).toBe(200);
    const limited = await as('key-one');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'Too Many Requests' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

    // A different key behind the same IP has its own budget.
    expect((await as('key-two')).statusCode).toBe(200);
  });
});

describe('OpenAPI', () => {
  it('documents every route in SPEC.md, generated from the shared Zod contracts', async () => {
    app = await appWithProbes();
    const paths = Object.keys((app.swagger() as { paths: Record<string, unknown> }).paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/v1/projects',
        '/v1/projects/{projectId}/environments',
        '/v1/environments/{envId}/flags',
        '/v1/flags/{flagId}',
        '/v1/flags/{flagId}/rules',
        '/v1/environments/{envId}/audit',
        '/v1/environments/{envId}/keys',
        '/v1/keys/{keyId}',
        '/v1/ruleset',
      ]),
    );
  });
});
