import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyScope } from '@switchyard/shared';

/** Characters of the random part kept in the prefix, enough to tell keys apart in a list. */
const PREFIX_RANDOM_CHARS = 6;

export interface GeneratedKey {
  plaintext: string;
  hash: string;
  prefix: string;
}

/**
 * `sy_<scope>_<43 base64url chars>`: 256 bits of entropy. The scope is visible in the key so
 * a leaked one can be triaged at a glance, and so secret scanners can match the shape.
 */
export function generateApiKey(scope: KeyScope): GeneratedKey {
  const head = `sy_${scope}_`;
  const plaintext = head + randomBytes(32).toString('base64url');
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, head.length + PREFIX_RANDOM_CHARS),
  };
}

/** Hex SHA-256: 64 characters, matching the `api_keys_hash_length` CHECK. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Comparing digests rather than raw secrets
 * also makes the inputs equal-length, which `timingSafeEqual` requires.
 */
export function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Extracts the token from `Authorization: Bearer <token>`; null if absent or malformed. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}
