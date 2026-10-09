import { describe, expect, it } from 'vitest';
import { evaluate } from '@switchyard/engine';
import type { RulesetFlag, RulesetResponse } from '@switchyard/shared';
import { Switchyard } from '../src/index.js';
import { fakeServer } from './fake-server.js';

/**
 * SPEC.md F2. Measured through the SDK's public `variant()`, the call an application makes,
 * so the flag lookup and the never-throw guard are inside the timing, not just the engine.
 * The workload mixes what a ruleset holds: segment rules on two attributes, percentage
 * rollouts that hash every user, and flags whose rules all miss.
 */
const CHECKS = 1_000_000;

function flag(i: number): RulesetFlag {
  return {
    key: `flag-${i}`,
    kind: 'boolean',
    default: 'off',
    variants: [{ key: 'off' }, { key: 'on' }],
    rules: [
      {
        kind: 'segment',
        clauses: [
          { attribute: 'plan', op: 'in', values: ['pro', 'team'] },
          { attribute: 'country', op: 'in', values: ['ID', 'SG', 'MY'] },
        ],
        serve: 'on',
      },
      { kind: 'percentage', weights: { on: 10 + (i % 80) }, salt: `salt-${i}-0123456789` },
    ],
  };
}

const FLAGS = Array.from({ length: 50 }, (_, i) => flag(i));
const RULESET: RulesetResponse = {
  environmentId: '3acde8a7-6381-4a82-b8a7-4ccc9392b8a1',
  version: 1,
  flags: FLAGS,
};
const PLANS = ['free', 'pro', 'team', 'enterprise'];
const COUNTRIES = ['ID', 'SG', 'US', 'DE', 'MY'];
const USERS = Array.from({ length: 10_000 }, (_, i) => ({
  key: `user-${i.toString(36)}-${(i * 2654435761) >>> 0}`,
  plan: PLANS[i % PLANS.length],
  country: COUNTRIES[i % COUNTRIES.length],
}));

/** Best of three timed runs after a warm-up, so the number is steady-state, not JIT warm-up. */
function time(run: () => number): { ms: number; checksum: number } {
  run();
  let best = Infinity;
  let checksum = 0;
  for (let r = 0; r < 3; r++) {
    const start = performance.now();
    checksum = run();
    best = Math.min(best, performance.now() - start);
  }
  return { ms: best, checksum };
}

describe('F2 — in-process evaluation of 1,000,000 flag checks completes under 1 second', () => {
  it('bench.evaluation-throughput', { timeout: 60_000 }, async () => {
    const server = fakeServer((conn) => conn.sendRuleset(RULESET));
    const client = new Switchyard({ apiKey: 'k', fetch: server.fetch });
    await client.ready();
    expect(client.rulesetVersion).toBe(1);

    const sdk = time(() => {
      let on = 0;
      for (let i = 0; i < CHECKS; i++) {
        if (client.variant(`flag-${i % 50}`, USERS[i % USERS.length]) === 'on') on++;
      }
      return on;
    });
    const engine = time(() => {
      let on = 0;
      for (let i = 0; i < CHECKS; i++) {
        if (evaluate(FLAGS[i % 50]!, USERS[i % USERS.length]!).variant === 'on') on++;
      }
      return on;
    });
    client.close();

    console.info(
      `F2 1,000,000 checks: SDK variant() ${sdk.ms.toFixed(0)} ms ` +
        `(${(((CHECKS / sdk.ms) * 1000) / 1e6).toFixed(1)} M/s), engine ${engine.ms.toFixed(0)} ms; ` +
        `${sdk.checksum} served "on"`,
    );
    // The same answers both ways, and a plausible share served "on".
    expect(sdk.checksum).toBe(engine.checksum);
    expect(sdk.checksum).toBeGreaterThan(CHECKS * 0.2);
    expect(sdk.ms).toBeLessThan(1000);
  });
});
