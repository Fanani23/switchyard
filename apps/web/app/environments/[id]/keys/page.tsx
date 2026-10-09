'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ApiKeyDto } from '@switchyard/shared';
import { ConfirmDialog, ErrorState, SkeletonRows, useToast } from '@/components/ui';
import { isAbort } from '@/lib/api';
import { relativeTime } from '@/lib/flags';
import { useSession } from '@/lib/session';

/**
 * UX.md view 4. The revealed state is the only place a plaintext key exists: it lives in
 * this component's state, is never written to storage, and is gone when the page unmounts.
 */
export default function KeysPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useSession();
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'client' | 'admin'>('client');
  const [revealed, setRevealed] = useState<(ApiKeyDto & { key: string }) | null>(null);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      try {
        setKeys((await api.listKeys(id, signal)).items);
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

  // Not optimistic: the response carries the only copy of the secret.
  const create = async () => {
    if (!api) return;
    setCreating(true);
    try {
      const created = await api.createKey(id, { name, scope });
      setRevealed(created);
      setName('');
      void load();
    } catch {
      toast({ tone: 'error', message: 'Could not create the key' });
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKeyDto) => {
    if (!api) return;
    try {
      await api.revokeKey(key.id);
      toast({ tone: 'info', message: `${key.name} revoked` });
      void load();
    } catch {
      toast({ tone: 'error', message: `Could not revoke ${key.name}` });
    }
  };

  return (
    <section>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Projects</Link> / API keys
      </nav>
      <h1>API keys</h1>

      {revealed && (
        <div className="banner revealed" role="alert">
          <p>
            <strong>Copy this key now. It will not be shown again.</strong>
          </p>
          <code className="secret" data-testid="revealed-key">
            {revealed.key}
          </code>
          <div className="actions">
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(revealed.key)
                  .then(() => toast({ tone: 'info', message: 'Key copied' }))
                  .catch(() =>
                    toast({ tone: 'error', message: 'Copy failed; select the key instead' }),
                  )
              }
            >
              Copy
            </button>
            <button type="button" onClick={() => setRevealed(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div>
          <label htmlFor="key-name">Name</label>
          <input id="key-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="key-scope">Scope</label>
          <select
            id="key-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value === 'admin' ? 'admin' : 'client')}
          >
            <option value="client">client (SDKs: read the ruleset)</option>
            <option value="admin">admin (dashboard: change flags)</option>
          </select>
        </div>
        <button type="submit" className="primary" disabled={creating || !name}>
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {state === 'loading' && <SkeletonRows count={3} />}
      {state === 'error' && (
        <ErrorState message="Could not load keys" onRetry={() => void load()} />
      )}
      {state === 'ready' && keys.length === 0 && (
        <p className="state">
          No keys yet. Client keys go in applications and can only read the ruleset; admin keys
          change flags.
        </p>
      )}
      {keys.length > 0 && (
        <ul className="rows">
          {keys.map((key) => (
            <li key={key.id} className={`row ${key.revokedAt ? 'revoked' : ''}`}>
              <div className="row-main">
                <strong>{key.name}</strong> <span className="pill">{key.scope}</span>{' '}
                <code>{key.prefix}…</code>
                <div className="row-meta">
                  created {relativeTime(key.createdAt)} · last used{' '}
                  {key.lastUsedAt ? relativeTime(key.lastUsedAt) : 'never'}
                  {key.revokedAt && <> · revoked {relativeTime(key.revokedAt)}</>}
                </div>
              </div>
              {!key.revokedAt && (
                <button type="button" className="danger" onClick={() => setRevoking(key)}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          description={<p>Every application using this key loses access within a minute.</p>}
          confirmText={revoking.name}
          actionLabel="Revoke"
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const key = revoking;
            setRevoking(null);
            void revoke(key);
          }}
        />
      )}
    </section>
  );
}
