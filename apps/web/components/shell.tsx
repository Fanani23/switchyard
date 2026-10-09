'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { SessionProvider, useSession } from '@/lib/session';
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
        Switchyard
      </Link>
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
  return <>{children}</>;
}

function SignIn() {
  const { signIn } = useSession();
  const [value, setValue] = useState('');
  return (
    <section>
      <h1>Switchyard</h1>
      <p className="status">
        Sign in with an admin key (one environment) or the root key (every project). The key stays
        in this tab only.
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
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="actions">
          <button type="submit" className="primary">
            Sign in
          </button>
        </div>
      </form>
    </section>
  );
}
