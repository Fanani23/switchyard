'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemeToggle } from './theme-toggle';
import { ToastProvider } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ToastProvider>
        <Header />
        <main>
          <Gate>{children}</Gate>
        </main>
      </ToastProvider>
    </SessionProvider>
  );
}

function Header() {
  const { status, signOut } = useSession();
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true" />
        Switchyard
      </Link>
      <span className="spacer" />
      <ThemeToggle />
      {status === 'signed-in' && (
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      )}
    </header>
  );
}

/** Every page needs a key; until there is one, the only thing to show is how to give it. */
function Gate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  if (status === 'loading')
    return (
      <p className="status" role="status">
        Loading…
      </p>
    );
  if (status === 'signed-out') return <SignIn />;
  return <div className="enter">{children}</div>;
}

const FEATURES = [
  ['Evaluated locally', 'SDKs hold the ruleset in memory. A check is a hash, not a request.'],
  ['Live in under a second', 'Changes reach every connected client over a stream.'],
  ['Safe while it is down', 'A disconnected client keeps serving the ruleset it already has.'],
] as const;

function SignIn() {
  const { signIn } = useSession();
  const [value, setValue] = useState('');

  return (
    <section className="signin enter">
      <div className="signin-pitch">
        <h1>Ship features without shipping code</h1>
        <p className="lede">
          Switchyard turns a release into a switch. Roll a feature out to one percent, watch it,
          then turn it off in a second when it misbehaves — with no deploy, no build, no pipeline.
        </p>
        <ul className="features">
          {FEATURES.map(([title, body]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span className="muted">{body}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card signin-card">
        <h2>Sign in</h2>
        <p className="muted">
          Use an admin key for one environment, or the root key for every project. The key is kept
          in this tab only and is never written to disk.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) signIn(value.trim());
          }}
        >
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            autoComplete="off"
            placeholder="sk-…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <div className="actions">
            <button type="submit" className="primary" disabled={!value.trim()}>
              Sign in
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
