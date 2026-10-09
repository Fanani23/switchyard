'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { EnvironmentDto, FlagDto, Rule } from '@switchyard/shared';
import { ApiError, isAbort } from '@/lib/api';
import { needsConfirmation, rolloutSummary } from '@/lib/flags';
import { useSession } from '@/lib/session';
import { useLiveRuleset } from '@/lib/use-live-ruleset';
import { ConfirmDialog, ErrorState, Switch, useToast } from './ui';

interface DraftRule {
  /** Client-side identity, so React keeps focus on a card as it moves. */
  uid: number;
  rule: Rule;
}

let nextUid = 1;
const wrap = (rules: Rule[]): DraftRule[] => rules.map((rule) => ({ uid: nextUid++, rule }));
const same = (a: Rule[], b: Rule[]) => JSON.stringify(a) === JSON.stringify(b);

/** UX.md view 2. States: loading, empty, error, success, saving, conflict. */
export function FlagDetail({
  flagId,
  environment,
}: {
  flagId: string;
  environment: EnvironmentDto | null;
}) {
  const { api, apiKey } = useSession();
  const toast = useToast();
  const router = useRouter();
  const [saved, setSaved] = useState<FlagDto | null>(null);
  const [draft, setDraft] = useState<DraftRule[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<FlagDto | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'toggle' | null>(null);
  const cards = useRef(new Map<number, HTMLElement>());
  const focusAfterMove = useRef<number | null>(null);

  const dirty =
    saved !== null &&
    !same(
      draft.map((d) => d.rule),
      saved.rules,
    );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      try {
        const flag = await api.getFlag(flagId, signal);
        setSaved(flag);
        setDraft(wrap(flag.rules));
        setLoadError(null);
      } catch (err) {
        if (!isAbort(err)) setLoadError('Could not load this flag');
      }
    },
    [api, flagId],
  );

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  // Someone else changed the ruleset. If this flag changed and the user has unsaved edits,
  // it enters the conflict state rather than updating underneath them (UX.md).
  useLiveRuleset(apiKey, saved?.environmentId ?? null, () => {
    if (!api) return;
    void api
      .getFlag(flagId)
      .then((fresh) => {
        const current = savedRef.current;
        if (!current || fresh.updatedAt === current.updatedAt) return;
        if (dirtyRef.current) setConflict(fresh);
        else {
          setSaved(fresh);
          setDraft(wrap(fresh.rules));
        }
      })
      .catch(() => {});
  });

  useEffect(() => {
    if (focusAfterMove.current !== null) {
      cards.current.get(focusAfterMove.current)?.focus();
      focusAfterMove.current = null;
    }
  });

  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!saved) {
    return (
      <div aria-hidden="true">
        <div className="skeleton-bar wide" />
        <div className="card skeleton" />
      </div>
    );
  }

  const variants = saved.variants.map((v) => v.key);

  const save = async (expectedUpdatedAt: string) => {
    if (!api) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.putRules(
        saved.id,
        draft.map((d) => d.rule),
        expectedUpdatedAt,
      );
      setSaved(updated);
      setDraft(wrap(updated.rules));
      setConflict(null);
      toast({ tone: 'info', message: `Rules saved for ${saved.key}` });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body?.current) {
        setConflict(err.body.current);
      } else if (err instanceof ApiError) {
        setSaveError(
          [err.message, ...(err.body?.details ?? []).map((d) => `${d.path}: ${d.message}`)].join(
            ' — ',
          ),
        );
      } else {
        setSaveError('Could not save. Your edits are still here.');
      }
    } finally {
      setSaving(false);
    }
  };

  const toggle = async () => {
    if (!api) return;
    const previous = saved;
    setSaved({ ...saved, enabled: !saved.enabled });
    try {
      const updated = await api.patchFlag(saved.id, { enabled: !previous.enabled });
      setSaved((s) => (s ? { ...updated, rules: s.rules } : updated));
      toast({ tone: 'info', message: `${saved.key} ${updated.enabled ? 'enabled' : 'disabled'}` });
    } catch {
      setSaved(previous);
      toast({ tone: 'error', message: `Could not change ${saved.key}` });
    }
  };

  const setDefault = async (value: string) => {
    if (!api) return;
    try {
      const updated = await api.patchFlag(saved.id, { default: value });
      setSaved((s) => (s ? { ...updated, rules: s.rules } : updated));
    } catch {
      toast({ tone: 'error', message: `Could not change the default of ${saved.key}` });
    }
  };

  const remove = async () => {
    if (!api) return;
    try {
      await api.deleteFlag(saved.id);
      toast({ tone: 'info', message: `${saved.key} deleted` });
      router.back();
    } catch {
      toast({ tone: 'error', message: `Could not delete ${saved.key}` });
    }
  };

  const update = (uid: number, rule: Rule) =>
    setDraft((d) => d.map((r) => (r.uid === uid ? { uid, rule } : r)));
  const move = (uid: number, by: -1 | 1) =>
    setDraft((d) => {
      const i = d.findIndex((r) => r.uid === uid);
      const j = i + by;
      if (i < 0 || j < 0 || j >= d.length) return d;
      const copy = [...d];
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      focusAfterMove.current = uid;
      return copy;
    });
  const onCardKey = (uid: number) => (e: KeyboardEvent) => {
    if (!e.ctrlKey || e.target !== e.currentTarget) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(uid, -1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(uid, 1);
    }
  };

  const toggleNeedsConfirm = environment !== null && needsConfirmation(environment.key, saved);
  const invalid = draft.some(
    (d) =>
      d.rule.kind === 'percentage' &&
      Object.values(d.rule.weights).reduce((s, w) => s + w, 0) > 100,
  );

  return (
    <section>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Projects</Link>
        {environment && <> / {environment.name}</>} / <strong>{saved.key}</strong>
      </nav>
      <div className="detail-header">
        <h1>{saved.key}</h1>
        <Switch
          checked={saved.enabled}
          label={saved.key}
          onChange={() => (toggleNeedsConfirm ? setConfirm('toggle') : void toggle())}
        />
      </div>
      <p className="muted">
        {saved.kind === 'boolean' ? 'On / off' : `Variants: ${variants.join(', ')}`} ·{' '}
        {rolloutSummary(saved)}
      </p>
      <label htmlFor="default-variant">Default (served when no rule matches, or when off)</label>
      <select
        id="default-variant"
        value={saved.default}
        onChange={(e) => void setDefault(e.target.value)}
      >
        {variants.map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>

      {conflict && (
        <div className="banner conflict" role="alert">
          <p>
            <strong>Someone else changed this flag while you were editing.</strong>
          </p>
          <ul>
            <li>
              Theirs: {conflict.rules.length} rule(s), {rolloutSummary(conflict)}
            </li>
            <li>
              Yours: {draft.length} rule(s),{' '}
              {rolloutSummary({ ...saved, rules: draft.map((d) => d.rule) })}
            </li>
          </ul>
          <div className="actions">
            <button
              type="button"
              onClick={() => {
                setSaved(conflict);
                setDraft(wrap(conflict.rules));
                setConflict(null);
              }}
            >
              Reload theirs
            </button>
            <button type="button" className="danger" onClick={() => void save(conflict.updatedAt)}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}

      <h2>Rules</h2>
      <p className="muted">
        Evaluated top to bottom; the first match wins. Ctrl+↑/↓ moves a focused rule.
      </p>

      {draft.length === 0 ? (
        <div className="state">
          <p>
            No rules. Every user gets <strong>{saved.default}</strong>.
          </p>
        </div>
      ) : (
        <ol className={`rules ${saving ? 'saving' : ''}`}>
          {draft.map((d, i) => (
            <li
              key={d.uid}
              className="card rule"
              tabIndex={0}
              aria-label={`Rule ${i + 1}: ${d.rule.kind}`}
              ref={(el) => {
                if (el) cards.current.set(d.uid, el);
                else cards.current.delete(d.uid);
              }}
              onKeyDown={onCardKey(d.uid)}
            >
              <div className="rule-head">
                <strong>
                  {i + 1}. {d.rule.kind === 'segment' ? 'Segment' : 'Percentage'}
                </strong>
                <span className="actions">
                  <button
                    type="button"
                    onClick={() => move(d.uid, -1)}
                    disabled={i === 0}
                    aria-label={`Move rule ${i + 1} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(d.uid, 1)}
                    disabled={i === draft.length - 1}
                    aria-label={`Move rule ${i + 1} down`}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraft((all) => all.filter((r) => r.uid !== d.uid))}
                    aria-label={`Remove rule ${i + 1}`}
                  >
                    Remove
                  </button>
                </span>
              </div>
              {d.rule.kind === 'segment' ? (
                <SegmentEditor
                  rule={d.rule}
                  variants={variants}
                  onChange={(r) => update(d.uid, r)}
                  n={i + 1}
                />
              ) : (
                <PercentageEditor
                  rule={d.rule}
                  variants={variants}
                  defaultVariant={saved.default}
                  onChange={(r) => update(d.uid, r)}
                  n={i + 1}
                />
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="actions">
        <button
          type="button"
          onClick={() =>
            setDraft((d) => [
              ...d,
              ...wrap([
                {
                  kind: 'segment',
                  clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
                  serve: variants.find((v) => v !== saved.default) ?? variants[0]!,
                },
              ]),
            ])
          }
          disabled={draft.length >= 20}
        >
          Add segment rule
        </button>
        <button
          type="button"
          onClick={() =>
            setDraft((d) => [
              ...d,
              ...wrap([
                {
                  kind: 'percentage',
                  weights: { [variants.find((v) => v !== saved.default) ?? variants[0]!]: 10 },
                },
              ]),
            ])
          }
          disabled={draft.length >= 20}
        >
          Add percentage rule
        </button>
      </div>

      {saveError && (
        <p className="error-text" role="alert">
          {saveError}
        </p>
      )}

      <div className="actions sticky">
        <button
          type="button"
          onClick={() => setDraft(wrap(saved.rules))}
          disabled={!dirty || saving}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void save(saved.updatedAt)}
          disabled={!dirty || saving || invalid || conflict !== null}
          aria-busy={saving}
        >
          {saving ? 'Saving…' : 'Save rules'}
        </button>
        <button type="button" className="danger" onClick={() => setConfirm('delete')}>
          Delete flag
        </button>
      </div>

      {confirm === 'delete' && (
        <ConfirmDialog
          title={`Delete ${saved.key}?`}
          description={
            <p>Every SDK falls back to its own default for this flag. This cannot be undone.</p>
          }
          confirmText={saved.key}
          actionLabel="Delete"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void remove();
          }}
        />
      )}
      {confirm === 'toggle' && (
        <ConfirmDialog
          title={`${saved.enabled ? 'Disable' : 'Enable'} ${saved.key} in production?`}
          description={<p>This changes what live users get, now: {rolloutSummary(saved)}.</p>}
          confirmText={saved.key}
          actionLabel={saved.enabled ? 'Disable' : 'Enable'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void toggle();
          }}
        />
      )}
    </section>
  );
}

function SegmentEditor(props: {
  rule: Extract<Rule, { kind: 'segment' }>;
  variants: string[];
  onChange: (rule: Rule) => void;
  n: number;
}) {
  const { rule } = props;
  const setClause = (i: number, patch: Partial<(typeof rule.clauses)[number]>) =>
    props.onChange({
      ...rule,
      clauses: rule.clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  return (
    <div className="editor">
      {rule.clauses.map((clause, i) => (
        <fieldset key={i} className="clause">
          <legend>Condition {i + 1}</legend>
          <label>
            Attribute
            <input
              value={clause.attribute}
              onChange={(e) => setClause(i, { attribute: e.target.value })}
            />
          </label>
          <label>
            Operator
            <select
              value={clause.op}
              onChange={(e) => setClause(i, { op: e.target.value === 'not_in' ? 'not_in' : 'in' })}
            >
              <option value="in">is one of</option>
              <option value="not_in">is not one of</option>
            </select>
          </label>
          <label>
            Values (comma-separated)
            <input
              value={clause.values.join(', ')}
              onChange={(e) =>
                setClause(i, {
                  values: e.target.value
                    .split(',')
                    .map((v) => v.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          {rule.clauses.length > 1 && (
            <button
              type="button"
              onClick={() =>
                props.onChange({ ...rule, clauses: rule.clauses.filter((_, j) => j !== i) })
              }
            >
              Remove condition
            </button>
          )}
        </fieldset>
      ))}
      <button
        type="button"
        disabled={rule.clauses.length >= 10}
        onClick={() =>
          props.onChange({
            ...rule,
            clauses: [...rule.clauses, { attribute: '', op: 'in', values: [] }],
          })
        }
      >
        Add condition
      </button>
      <label>
        Serve
        <select
          value={rule.serve}
          onChange={(e) => props.onChange({ ...rule, serve: e.target.value })}
        >
          {props.variants.map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * Sliders update local state continuously; nothing is sent until Save, so dragging never
 * fires a write per pixel.
 */
function PercentageEditor(props: {
  rule: Extract<Rule, { kind: 'percentage' }>;
  variants: string[];
  defaultVariant: string;
  onChange: (rule: Rule) => void;
  n: number;
}) {
  const { rule } = props;
  const total = Object.values(rule.weights).reduce((s, w) => s + w, 0);
  const set = (variant: string, value: number) =>
    props.onChange({
      ...rule,
      weights: { ...rule.weights, [variant]: Math.max(0, Math.min(100, value)) },
    });
  return (
    <div className="editor">
      {props.variants.map((variant) => {
        const id = `w-${props.n}-${variant}`;
        const value = rule.weights[variant] ?? 0;
        return (
          <div key={variant} className="weight">
            <label htmlFor={id}>{variant}</label>
            <input
              id={id}
              type="range"
              min={0}
              max={100}
              step={1}
              value={value}
              onChange={(e) => set(variant, Number(e.target.value))}
            />
            <input
              type="number"
              aria-label={`${variant} percent`}
              min={0}
              max={100}
              step={0.01}
              value={value}
              onChange={(e) => set(variant, Number(e.target.value))}
            />
            <span>%</span>
          </div>
        );
      })}
      <p className={total > 100 ? 'error-text' : 'muted'} role={total > 100 ? 'alert' : undefined}>
        {total > 100
          ? `Weights add up to ${total}%, more than 100%.`
          : total < 100
            ? `${(100 - total).toFixed(2).replace(/\.00$/, '')}% of users fall through to the next rule (or ${props.defaultVariant}).`
            : 'Covers every user.'}
      </p>
    </div>
  );
}
