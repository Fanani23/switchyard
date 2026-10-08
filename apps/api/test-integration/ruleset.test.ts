import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rulesetResponseSchema, type RulesetResponse } from '@switchyard/shared';
import { evaluate } from '../src/evaluation/index.js';
import type { AppInstance } from '../src/types.js';
import { uuidKeys } from '../test/helpers/keys.js';
import { call, createBooleanFlag, createWorld, testApp, type Env } from './helpers.js';

let app: AppInstance;
let env: Env;

beforeAll(async () => {
  app = await testApp();
  env = (await createWorld(app)).production;
});
afterAll(async () => {
  await app.close();
});

async function ruleset(key = env.clientKey): Promise<RulesetResponse> {
  const res = await call<RulesetResponse>(app, 'GET', '/v1/ruleset', key);
  expect(res.status).toBe(200);
  return rulesetResponseSchema.parse(res.body);
}

describe('GET /v1/ruleset', () => {
  it('returns the SPEC.md shape, with the flag salt on percentage rules', async () => {
    const created = await call<{ id: string }>(
      app,
      'POST',
      `/v1/environments/${env.id}/flags`,
      env.adminKey,
      {
        kind: 'multivariate',
        key: 'new-checkout',
        variants: [{ key: 'control' }, { key: 'treatment' }],
        default: 'control',
      },
    );
    await call(app, 'PUT', `/v1/flags/${created.body.id}/rules`, env.adminKey, {
      rules: [
        {
          kind: 'segment',
          clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
          serve: 'treatment',
        },
        { kind: 'percentage', weights: { control: 90, treatment: 10 } },
      ],
    });

    const body = await ruleset();
    expect(body.environmentId).toBe(env.id);
    const flag = body.flags.find((f) => f.key === 'new-checkout');
    expect(flag).toMatchObject({
      kind: 'multivariate',
      default: 'control',
      variants: [{ key: 'control' }, { key: 'treatment' }],
      rules: [
        {
          kind: 'segment',
          clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
          serve: 'treatment',
        },
        {
          kind: 'percentage',
          weights: { control: 90, treatment: 10 },
          salt: expect.stringMatching(/^[0-9a-f]{16}$/),
        },
      ],
    });
  });

  it('version increments on every change, and only on changes', async () => {
    const v0 = (await ruleset()).version;
    expect((await ruleset()).version).toBe(v0);

    const flag = await createBooleanFlag(app, env, 'versioned');
    const v1 = (await ruleset()).version;
    expect(v1).toBeGreaterThan(v0);

    await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, { enabled: false });
    const v2 = (await ruleset()).version;
    expect(v2).toBeGreaterThan(v1);

    await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, { rules: [] });
    const v3 = (await ruleset()).version;
    expect(v3).toBeGreaterThan(v2);

    await call(app, 'DELETE', `/v1/flags/${flag.id}`, env.adminKey);
    expect((await ruleset()).version).toBeGreaterThan(v3);
  });

  it('a disabled flag ships with no rules, so every SDK serves its default', async () => {
    const flag = await createBooleanFlag(app, env, 'kill-switch');
    await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
      rules: [{ kind: 'percentage', weights: { on: 100 } }],
    });
    const on = (await ruleset()).flags.find((f) => f.key === 'kill-switch');
    expect(evaluate(on!, { key: 'anyone' }).variant).toBe('on');

    await call(app, 'PATCH', `/v1/flags/${flag.id}`, env.adminKey, { enabled: false });
    const off = (await ruleset()).flags.find((f) => f.key === 'kill-switch');
    expect(off?.rules).toEqual([]);
    expect(evaluate(off!, { key: 'anyone' }).variant).toBe('off');
  });

  /**
   * A5 end to end: the rollout goes through the Admin API and the ruleset, as it would in
   * production. This is where a per-rule salt regenerated on every PUT would break it.
   */
  it('evaluate.rollout-is-monotonic, through the API', async () => {
    const flag = await createBooleanFlag(app, env, 'gradual');
    const users = uuidKeys(10_000, 2024);
    const servedOn = async (percent: number) => {
      await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
        rules: [{ kind: 'percentage', weights: { on: percent } }],
      });
      const compiled = (await ruleset()).flags.find((f) => f.key === 'gradual')!;
      return new Set(users.filter((key) => evaluate(compiled, { key }).variant === 'on'));
    };
    const at10 = await servedOn(10);
    const at20 = await servedOn(20);
    expect(at10.size / users.length).toBeGreaterThan(0.09);
    expect(at10.size / users.length).toBeLessThan(0.11);
    expect([...at10].filter((key) => !at20.has(key))).toEqual([]);
  });

  it('every flag gets its own salt, stable across rule replacement (A5/A6 preconditions)', async () => {
    const saltOf = async (key: string) => {
      const f = (await ruleset()).flags.find((x) => x.key === key)!;
      const rule = f.rules.find((r) => r.kind === 'percentage');
      return rule?.kind === 'percentage' ? rule.salt : null;
    };
    const salts: string[] = [];
    for (const key of ['salt-a', 'salt-b', 'salt-c']) {
      const flag = await createBooleanFlag(app, env, key);
      await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
        rules: [{ kind: 'percentage', weights: { on: 50 } }],
      });
      const first = await saltOf(key);
      await call(app, 'PUT', `/v1/flags/${flag.id}/rules`, env.adminKey, {
        rules: [{ kind: 'percentage', weights: { on: 60 } }],
      });
      expect(await saltOf(key)).toBe(first);
      salts.push(first!);
    }
    expect(new Set(salts).size).toBe(3);
  });

  it('the ruleset budget is per key and separate from the admin budget', async () => {
    const limited = await testApp({ rateLimits: { admin: 1, ruleset: 3 } });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await call(limited, 'GET', '/v1/ruleset', env.clientKey)).status).toBe(200);
      }
      const res = await call(limited, 'GET', '/v1/ruleset', env.clientKey);
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
