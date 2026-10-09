'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'switchyard-theme';

/**
 * Runs before first paint, so the stored choice is applied with no flash of the wrong
 * theme. Inlined in the document head rather than loaded, because a request would be
 * slower than the paint it is trying to beat.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice still applies for this page view.
  }
}

const ORDER: Theme[] = ['system', 'light', 'dark'];

const LABEL: Record<Theme, string> = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    let stored: Theme = 'system';
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark') stored = raw;
    } catch {
      // ignore
    }
    setTheme(stored);
    setMounted(true);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? 'system';
    setTheme(next);
    apply(next);
  }

  // Render a stable placeholder until mounted, so server and client markup agree.
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycle}
      aria-label={mounted ? LABEL[theme] : 'Theme'}
      title={mounted ? LABEL[theme] : 'Theme'}
    >
      <span aria-hidden="true" className="theme-icon">
        {mounted ? { system: '◐', light: '☀', dark: '☾' }[theme] : '◐'}
      </span>
      <span className="theme-name">{mounted ? theme : ''}</span>
    </button>
  );
}
