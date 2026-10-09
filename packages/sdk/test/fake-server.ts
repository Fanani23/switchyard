import type { RulesetResponse } from '@switchyard/shared';

export interface FakeConnection {
  push(text: string): void;
  sendRuleset(ruleset: RulesetResponse): void;
  /** Ends the response cleanly, as a server shutting down would. */
  close(): void;
  openedAt: number;
}

export type Mode = 'down' | 'up' | 401 | 503;

/**
 * A scripted stand-in for the API's `/v1/stream`, behind the `fetch` option. `down` rejects
 * like a refused connection; `up` answers 200 with an event stream the test writes into.
 */
export function fakeServer(onConnect?: (conn: FakeConnection) => void) {
  const encoder = new TextEncoder();
  const connections: FakeConnection[] = [];
  const attempts: number[] = [];
  let mode: Mode = 'up';

  const fetchImpl: typeof fetch = async (_input, init) => {
    attempts.push(Date.now());
    if (mode === 'down') throw new TypeError('fetch failed: connect ECONNREFUSED');
    if (mode !== 'up') return new Response(JSON.stringify({ error: 'nope' }), { status: mode });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let finished = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    init?.signal?.addEventListener('abort', () => {
      if (finished) return;
      finished = true;
      controller.error(new DOMException('The operation was aborted', 'AbortError'));
    });
    const conn: FakeConnection = {
      openedAt: Date.now(),
      push(text) {
        if (!finished) controller.enqueue(encoder.encode(text));
      },
      sendRuleset(ruleset) {
        conn.push(`event: ruleset\nid: ${ruleset.version}\ndata: ${JSON.stringify(ruleset)}\n\n`);
      },
      close() {
        if (finished) return;
        finished = true;
        controller.close();
      },
    };
    connections.push(conn);
    onConnect?.(conn);
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  return {
    fetch: fetchImpl,
    connections,
    attempts,
    setMode(next: Mode) {
      mode = next;
    },
  };
}

export const ENV_ID = '3acde8a7-6381-4a82-b8a7-4ccc9392b8a1';

/** `new-checkout` serves `treatment` to pro users and `control` otherwise; `dark-mode` is on for all. */
export function ruleset(
  version: number,
  overrides: Partial<RulesetResponse> = {},
): RulesetResponse {
  return {
    environmentId: ENV_ID,
    version,
    flags: [
      {
        key: 'new-checkout',
        kind: 'multivariate',
        default: 'control',
        variants: [{ key: 'control' }, { key: 'treatment' }],
        rules: [
          {
            kind: 'segment',
            clauses: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
            serve: 'treatment',
          },
        ],
      },
      {
        key: 'dark-mode',
        kind: 'boolean',
        default: 'off',
        variants: [{ key: 'off' }, { key: 'on' }],
        rules: [{ kind: 'percentage', weights: { on: 100 }, salt: 'a1b2c3d4e5f6a7b8' }],
      },
    ],
    ...overrides,
  };
}
