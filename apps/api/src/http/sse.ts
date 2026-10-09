import type { ServerResponse } from 'node:http';
import type { StreamEvent, StreamSink } from '../stream/stream.service.js';

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

/**
 * Formats one Server-Sent Event. The data is serialized JSON, which never contains a raw
 * newline (JSON.stringify escapes them), so it always fits on one `data:` line.
 */
export function formatEvent(event: string, json: string, id?: string): string {
  return `event: ${event}\n${id === undefined ? '' : `id: ${id}\n`}data: ${json}\n\n`;
}

/**
 * Encoded frames, one per event object. Every connection receiving the same push writes the
 * same Buffer, which Node queues by reference: encoding and memory are per push, not per
 * connection (SPEC.md F3, 1,000 clients).
 */
const frames = new WeakMap<StreamEvent, Buffer>();

function frameOf(event: StreamEvent): Buffer {
  let frame = frames.get(event);
  if (!frame) {
    frame = Buffer.from(formatEvent(event.event, event.json, event.id), 'utf8');
    frames.set(event, frame);
  }
  return frame;
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
    send(event) {
      if (!closed) res.write(frameOf(event));
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
