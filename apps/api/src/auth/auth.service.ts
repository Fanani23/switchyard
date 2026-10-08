import type { Db } from '../db/client.js';
import { UnauthorizedError } from '../errors.js';
import type { KeysRepository } from '../keys/keys.repository.js';
import { bearerToken, digestsEqual, hashApiKey } from './api-key.js';
import type { Principal } from './principal.js';

/**
 * SPEC.md D4 allows a revoked key up to 60 seconds. Caching resolved keys for half that keeps
 * a hot path off the database while leaving margin: an instance that did not perform the
 * revocation stops honoring the key within this TTL.
 */
export const DEFAULT_AUTH_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 10_000;

interface CacheEntry {
  principal: Principal;
  keyId: string;
  expiresAt: number;
}

export interface AuthServiceOptions {
  db: Db;
  keys: KeysRepository;
  /** Plaintext root key from the environment; undefined disables root access entirely. */
  rootKey?: string;
  cacheTtlMs?: number;
  now?: () => number;
}

export class AuthService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly rootHash: string | null;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(private readonly opts: AuthServiceOptions) {
    this.rootHash = opts.rootKey ? hashApiKey(opts.rootKey) : null;
    this.ttl = opts.cacheTtlMs ?? DEFAULT_AUTH_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Resolves an `Authorization` header to a principal, or throws 401. */
  async authenticate(authorization: string | undefined): Promise<Principal> {
    const token = bearerToken(authorization);
    if (!token) throw new UnauthorizedError();
    const hash = hashApiKey(token);

    if (this.rootHash !== null && digestsEqual(hash, this.rootHash)) return { kind: 'root' };

    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > this.now()) return cached.principal;
    this.cache.delete(hash);

    const found = await this.opts.keys.findActiveByHash(this.opts.db, hash);
    // The row was found by an index lookup on the hash; the constant-time comparison is the
    // check that actually authorizes, so no code path accepts a key on a lookup alone.
    if (!found || !digestsEqual(found.key.tokenHash, hash)) throw new UnauthorizedError();

    await this.opts.keys.touchLastUsed(this.opts.db, found.key.id);
    const principal: Principal = {
      kind: 'key',
      keyId: found.key.id,
      environmentId: found.key.environmentId,
      projectId: found.projectId,
      scope: found.key.scope,
    };
    this.remember(hash, found.key.id, principal);
    return principal;
  }

  /** Drops a key from this instance's cache, so a revocation is immediate here. */
  forget(keyId: string): void {
    for (const [hash, entry] of this.cache) if (entry.keyId === keyId) this.cache.delete(hash);
  }

  private remember(hash: string, keyId: string, principal: Principal): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Map iteration order is insertion order: evict the oldest entry.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(hash, { principal, keyId, expiresAt: this.now() + this.ttl });
  }
}
