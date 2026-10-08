'use client';

import { useEffect, useState } from 'react';

/**
 * Delays a fast-changing value so network calls fire on a pause, not a keystroke.
 * 300ms sits inside the 250-400ms band that feels instant but still batches typing.
 */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
