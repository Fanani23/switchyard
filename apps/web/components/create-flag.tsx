'use client';

import { useState } from 'react';
import type { CreateFlagBody, FlagDto } from '@switchyard/shared';
import { ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Dialog } from './ui';

/**
 * Not optimistic (UX.md): the server assigns the id, and a placeholder row that changes
 * identity afterwards is worse than a short wait.
 */
export function CreateFlagDialog(props: {
  environmentId: string;
  onClose: () => void;
  onCreated: (flag: FlagDto) => void;
}) {
  const { api } = useSession();
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<'boolean' | 'multivariate'>('boolean');
  const [variants, setVariants] = useState('control, treatment');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!api) return;
    const variantKeys = variants
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const body: CreateFlagBody =
      kind === 'boolean'
        ? { kind, key, default: 'off', enabled: true }
        : {
            kind,
            key,
            variants: variantKeys.map((k) => ({ key: k })),
            default: variantKeys[0] ?? '',
            enabled: true,
          };
    setBusy(true);
    setError(null);
    try {
      props.onCreated(await api.createFlag(props.environmentId, body));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? [err.message, ...(err.body?.details ?? []).map((d) => `${d.path}: ${d.message}`)].join(
              ' — ',
            )
          : 'Could not create the flag',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Create flag" onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="new-flag-key">Key</label>
        <input
          id="new-flag-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="new-checkout"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <fieldset>
          <legend>Kind</legend>
          <label className="inline">
            <input type="radio" checked={kind === 'boolean'} onChange={() => setKind('boolean')} />{' '}
            On / off
          </label>
          <label className="inline">
            <input
              type="radio"
              checked={kind === 'multivariate'}
              onChange={() => setKind('multivariate')}
            />{' '}
            Variants
          </label>
        </fieldset>
        {kind === 'multivariate' && (
          <>
            <label htmlFor="new-flag-variants">
              Variants, comma-separated (the first is the default)
            </label>
            <input
              id="new-flag-variants"
              value={variants}
              onChange={(e) => setVariants(e.target.value)}
            />
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !key}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
