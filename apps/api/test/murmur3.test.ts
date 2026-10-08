import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { murmur3_32 } from '../src/evaluation/index.js';

/**
 * The SDKs must reproduce this hash bit for bit, so it is checked against an implementation
 * we did not write: the vectors in fixtures/murmur3-vectors.json were produced by Python's
 * `mmh3.hash(s.encode('utf-8'), 0, signed=False)` over random ASCII, Latin-1, CJK and
 * astral-plane strings of length 0–40.
 */
describe('murmur3_32', () => {
  it('matches the published MurmurHash3 x86_32 vectors (seed 0)', () => {
    expect(murmur3_32('')).toBe(0);
    expect(murmur3_32('hello')).toBe(0x248bfa47);
    expect(murmur3_32('test')).toBe(0xba6bd213);
    expect(murmur3_32('The quick brown fox jumps over the lazy dog')).toBe(0x2e4ff723);
  });

  it('honors the seed', () => {
    expect(murmur3_32('', 1)).toBe(0x514e28b7);
    expect(murmur3_32('', 0xffffffff)).toBe(0x81f16f39);
  });

  it('matches an independent implementation over 2,000 random UTF-8 strings', () => {
    const vectors = JSON.parse(
      readFileSync(new URL('./fixtures/murmur3-vectors.json', import.meta.url), 'utf8'),
    ) as Array<[string, number]>;
    expect(vectors).toHaveLength(2000);
    for (const [input, expected] of vectors) expect(murmur3_32(input)).toBe(expected);
  });

  it('encodes lone surrogates as U+FFFD, the same bytes TextEncoder produces', () => {
    const replacement = '�';
    expect(murmur3_32('a\ud800b')).toBe(murmur3_32(`a${replacement}b`));
    expect(murmur3_32('\udc00')).toBe(murmur3_32(replacement));
    expect(murmur3_32('\ud83d')).toBe(murmur3_32(replacement));
  });

  it('is unaffected by a previous, longer input (no state leaks through the scratch buffer)', () => {
    const before = murmur3_32('abc');
    murmur3_32('x'.repeat(10_000));
    expect(murmur3_32('abc')).toBe(before);
  });
});
