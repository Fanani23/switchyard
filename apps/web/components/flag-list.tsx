'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentDto, FlagDto } from '@switchyard/shared';
import { ApiError, isAbort } from '@/lib/api';
import { needsConfirmation, relativeTime, rolloutSummary } from '@/lib/flags';
import { useSession } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { useLiveRuleset } from '@/lib/use-live-ruleset';
import { CreateFlagDialog } from './create-flag';
import { ConfirmDialog, SkeletonRows, Switch, useToast } from './ui';

const PAGE = 50;

interface ListState {
  rows: FlagDto[];
  total: number;
  nextCursor: string | null;
  /** First page in flight with nothing to show yet. */
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

/**
 * UX.md view 1. States: loading (6 skeleton rows), empty, empty (filtered), partial (Load
 * more with the count remaining), error (rows kept, Retry), success.
 */
export function FlagList({ environment }: { environment: EnvironmentDto }) {
  const { api, apiKey } = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const query = useDebounced(filter.trim(), 300);
  const [list, setList] = useState<ListState>({
    rows: [],
    total: 0,
    nextCursor: null,
    loading: true,
    loadingMore: false,
    error: null,
  });
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<{ flag: FlagDto; next: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const rowsRef = useRef<FlagDto[]>([]);
  rowsRef.current = list.rows;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  /**
   * Loads the first page for the current filter. A newer call aborts the older one, so a
   * slow response for "a" can never land after a fast one for "abc" (UX.md).
   */
  const reload = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!api) return;
      inflight.current?.abort();
      const abort = new AbortController();
      inflight.current = abort;
      if (!opts.silent) setList((s) => ({ ...s, loading: s.rows.length === 0, error: null }));
      try {
        const page = await api.listFlags(environment.id, { q: query, limit: PAGE }, abort.signal);
        const before = new Map(rowsRef.current.map((f) => [f.id, f.updatedAt]));
        if (opts.silent) {
          // Live update: highlight what someone else changed (UX.md, 1.5 s).
          const changed = page.items.filter(
            (f) => before.has(f.id) && before.get(f.id) !== f.updatedAt,
          );
          if (changed.length) flash(changed.map((f) => f.id));
        }
        setList((s) => ({
          ...s,
          // A row with a toggle in flight never updates underneath the user.
          rows: page.items.map((f) =>
            pendingRef.current.has(f.id) ? (s.rows.find((r) => r.id === f.id) ?? f) : f,
          ),
          total: page.total,
          nextCursor: page.nextCursor,
          loading: false,
          error: null,
        }));
      } catch (err) {
        if (isAbort(err)) return;
        // Previously loaded rows stay visible; the error is shown above them.
        setList((s) => ({ ...s, loading: false, error: 'Could not load flags' }));
      }
    },
    [api, environment.id, query],
  );
  useEffect(() => {
    void reload();
    return () => inflight.current?.abort();
  }, [reload]);

  const flash = (ids: string[]) => {
    setHighlighted(new Set(ids));
    setTimeout(() => setHighlighted(new Set()), 1500);
  };

  const live = useLiveRuleset(apiKey, environment.id, () => void reload({ silent: true }));

  const loadMore = async () => {
    if (!api || !list.nextCursor) return;
    setList((s) => ({ ...s, loadingMore: true }));
    try {
      const page = await api.listFlags(environment.id, {
        q: query,
        cursor: list.nextCursor,
        limit: PAGE,
      });
      setList((s) => ({
        ...s,
        rows: [...s.rows, ...page.items],
        total: page.total,
        nextCursor: page.nextCursor,
        loadingMore: false,
      }));
    } catch {
      setList((s) => ({ ...s, loadingMore: false, error: 'Could not load more flags' }));
    }
  };

  const replaceRow = (flag: FlagDto) =>
    setList((s) => ({ ...s, rows: s.rows.map((r) => (r.id === flag.id ? flag : r)) }));

  /**
   * Optimistic: the switch moves at once. On failure the captured previous row is restored
   * (not re-fetched, which could resurrect a value nobody chose), the row flashes red, and a
   * toast names the flag. Undo issues the inverse request; it never just edits local state.
   */
  const setEnabled = async (flag: FlagDto, next: boolean, isUndo = false) => {
    if (!api) return;
    const previous = flag;
    replaceRow({ ...flag, enabled: next });
    setPending((p) => new Set(p).add(flag.id));
    try {
      const saved = await api.patchFlag(flag.id, { enabled: next });
      replaceRow(saved);
      if (!isUndo) {
        toast({
          tone: 'info',
          message: `${flag.key} ${next ? 'enabled' : 'disabled'}`,
          action: { label: 'Undo', run: () => void setEnabled(saved, !next, true) },
        });
      } else {
        toast({ tone: 'info', message: `${flag.key} ${next ? 'enabled' : 'disabled'} again` });
      }
    } catch (err) {
      replaceRow(previous);
      setFailed(flag.id);
      setTimeout(() => setFailed(null), 1200);
      toast({
        tone: 'error',
        message: `Could not ${next ? 'enable' : 'disable'} ${flag.key}${err instanceof ApiError ? `: ${err.message}` : ''}`,
      });
    } finally {
      setPending((p) => {
        const copy = new Set(p);
        copy.delete(flag.id);
        return copy;
      });
    }
  };

  const onToggle = (flag: FlagDto, next: boolean) => {
    if (needsConfirmation(environment.key, flag)) setConfirming({ flag, next });
    else void setEnabled(flag, next);
  };

  const remaining = list.total - list.rows.length;
  const isFiltered = query.length > 0;

  return (
    <section>
      {live === 'reconnecting' && (
        <div className="banner" role="status">
          Reconnecting… changes made elsewhere will appear when the connection is back.
        </div>
      )}

      <div className="toolbar">
        <div className="filter">
          <label htmlFor="flag-filter">Filter flags</label>
          <input
            id="flag-filter"
            type="search"
            placeholder="Flag key"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <button type="button" className="primary" onClick={() => setCreating(true)}>
          Create flag
        </button>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {list.loading ? 'Loading flags' : `${list.total} flag${list.total === 1 ? '' : 's'}`}
      </p>

      {list.error && (
        <div className="state error" role="alert">
          <p>{list.error}</p>
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}

      {list.loading && list.rows.length === 0 && !list.error && <SkeletonRows count={6} />}

      {!list.loading && !list.error && list.rows.length === 0 && !isFiltered && (
        <div className="state">
          <p>
            <strong>No flags yet.</strong> A flag turns a feature on for a chosen slice of users
            without a deploy.
          </p>
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Create flag
          </button>
        </div>
      )}

      {!list.loading && !list.error && list.rows.length === 0 && isFiltered && (
        <div className="state">
          <p>
            No flags match <em>{query}</em>
          </p>
          <button type="button" onClick={() => setFilter('')}>
            Clear filter
          </button>
        </div>
      )}

      {list.rows.length > 0 && (
        <ul className="rows" aria-label="Flags">
          {list.rows.map((flag) => (
            <li
              key={flag.id}
              className={[
                'row',
                'flag-row',
                highlighted.has(flag.id) ? 'highlight' : '',
                failed === flag.id ? 'failed' : '',
              ].join(' ')}
            >
              <div className="row-main">
                <Link href={`/flags/${flag.id}`} className="flag-key">
                  {flag.key}
                </Link>
                <span className="row-meta">
                  <span className={`pill ${flag.enabled ? 'pill-on' : 'pill-off'}`}>
                    {rolloutSummary(flag)}
                  </span>{' '}
                  <time dateTime={flag.updatedAt} title={new Date(flag.updatedAt).toLocaleString()}>
                    {relativeTime(flag.updatedAt)}
                  </time>
                  {flag.lastChangedBy && <span className="muted"> by {flag.lastChangedBy}</span>}
                </span>
              </div>
              <Switch
                checked={flag.enabled}
                label={flag.key}
                disabled={pending.has(flag.id)}
                onChange={(next) => onToggle(flag, next)}
              />
            </li>
          ))}
        </ul>
      )}

      {list.nextCursor && remaining > 0 && (
        <button type="button" onClick={() => void loadMore()} disabled={list.loadingMore}>
          {list.loadingMore ? 'Loading…' : `Load more (${remaining} remaining)`}
        </button>
      )}

      {confirming && (
        <ConfirmDialog
          title={`${confirming.next ? 'Enable' : 'Disable'} ${confirming.flag.key} in production?`}
          description={
            <p>This changes what live users get, now: {rolloutSummary(confirming.flag)}.</p>
          }
          confirmText={confirming.flag.key}
          actionLabel={confirming.next ? 'Enable' : 'Disable'}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const { flag, next } = confirming;
            setConfirming(null);
            void setEnabled(flag, next);
          }}
        />
      )}

      {creating && (
        <CreateFlagDialog
          environmentId={environment.id}
          onClose={() => setCreating(false)}
          onCreated={(flag) => {
            setCreating(false);
            toast({ tone: 'info', message: `${flag.key} created` });
            void reload();
          }}
        />
      )}
    </section>
  );
}
