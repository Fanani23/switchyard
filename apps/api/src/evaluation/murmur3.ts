/**
 * MurmurHash3 x86_32 over the UTF-8 bytes of a string, seed 0, unsigned result.
 *
 * Hand-written rather than a dependency because SPEC.md pins this exact function: every
 * SDK must reproduce it bit for bit, so the reference implementation should be readable in
 * one screen and checked against published test vectors (see murmur3.test.ts).
 */

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

let scratch = new Uint8Array(256);

/** UTF-8 encode into a reused buffer; returns the byte length. Avoids an allocation per call. */
function encodeUtf8(input: string): number {
  // Worst case is 3 bytes per UTF-16 code unit (surrogate pairs take 4 bytes for 2 units).
  if (scratch.length < input.length * 3) scratch = new Uint8Array(input.length * 3);
  let n = 0;
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) {
      scratch[n++] = c;
    } else if (c < 0x800) {
      scratch[n++] = 0xc0 | (c >> 6);
      scratch[n++] = 0x80 | (c & 0x3f);
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        i++;
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        scratch[n++] = 0xf0 | (c >> 18);
        scratch[n++] = 0x80 | ((c >> 12) & 0x3f);
        scratch[n++] = 0x80 | ((c >> 6) & 0x3f);
        scratch[n++] = 0x80 | (c & 0x3f);
      } else {
        n = writeReplacement(n);
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      // Lone surrogate: encode U+FFFD, exactly as TextEncoder does.
      n = writeReplacement(n);
    } else {
      scratch[n++] = 0xe0 | (c >> 12);
      scratch[n++] = 0x80 | ((c >> 6) & 0x3f);
      scratch[n++] = 0x80 | (c & 0x3f);
    }
  }
  return n;
}

function writeReplacement(n: number): number {
  scratch[n] = 0xef;
  scratch[n + 1] = 0xbf;
  scratch[n + 2] = 0xbd;
  return n + 3;
}

export function murmur3_32(input: string, seed = 0): number {
  const len = encodeUtf8(input);
  const bytes = scratch;
  let h = seed >>> 0;
  const blocks = len & ~3;

  for (let i = 0; i < blocks; i += 4) {
    let k =
      (bytes[i] as number) |
      ((bytes[i + 1] as number) << 8) |
      ((bytes[i + 2] as number) << 16) |
      ((bytes[i + 3] as number) << 24);
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, C2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  let k = 0;
  switch (len & 3) {
    case 3:
      k ^= (bytes[blocks + 2] as number) << 16;
    // falls through
    case 2:
      k ^= (bytes[blocks + 1] as number) << 8;
    // falls through
    case 1:
      k ^= bytes[blocks] as number;
      k = Math.imul(k, C1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, C2);
      h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
