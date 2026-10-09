'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createApi, type Api } from './api';

/**
 * The dashboard's credential: an admin or root key the operator pastes in. Kept in
 * sessionStorage so a reload does not sign out, and so it ends with the tab. Keys revealed
 * on the keys page are a different matter: those never touch storage (UX.md view 4).
 */
const STORAGE_KEY = 'switchyard.apiKey';

interface Session {
  status: 'loading' | 'signed-out' | 'signed-in';
  api: Api | null;
  /** The raw key, for the event stream (which cannot go through the JSON client). */
  apiKey: string | null;
  signIn(key: string): void;
  signOut(): void;
}

const SessionContext = createContext<Session | null>(null);

function read(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setKey(read());
    setLoaded(true);
  }, []);

  const signIn = useCallback((value: string) => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, value);
    } catch {
      // Storage unavailable: the session lasts until reload.
    }
    setKey(value);
  }, []);

  const signOut = useCallback(() => {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing to clear
    }
    setKey(null);
  }, []);

  const value = useMemo<Session>(
    () => ({
      status: !loaded ? 'loading' : key ? 'signed-in' : 'signed-out',
      api: key ? createApi(key) : null,
      apiKey: key,
      signIn,
      signOut,
    }),
    [key, loaded, signIn, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}
