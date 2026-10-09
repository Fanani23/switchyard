/**
 * A minimal Server-Sent Events parser (the subset of the WHATWG format the API emits:
 * `event`, `data`, `id`, comments). Written here rather than using `EventSource` because
 * EventSource cannot send an `Authorization` header and does its own reconnecting, and the
 * SDK needs control of both.
 */
export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  /** Feeds a chunk; returns the events it completed. Partial lines wait for the next chunk. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A lone CR at the very end may be the first half of CRLF split across chunks.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const completed = this.line(line);
      if (completed) events.push(completed);
    }
    return events;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return null;
      }
      const out: SseEvent = { event: this.event || 'message', data: this.data.join('\n') };
      if (this.id !== undefined) out.id = this.id;
      this.event = '';
      this.data = [];
      return out;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }
}
