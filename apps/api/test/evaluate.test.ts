import { describe, expect, it } from 'vitest';
import type { RulesetFlag, RulesetRule } from '@switchyard/shared';
import { bucket, bucketSlot, evaluate } from '../src/evaluation/index.js';
import { mixedKeys, salts, uuidKeys } from './helpers/keys.js';

const N = 10_000;
const KEYS = uuidKeys(N);
const [SALT_A, SALT_B, SALT_C] = salts(3) as [string, string, string];

function booleanFlag(rules: RulesetRule[], salt = SALT_A, def = 'off'): RulesetFlag {
  return {
    key: 'f',
    kind: 'boolean',
    default: def,
    variants: [{ key: 'off' }, { key: 'on' }],
    rules: rules.map((r) => (r.kind === 'percentage' ? { ...r, salt } : r)),
  };
}

/** A boolean flag with a single "on for p%" rollout rule, everyone else falling through. */
function rollout(percent: number, salt = SALT_A): RulesetFlag {
  return booleanFlag([{ kind: 'percentage', weights: { on: percent }, salt }], salt);
}

function multivariate(weights: Record<string, number>, variants: string[], salt = SALT_A): RulesetFlag {
  return {
    key: 'mv',
    kind: 'multivariate',
    default: variants[0] as string,
    variants: variants.map((key) => ({ key })),
    rules: [{ kind: 'percentage', weights, salt }],
  };
}

function usersServed(flag: RulesetFlag, variant: string, keys = KEYS): Set<string> {
  return new Set(keys.filter((key) => evaluate(flag, { key }).variant === variant));
}

describe('bucket', () => {
  it('follows SPEC.md: (murmur3_32(salt + ":" + key) % 10000) / 100', () => {
    // murmur3_32("a1b2:user-1") = 0xaa28c75b = 2854799195, independently computed with mmh3.
    expect(bucket('a1b2', 'user-1')).toBe((2854799195 % 10000) / 100);
    expect(bucketSlot('a1b2', 'user-1')).toBe(2854799195 % 10000);
  });

  it('stays within 0.00–99.99 and spreads uniformly over 100 percentiles', () => {
    const counts = new Array<number>(100).fill(0);
    for (const key of KEYS) {
      const b = bucket(SALT_A, key);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
      counts[Math.floor(b)]! += 1;
    }
    // Chi-square, 99 degrees of freedom; 148.2 is the p = 0.001 critical value.
    const expected = N / 100;
    const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(148.2);
  });
});

describe('A1 — the same user key and ruleset always yield the same variant', () => {
  it('evaluate.deterministic', () => {
    const flag = multivariate({ a: 25, b: 25, c: 50 }, ['a', 'b', 'c']);
    const first = KEYS.map((key) => evaluate(flag, { key }).variant);
    // A structurally equal but separately built ruleset (as an SDK would parse it).
    const copy = JSON.parse(JSON.stringify(flag)) as RulesetFlag;
    const second = KEYS.map((key) => evaluate(copy, { key }).variant);
    expect(second).toEqual(first);
    // Order of evaluation must not matter either: no hidden state between calls.
    const reversed = [...KEYS].reverse().map((key) => evaluate(flag, { key }).variant).reverse();
    expect(reversed).toEqual(first);
  });
});

describe('A2 — with no matching rule, the default is returned', () => {
  it('evaluate.falls-back-to-default', () => {
    const noRules = booleanFlag([], SALT_A, 'on');
    expect(evaluate(noRules, { key: 'u1' })).toEqual({ variant: 'on', reason: 'default', ruleIndex: null });

    const noMatch = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: 'on' },
      { kind: 'percentage', weights: { on: 0 }, salt: SALT_A },
    ]);
    for (const key of KEYS.slice(0, 1000)) {
      expect(evaluate(noMatch, { key, plan: 'free' })).toEqual({
        variant: 'off',
        reason: 'default',
        ruleIndex: null,
      });
    }
  });

  it('serves the default when a percentage rule covers less than 100% and the user is outside it', () => {
    const flag = rollout(10);
    const outside = KEYS.find((key) => bucket(SALT_A, key) >= 10) as string;
    expect(evaluate(flag, { key: outside }).reason).toBe('default');
  });

  it('serves the default to a context with no key when only percentage rules exist', () => {
    expect(evaluate(rollout(100), {}).variant).toBe('off');
    expect(evaluate(rollout(100), { key: '' }).variant).toBe('off');
  });
});

describe('A3 — rules apply in order and the first match wins', () => {
  it('evaluate.first-rule-wins', () => {
    const proFirst: RulesetFlag = {
      key: 'mv',
      kind: 'multivariate',
      default: 'control',
      variants: [{ key: 'control' }, { key: 'a' }, { key: 'b' }],
      rules: [
        { kind: 'segment', clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: 'a' },
        { kind: 'segment', clauses: [{ attribute: 'country', op: 'in', values: ['ID'] }], serve: 'b' },
        { kind: 'percentage', weights: { b: 100 }, salt: SALT_A },
      ],
    };
    // Matches rules 0, 1 and 2: rule 0 wins.
    expect(evaluate(proFirst, { key: 'u', plan: 'pro', country: 'ID' })).toEqual({
      variant: 'a',
      reason: 'rule_match',
      ruleIndex: 0,
    });
    // Matches rules 1 and 2: rule 1 wins.
    expect(evaluate(proFirst, { key: 'u', plan: 'free', country: 'ID' }).ruleIndex).toBe(1);

    // The same rules reversed: now the catch-all rollout shadows both segments.
    const reversed = { ...proFirst, rules: [...proFirst.rules].reverse() };
    expect(evaluate(reversed, { key: 'u', plan: 'pro', country: 'ID' })).toEqual({
      variant: 'b',
      reason: 'rule_match',
      ruleIndex: 0,
    });
  });

  it('a partial percentage rule lets users outside it fall through to later rules', () => {
    const flag = booleanFlag([
      { kind: 'percentage', weights: { on: 10 }, salt: SALT_A },
      { kind: 'segment', clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }], serve: 'on' },
    ]);
    for (const key of KEYS.slice(0, 2000)) {
      const inRollout = bucket(SALT_A, key) < 10;
      const result = evaluate(flag, { key, plan: 'pro' });
      expect(result.variant).toBe('on');
      expect(result.ruleIndex).toBe(inRollout ? 0 : 1);
    }
  });
});

describe('A4 — a 10% rollout assigns between 9% and 11% of 10,000 keys', () => {
  it('evaluate.rollout-distribution', () => {
    for (const salt of salts(20, 4)) {
      const share = usersServed(rollout(10, salt), 'on').size / N;
      expect(share).toBeGreaterThanOrEqual(0.09);
      expect(share).toBeLessThanOrEqual(0.11);
    }
  });

  it('holds for low-entropy key shapes too (emails, short database ids)', () => {
    const keys = mixedKeys(N);
    for (const salt of salts(20, 5)) {
      const share = usersServed(rollout(10, salt), 'on', keys).size / N;
      expect(share).toBeGreaterThanOrEqual(0.09);
      expect(share).toBeLessThanOrEqual(0.11);
    }
  });

  it('splits multivariate weights in proportion', () => {
    const flag = multivariate({ control: 50, a: 30, b: 20 }, ['control', 'a', 'b']);
    const counts: Record<string, number> = { control: 0, a: 0, b: 0 };
    for (const key of KEYS) counts[evaluate(flag, { key }).variant]! += 1;
    expect(counts.control! / N).toBeCloseTo(0.5, 1);
    expect(counts.a! / N).toBeCloseTo(0.3, 1);
    expect(counts.b! / N).toBeCloseTo(0.2, 1);
  });
});

describe('A5 — raising a rollout never moves a user out of it', () => {
  it('evaluate.rollout-is-monotonic', () => {
    const at10 = usersServed(rollout(10), 'on');
    const at20 = usersServed(rollout(20), 'on');
    expect(at20.size).toBeGreaterThan(at10.size);
    expect([...at10].filter((key) => !at20.has(key))).toEqual([]);
  });

  it('holds at every step from 0% to 100%, in 0.5% increments, for both key shapes', () => {
    for (const keys of [KEYS, mixedKeys(N)]) {
      let previous = new Set<string>();
      for (let p = 0; p <= 100; p += 0.5) {
        const current = usersServed(rollout(p), 'on', keys);
        const displaced = [...previous].filter((key) => !current.has(key));
        expect(displaced, `displaced at ${p}%`).toEqual([]);
        previous = current;
      }
      expect(previous.size).toBe(N);
    }
  });

  it('holds when the rollout is expressed as complete weights (off 90/on 10 -> off 80/on 20)', () => {
    const complete = (on: number): RulesetFlag =>
      booleanFlag([{ kind: 'percentage', weights: { off: 100 - on, on }, salt: SALT_A }]);
    const at10 = usersServed(complete(10), 'on');
    const at20 = usersServed(complete(20), 'on');
    expect([...at10].filter((key) => !at20.has(key))).toEqual([]);
  });

  it('holds for any variant when the weights of the variants declared before it are unchanged', () => {
    const variants = ['control', 'a', 'b'];
    const before = usersServed(multivariate({ control: 60, a: 10, b: 30 }, variants), 'a');
    const after = usersServed(multivariate({ control: 60, a: 25, b: 15 }, variants), 'a');
    expect([...before].filter((key) => !after.has(key))).toEqual([]);
  });

  it('survives replacing the rule list, because the salt belongs to the flag, not the rule', () => {
    const at10 = usersServed(rollout(10), 'on');
    const rebuilt = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'beta', op: 'in', values: ['true'] }], serve: 'on' },
      { kind: 'percentage', weights: { on: 20 }, salt: SALT_A },
    ]);
    const at20 = usersServed(rebuilt, 'on');
    expect([...at10].filter((key) => !at20.has(key))).toEqual([]);
  });

  /**
   * Documents a limit of SPEC.md's argument for A5, found while writing this test. "Raising a
   * weight only extends a range upward" is true for two variants, but with three or more,
   * raising a middle variant while also raising one declared before it shifts the middle
   * range's start upward, and users at its bottom leave. Pinned here so the behavior is a
   * known, tested property rather than a surprise; the dashboard should warn on such edits.
   */
  it('does NOT hold for a multivariate re-weight that also grows an earlier variant', () => {
    const variants = ['control', 'a', 'b'];
    const before = usersServed(multivariate({ control: 10, a: 10, b: 80 }, variants), 'a');
    const after = usersServed(multivariate({ control: 20, a: 20, b: 60 }, variants), 'a');
    // `a` doubled from 10% to 20%, yet [10, 20) moved to `control`: nobody stayed.
    const kept = [...before].filter((key) => after.has(key));
    expect(after.size).toBeGreaterThan(before.size);
    expect(kept).toHaveLength(0);
  });
});

describe('A6 — two flags at 50% do not assign the same users together', () => {
  /** 2x2 chi-square statistic for independence of two boolean assignments. */
  function independence(flagX: RulesetFlag, flagY: RulesetFlag) {
    let both = 0;
    let onlyX = 0;
    let onlyY = 0;
    let neither = 0;
    for (const key of KEYS) {
      const x = evaluate(flagX, { key }).variant === 'on';
      const y = evaluate(flagY, { key }).variant === 'on';
      if (x && y) both++;
      else if (x) onlyX++;
      else if (y) onlyY++;
      else neither++;
    }
    const rowX = both + onlyX;
    const colY = both + onlyY;
    const cells: Array<[number, number]> = [
      [both, (rowX * colY) / N],
      [onlyX, (rowX * (N - colY)) / N],
      [onlyY, ((N - rowX) * colY) / N],
      [neither, ((N - rowX) * (N - colY)) / N],
    ];
    const chi2 = cells.reduce((s, [obs, exp]) => s + (obs - exp) ** 2 / exp, 0);
    return { bothShare: both / N, chi2 };
  }

  it('evaluate.no-cross-flag-correlation', () => {
    const { bothShare, chi2 } = independence(rollout(50, SALT_A), rollout(50, SALT_B));
    // Independent 50% assignments overlap on ~25% of users; correlated ones on ~50%.
    expect(bothShare).toBeGreaterThan(0.23);
    expect(bothShare).toBeLessThan(0.27);
    // 1 degree of freedom; 10.83 is the p = 0.001 critical value.
    expect(chi2).toBeLessThan(10.83);
  });

  it('holds across many salt pairs, not one lucky pair', () => {
    const pool = salts(21, 11);
    for (let i = 0; i < 20; i++) {
      const { chi2 } = independence(rollout(50, pool[i]), rollout(50, pool[i + 1]));
      // Twenty tests at p = 0.001 each: a fixed, seeded draw either passes or always fails.
      expect(chi2).toBeLessThan(10.83);
    }
  });

  it('the test can detect correlation: two flags sharing a salt assign identically', () => {
    const { bothShare, chi2 } = independence(rollout(50, SALT_C), rollout(50, SALT_C));
    expect(bothShare).toBeGreaterThan(0.45);
    expect(chi2).toBeGreaterThan(1000);
  });
});

describe('A7 — a segment rule matches only when every clause is satisfied', () => {
  const flag = booleanFlag([
    {
      kind: 'segment',
      clauses: [
        { attribute: 'country', op: 'in', values: ['ID', 'SG'] },
        { attribute: 'plan', op: 'in', values: ['pro', 'team'] },
        { attribute: 'email', op: 'not_in', values: ['blocked@example.com'] },
      ],
      serve: 'on',
    },
  ]);

  it('evaluate.segment-all-clauses', () => {
    const all = { key: 'u', country: 'ID', plan: 'team', email: 'ok@example.com' };
    expect(evaluate(flag, all).variant).toBe('on');

    // Failing any single clause is enough to miss.
    expect(evaluate(flag, { ...all, country: 'US' }).variant).toBe('off');
    expect(evaluate(flag, { ...all, plan: 'free' }).variant).toBe('off');
    expect(evaluate(flag, { ...all, email: 'blocked@example.com' }).variant).toBe('off');
  });

  it('compares exactly: case-sensitive, no substring or prefix matching', () => {
    const all = { key: 'u', country: 'ID', plan: 'team', email: 'ok@example.com' };
    expect(evaluate(flag, { ...all, country: 'id' }).variant).toBe('off');
    expect(evaluate(flag, { ...all, plan: 'pro ' }).variant).toBe('off');
    expect(evaluate(flag, { ...all, plan: 'pr' }).variant).toBe('off');
  });

  it('compares numbers and booleans by their string form', () => {
    const numeric = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'age', op: 'in', values: ['30'] }], serve: 'on' },
      { kind: 'segment', clauses: [{ attribute: 'beta', op: 'in', values: ['true'] }], serve: 'on' },
    ]);
    expect(evaluate(numeric, { key: 'u', age: 30 }).variant).toBe('on');
    expect(evaluate(numeric, { key: 'u', beta: true }).variant).toBe('on');
    expect(evaluate(numeric, { key: 'u', beta: false }).variant).toBe('off');
  });

  it('can match on the user key itself', () => {
    const allowList = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'key', op: 'in', values: ['alice'] }], serve: 'on' },
    ]);
    expect(evaluate(allowList, { key: 'alice' }).variant).toBe('on');
    expect(evaluate(allowList, { key: 'bob' }).variant).toBe('off');
  });
});

describe('A8 — an unknown user attribute never matches and never throws', () => {
  it('evaluate.unknown-attribute', () => {
    const flag = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'country', op: 'in', values: ['ID'] }], serve: 'on' },
    ]);
    expect(evaluate(flag, { key: 'u' })).toEqual({ variant: 'off', reason: 'default', ruleIndex: null });
    expect(evaluate(flag, { key: 'u', country: undefined }).variant).toBe('off');
    expect(evaluate(flag, { key: 'u', country: null }).variant).toBe('off');
  });

  it('not_in does not match an absent attribute: unknown is not "not ID"', () => {
    const flag = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'country', op: 'not_in', values: ['ID'] }], serve: 'on' },
    ]);
    expect(evaluate(flag, { key: 'u' }).variant).toBe('off');
    expect(evaluate(flag, { key: 'u', country: 'US' }).variant).toBe('on');
  });

  it('never resolves attributes through the prototype chain', () => {
    for (const attribute of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      for (const op of ['in', 'not_in'] as const) {
        const flag = booleanFlag([
          { kind: 'segment', clauses: [{ attribute, op, values: ['x'] }], serve: 'on' },
        ]);
        expect(evaluate(flag, { key: 'u' }).variant).toBe('off');
      }
    }
  });

  it('non-scalar attribute values (objects, arrays, functions) never match and never throw', () => {
    const flag = booleanFlag([
      { kind: 'segment', clauses: [{ attribute: 'plan', op: 'not_in', values: ['free'] }], serve: 'on' },
    ]);
    const weird: unknown[] = [{}, ['pro'], () => 'pro', Symbol('pro'), 10n, NaN];
    for (const plan of weird) {
      expect(() => evaluate(flag, { key: 'u', plan })).not.toThrow();
    }
    expect(evaluate(flag, { key: 'u', plan: ['pro'] }).variant).toBe('off');
    expect(evaluate(flag, { key: 'u', plan: {} }).variant).toBe('off');
  });
});

describe('the public function never throws', () => {
  const good = rollout(50);

  it('returns the default, with reason "error", for malformed rulesets', () => {
    const malformed: unknown[] = [
      { ...good, rules: [null] },
      { ...good, rules: [{ kind: 'percentage', weights: null, salt: SALT_A }] },
      { ...good, rules: [{ kind: 'percentage', weights: { on: 'ten' }, salt: SALT_A }] },
      { ...good, rules: [{ kind: 'percentage', weights: { on: 60, off: 60 }, salt: SALT_A }] },
      { ...good, rules: [{ kind: 'percentage', weights: { ghost: 10 }, salt: SALT_A }] },
      { ...good, rules: [{ kind: 'percentage', weights: { on: 10 } }] },
      { ...good, rules: [{ kind: 'segment', clauses: 'nope', serve: 'on' }] },
      { ...good, rules: 'nope' },
      { ...good, variants: null },
    ];
    for (const flag of malformed) {
      const result = evaluate(flag as RulesetFlag, { key: KEYS[0] });
      expect(result).toEqual({ variant: 'off', reason: 'error', ruleIndex: null });
    }
  });

  it('returns the caller fallback when the flag has no usable default', () => {
    for (const flag of [null, undefined, 42, 'flag', { rules: [] }]) {
      expect(evaluate(flag as unknown as RulesetFlag, { key: 'u' }, 'safe')).toEqual({
        variant: 'safe',
        reason: 'error',
        ruleIndex: null,
      });
    }
  });

  it('tolerates any context, including non-objects and non-string keys', () => {
    for (const ctx of [null, undefined, 1, 'u', [], { key: 42 }, { key: {} }]) {
      expect(() => evaluate(good, ctx as never)).not.toThrow();
      expect(evaluate(good, ctx as never).variant).toBe('off');
    }
  });

  it('skips a rule kind it does not know, instead of failing the flag', () => {
    const future = {
      ...good,
      rules: [{ kind: 'schedule', at: 'tomorrow' }, { kind: 'percentage', weights: { on: 100 }, salt: SALT_A }],
    } as unknown as RulesetFlag;
    expect(evaluate(future, { key: 'u' })).toEqual({ variant: 'on', reason: 'rule_match', ruleIndex: 1 });
  });

  it('assigns by declared variant order, not by the order of keys in the weights object', () => {
    // Integer-like keys are enumerated first by JavaScript, whatever order they were written in.
    const flag = multivariate({ '2': 50, '1': 50 }, ['2', '1']);
    const low = KEYS.find((key) => bucket(SALT_A, key) < 50) as string;
    expect(Object.keys(flag.rules[0]!.kind === 'percentage' ? flag.rules[0]!.weights : {})).toEqual(['1', '2']);
    expect(evaluate(flag, { key: low }).variant).toBe('2');
  });
});
