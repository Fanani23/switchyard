import { describe, expect, it } from 'vitest';
import type { FlagDto, Rule } from '@switchyard/shared';
import { diff, exposure, needsConfirmation, relativeTime, rolloutSummary } from './flags';

type F = Pick<FlagDto, 'kind' | 'default' | 'rules' | 'enabled'>;
const bool = (rules: Rule[], over: Partial<F> = {}): F => ({
  kind: 'boolean',
  default: 'off',
  rules,
  enabled: true,
  ...over,
});
const pct = (weights: Record<string, number>): Rule => ({ kind: 'percentage', weights });
const seg: Rule = {
  kind: 'segment',
  clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
  serve: 'on',
};

describe('exposure', () => {
  it('is the share served "on" for boolean flags', () => {
    expect(exposure(bool([]))).toBe(0);
    expect(exposure(bool([], { default: 'on' }))).toBe(100);
    expect(exposure(bool([pct({ on: 10 })]))).toBe(10);
    expect(exposure(bool([pct({ on: 10, off: 90 })]))).toBe(10);
    // Users outside a partial rule fall through to the default.
    expect(exposure(bool([pct({ off: 30 })], { default: 'on' }))).toBe(70);
  });

  it('is unknown (null) when a segment decides', () => {
    expect(exposure(bool([seg]))).toBeNull();
    expect(exposure(bool([pct({ on: 10 }), seg]))).toBeNull();
  });

  it('is the non-default share for multivariate flags', () => {
    expect(
      exposure({
        kind: 'multivariate',
        default: 'control',
        rules: [pct({ control: 80, treatment: 20 })],
      }),
    ).toBe(20);
  });
});

describe('needsConfirmation (UX.md: friction scales with blast radius)', () => {
  it('never outside production', () => {
    for (const flag of [bool([pct({ on: 10 })]), bool([seg]), bool([])]) {
      expect(needsConfirmation('staging', flag)).toBe(false);
    }
  });

  it('production, 0% or already 100%: immediate', () => {
    expect(needsConfirmation('production', bool([], { enabled: true }))).toBe(false); // 0%, turning off
    expect(needsConfirmation('production', bool([pct({ on: 100 })]))).toBe(false);
    expect(needsConfirmation('production', bool([pct({ on: 100 })], { enabled: false }))).toBe(
      false,
    );
  });

  it('production, partial or turning on from 0%: typed confirmation', () => {
    expect(needsConfirmation('production', bool([pct({ on: 10 })]))).toBe(true);
    expect(needsConfirmation('production', bool([seg]))).toBe(true);
    expect(needsConfirmation('production', bool([], { enabled: false }))).toBe(true);
  });
});

describe('rolloutSummary', () => {
  it('reads like the flag list asks for', () => {
    expect(rolloutSummary(bool([], { default: 'on' }))).toBe('100% on');
    expect(rolloutSummary(bool([pct({ on: 10 })]))).toBe('10% on');
    expect(rolloutSummary(bool([seg, pct({ on: 10 }), seg]))).toBe('3 rules');
    expect(rolloutSummary(bool([pct({ on: 10 })], { enabled: false }))).toBe('Off · serves off');
  });
});

describe('diff', () => {
  it('lists changed fields, ignoring timestamps', () => {
    expect(
      diff(
        { enabled: true, updatedAt: 'a', key: 'k' },
        { enabled: false, updatedAt: 'b', key: 'k' },
      ),
    ).toEqual([{ field: 'enabled', before: true, after: false }]);
    expect(diff(null, { key: 'k' })).toEqual([{ field: 'key', before: undefined, after: 'k' }]);
  });
});

describe('relativeTime', () => {
  it('is coarse and readable', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(relativeTime('2026-10-09T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-09T11:57:00Z', now)).toBe('3 minutes ago');
    expect(relativeTime('2026-10-09T11:00:00Z', now)).toBe('1 hour ago');
    expect(relativeTime('2026-10-07T12:00:00Z', now)).toBe('2 days ago');
  });
});
