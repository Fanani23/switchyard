import type { FlagDto } from '@switchyard/shared';

/**
 * Share of users (0–100) served something other than the default when the flag is on, or
 * null when it depends on user attributes (a segment rule) and cannot be stated as a number.
 * For a boolean flag that is the share served `on`.
 */
export function exposure(flag: Pick<FlagDto, 'kind' | 'default' | 'rules'>): number | null {
  const base = flag.kind === 'boolean' && flag.default === 'on' ? 100 : 0;
  const first = flag.rules[0];
  if (!first) return base;
  if (first.kind === 'segment') return null;
  if (flag.rules.length > 1) {
    const total = Object.values(first.weights).reduce((s, w) => s + w, 0);
    // A first rule that covers everyone shadows the rest; anything else depends on them.
    if (total < 100) return null;
  }
  const weights = first.weights;
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  const remainder = 100 - total; // users the rule does not match get the default
  if (flag.kind === 'boolean') {
    return round((weights.on ?? 0) + (flag.default === 'on' ? remainder : 0));
  }
  const nonDefault = Object.entries(weights)
    .filter(([variant]) => variant !== flag.default)
    .reduce((s, [, w]) => s + w, 0);
  return round(nonDefault);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The flag list's rollout column: "100%", "10% on", "3 rules", "Off". */
export function rolloutSummary(
  flag: Pick<FlagDto, 'kind' | 'default' | 'rules' | 'enabled'>,
): string {
  if (!flag.enabled) return `Off · serves ${flag.default}`;
  if (flag.rules.length === 0) return `100% ${flag.default}`;
  if (flag.rules.length > 1) return `${flag.rules.length} rules`;
  const rule = flag.rules[0]!;
  if (rule.kind === 'segment') return `1 rule · ${rule.serve} for a segment`;
  const parts = Object.entries(rule.weights)
    .filter(([, w]) => w > 0)
    .map(([variant, w]) => `${w}% ${variant}`);
  return parts.length ? parts.join(', ') : `0% · serves ${flag.default}`;
}

/**
 * UX.md: friction scales with blast radius. In production, a toggle needs typed confirmation
 * when the rollout is partial, or when turning on a flag whose default rollout is 0% (it
 * starts reaching users). A rollout at 0% being turned off, or at 100% either way, is
 * immediate. Outside production, never.
 */
export function needsConfirmation(
  environmentKey: string,
  flag: Pick<FlagDto, 'kind' | 'default' | 'rules' | 'enabled'>,
): boolean {
  if (environmentKey !== 'production') return false;
  const share = exposure(flag);
  if (share === null) return true; // depends on attributes: partial by definition
  if (share === 100) return false; // "already 100%": on or off, everyone is affected alike
  if (share === 0) return !flag.enabled; // turning on from 0%; turning off a 0% flag is harmless
  return true; // partial
}

/** "3 minutes ago"; absolute time is always shown alongside, so this can be coarse. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  const units: Array<[number, string]> = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [2592000, 'month'],
  ];
  let unit = 'second';
  let value = seconds;
  for (const [size, name] of units) {
    if (seconds >= size) {
      unit = name;
      value = Math.round(seconds / size);
    }
  }
  return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/** Top-level fields that differ between an audit entry's before and after. */
export function diff(before: unknown, after: unknown): FieldChange[] {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
    (f) => f !== 'updatedAt' && f !== 'createdAt',
  );
  return fields
    .filter((f) => JSON.stringify(b[f]) !== JSON.stringify(a[f]))
    .map((field) => ({ field, before: b[field], after: a[field] }));
}
