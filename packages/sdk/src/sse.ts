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
  /** How much of `buffer` is already known to hold no line break. */
  private scanned = 0;
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  /**
   * Feeds a chunk; returns the events it completed. Partial lines wait for the next chunk.
   * Only new input is scanned for line breaks: a 170 KiB ruleset arriving in many chunks
   * costs one pass, not one pass per chunk over everything buffered so far.
   */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    const breaks = /\r\n|\r|\n/g;
    breaks.lastIndex = this.scanned;
    let start = 0;
    let scannedTo = this.buffer.length;
    for (let match = breaks.exec(this.buffer); match; match = breaks.exec(this.buffer)) {
      // A CR at the very end may be the first half of a CRLF split across chunks: leave it
      // unscanned so the next chunk decides.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) {
        scannedTo = match.index;
        break;
      }
      const completed = this.line(this.buffer.slice(start, match.index));
      if (completed) events.push(completed);
      start = breaks.lastIndex;
    }
    this.buffer = this.buffer.slice(start);
    this.scanned = scannedTo - start;
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
