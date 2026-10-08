import { LIMITS, type AuditEntryDto, type ListAuditQuery } from '@switchyard/shared';
import { assertAdminOf, type Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { AuditEntry } from '../db/schema.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { AuditRepository } from './audit.repository.js';

export interface AuditServiceDeps {
  db: Db;
  audit: AuditRepository;
  environments: EnvironmentsRepository;
}

function toAuditDto(e: AuditEntry): AuditEntryDto {
  return {
    id: e.id,
    environmentId: e.environmentId,
    environmentKey: e.environmentKey,
    actor: e.actor,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    before: e.before,
    after: e.after,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Read-only by construction: there is no update or delete path, only list and purge. */
export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async list(
    principal: Principal,
    environmentId: string,
    query: ListAuditQuery,
  ): Promise<{ items: AuditEntryDto[]; nextCursor: string | null }> {
    const { db, audit, environments } = this.deps;
    const env = await environments.findById(db, environmentId);
    if (!env) throw new NotFoundError();
    assertAdminOf(principal, env.id);

    let after: AuditEntry | undefined;
    if (query.cursor) {
      after = (await audit.findInEnvironment(db, env.id, query.cursor)) ?? undefined;
      if (!after) throw new ValidationError([{ path: 'cursor', message: 'unknown cursor' }]);
    }
    const rows = await audit.listPage(db, env.id, { limit: query.limit, after });
    const last = rows.at(-1);
    return {
      items: rows.map(toAuditDto),
      nextCursor: last && rows.length === query.limit ? last.id : null,
    };
  }

  /** The scheduled cleanup for SPEC.md's 90-day audit retention. */
  async purgeExpired(): Promise<number> {
    return this.deps.audit.purgeOlderThan(this.deps.db, LIMITS.auditRetentionDays);
  }
}
