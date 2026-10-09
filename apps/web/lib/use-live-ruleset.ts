'use client';

import { useEffect, useRef, useState } from 'react';
import { backoffDelay, SseParser } from '@switchyard/sdk';
import { API_URL } from './api';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'unavailable';

/**
 * The dashboard consumes the same SSE stream as the SDKs (UX.md, live updates). It only
 * needs to know *that* the ruleset changed: `onChange` fires with each new version, and the
 * caller re-fetches what it shows. Reconnects use the SDK's backoff (1 s … 30 s, ±20%
 * jitter) so dashboards do not reconnect in lockstep after an API restart.
 */
export function useLiveRuleset(
  apiKey: string | null,
  environmentId: string | null,
  onChange: (version: number) => void,
): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    if (!apiKey || !environmentId) return;
    const abort = new AbortController();
    let attempt = 0;
    let version = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const res = await fetch(`${API_URL}/v1/stream?environmentId=${environmentId}`, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (res.status === 401 || res.status === 403) {
          setStatus('unavailable');
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.event !== 'ruleset') continue;
            setStatus('live');
            attempt = 0;
            const next = Number(event.id);
            // The first event after (re)connecting is the full current ruleset: anything
            // missed while disconnected is covered by re-fetching, never by replay.
            if (next !== version) {
              const first = version === -1;
              version = next;
              if (!first) callback.current(next);
            }
          }
        }
      } catch {
        if (abort.signal.aborted) return;
      }
      if (abort.signal.aborted) return;
      setStatus('reconnecting');
      timer = setTimeout(connect, backoffDelay(attempt++));
      // After a reconnect the first ruleset event must trigger a re-fetch.
      if (version !== -1) version = -2;
    };

    void connect();
    return () => {
      abort.abort();
      if (timer) clearTimeout(timer);
    };
  }, [apiKey, environmentId]);

  return status;
}
