import type { ServerResponse } from 'node:http';
import type { StreamSink } from '../stream/stream.service.js';

/**
 * Headers for an event stream. The route hijacks the reply, so nothing Fastify or helmet
 * would add is sent; what matters for a stream is restated here. `X-Accel-Buffering`
 * stops nginx-style proxies from holding events back until a buffer fills.
 */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
  'x-content-type-options': 'nosniff',
} as const;

/** Formats one Server-Sent Event. Data is JSON, so it never contains a bare newline. */
export function formatEvent(event: string, data: unknown, id?: string): string {
  return `event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
}

export function sseSink(res: ServerResponse): StreamSink {
  let closed = res.destroyed || res.writableEnded;
  const callbacks: Array<() => void> = [];
  res.on('close', () => {
    if (closed) return;
    closed = true;
    for (const cb of callbacks.splice(0)) cb();
  });

  return {
    send(event, data, id) {
      if (!closed) res.write(formatEvent(event, data, id));
    },
    buffered: () => res.writableLength,
    end() {
      if (!res.writableEnded) res.end();
    },
    onClose(cb) {
      if (closed) cb();
      else callbacks.push(cb);
    },
  };
}
