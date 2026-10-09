'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { AuditEntryDto } from '@switchyard/shared';
import { ErrorState, SkeletonRows } from '@/components/ui';
import { isAbort } from '@/lib/api';
import { diff, relativeTime } from '@/lib/flags';
import { useSession } from '@/lib/session';

/** UX.md view 3. Entries are never editable, matching the database guarantee. */
export default function AuditPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useSession();
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadingOlder, setLoadingOlder] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setState('loading');
      try {
        const page = await api.listAudit(id, undefined, signal);
        setEntries(page.items);
        setCursor(page.nextCursor);
        setState('ready');
      } catch (err) {
        if (!isAbort(err)) setState('error');
      }
    },
    [api, id],
  );

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  const older = async () => {
    if (!api || !cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api.listAudit(id, cursor);
      setEntries((e) => [...e, ...page.items]);
      setCursor(page.nextCursor);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <section>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Projects</Link> / Audit log
      </nav>
      <h1>Audit log</h1>
      {state === 'loading' && entries.length === 0 && <SkeletonRows />}
      {state === 'error' && (
        <ErrorState message="Could not load history" onRetry={() => void load()} />
      )}
      {state === 'ready' && entries.length === 0 && (
        <p className="state">No changes recorded yet</p>
      )}
      {entries.length > 0 && (
        <ol className="rows">
          {entries.map((entry) => (
            <li key={entry.id} className="row audit-row">
              <div className="row-main">
                <strong>{entry.action}</strong> <span className="muted">by {entry.actor}</span>
                <div>
                  <time dateTime={entry.createdAt}>
                    {relativeTime(entry.createdAt)} · {new Date(entry.createdAt).toLocaleString()}
                  </time>
                </div>
                <dl className="diff">
                  {diff(entry.before, entry.after).map((change) => (
                    <div key={change.field}>
                      <dt>{change.field}</dt>
                      <dd>
                        <del>{format(change.before)}</del> → <ins>{format(change.after)}</ins>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </li>
          ))}
        </ol>
      )}
      {state === 'ready' && cursor && (
        <button type="button" onClick={() => void older()} disabled={loadingOlder}>
          {loadingOlder ? 'Loading…' : 'Load older'}
        </button>
      )}
      {state === 'ready' && entries.length > 0 && !cursor && (
        <p className="muted">Beginning of history (entries are kept for 90 days).</p>
      )}
    </section>
  );
}

function format(value: unknown): string {
  if (value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}
