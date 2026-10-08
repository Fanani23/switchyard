import type { ApiKeyDto, CreateKeyBody } from '@switchyard/shared';
import type { AuditRepository } from '../audit/audit.repository.js';
import { generateApiKey } from '../auth/api-key.js';
import { actorOf, assertAdminOf, type Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { ApiKey } from '../db/schema.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import { NotFoundError } from '../errors.js';
import type { KeysRepository } from './keys.repository.js';

export interface KeysServiceDeps {
  db: Db;
  keys: KeysRepository;
  environments: EnvironmentsRepository;
  audit: AuditRepository;
  /** Called after a revocation commits, so this instance's auth cache drops the key at once. */
  onRevoked: (keyId: string) => void;
}

/** Never includes the hash: the DTO and the audit entry are both readable by admins. */
function toKeyDto(k: ApiKey): ApiKeyDto {
  return {
    id: k.id,
    environmentId: k.environmentId,
    name: k.name,
    scope: k.scope,
    prefix: k.tokenPrefix,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  };
}

export class KeysService {
  constructor(private readonly deps: KeysServiceDeps) {}

  /** Returns the only copy of the plaintext key that will ever exist; only its hash is stored. */
  async create(
    principal: Principal,
    environmentId: string,
    body: CreateKeyBody,
  ): Promise<ApiKeyDto & { key: string }> {
    const { db, keys, environments, audit } = this.deps;
    return db.transaction(async (tx) => {
      const env = await environments.findById(tx, environmentId);
      if (!env) throw new NotFoundError();
      assertAdminOf(principal, env.id);

      const generated = generateApiKey(body.scope);
      const row = await keys.insert(tx, {
        environmentId: env.id,
        name: body.name,
        scope: body.scope,
        tokenHash: generated.hash,
        tokenPrefix: generated.prefix,
      });
      const dto = toKeyDto(row);
      await audit.insert(tx, {
        environmentId: env.id,
        environmentKey: env.key,
        actor: actorOf(principal),
        action: 'api_key.created',
        entityType: 'api_key',
        entityId: row.id,
        before: null,
        after: dto,
      });
      return { ...dto, key: generated.plaintext };
    });
  }

  async list(principal: Principal, environmentId: string): Promise<ApiKeyDto[]> {
    const { db, keys, environments } = this.deps;
    const env = await environments.findById(db, environmentId);
    if (!env) throw new NotFoundError();
    assertAdminOf(principal, env.id);
    return (await keys.listByEnvironment(db, env.id)).map(toKeyDto);
  }

  /** Idempotent: revoking an already revoked key succeeds and records nothing new. */
  async revoke(principal: Principal, keyId: string): Promise<void> {
    const { db, keys, environments, audit } = this.deps;
    await db.transaction(async (tx) => {
      const existing = await keys.findById(tx, keyId);
      if (!existing) throw new NotFoundError();
      assertAdminOf(principal, existing.environmentId);

      const revoked = await keys.revoke(tx, keyId);
      if (!revoked) return;
      const env = await environments.findById(tx, existing.environmentId);
      if (!env) throw new NotFoundError();
      await audit.insert(tx, {
        environmentId: env.id,
        environmentKey: env.key,
        actor: actorOf(principal),
        action: 'api_key.revoked',
        entityType: 'api_key',
        entityId: keyId,
        before: toKeyDto(existing),
        after: toKeyDto(revoked),
      });
    });
    this.deps.onRevoked(keyId);
  }
}
