/**
 * Realistic user keys for distribution tests. Deterministic (seeded) so a failure
 * reproduces, but shaped like production keys rather than `0..n`: sequential integers are
 * exactly the toy input that can hide a weak hash.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hex(rand: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(rand() * 16).toString(16);
  return s;
}

/** UUID v4-shaped keys, the most common user key in practice. */
export function uuidKeys(count: number, seed = 1): string[] {
  const rand = mulberry32(seed);
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    const variant = '89ab'[Math.floor(rand() * 4)] as string;
    keys.push(`${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-${variant}${hex(rand, 3)}-${hex(rand, 12)}`);
  }
  return keys;
}

/** Email and database-id shaped keys: low-entropy prefixes with a varying tail. */
export function mixedKeys(count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(i % 2 === 0 ? `user${i}@example.com` : `usr_${(100000 + i).toString(36)}`);
  }
  return keys;
}

/** Random flag salts in the shape the API generates (16 hex characters). */
export function salts(count: number, seed = 99): string[] {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => hex(rand, 16));
}
