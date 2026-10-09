import { randomBytes } from 'node:crypto';
import {
  BOOLEAN_VARIANTS,
  LIMITS,
  type CreateFlagBody,
  type FlagDto,
  type ListFlagsQuery,
  type ReplaceRulesBody,
  type UpdateFlagBody,
} from '@switchyard/shared';
import type { AuditRepository } from '../audit/audit.repository.js';
import { actorOf, assertAdminOf, type Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import { uniqueViolation, type Tx } from '../db/executor.js';
import type { Environment } from '../db/schema.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import {
  ConflictError,
  LimitExceededError,
  NotFoundError,
  ValidationError,
  type ValidationDetail,
} from '../errors.js';
import { ruleToRow, toAuditSnapshot, toFlagDto } from './flag.mapper.js';
import type { FlagAggregate, FlagChanges, FlagsRepository } from './flags.repository.js';

const DUPLICATE_KEY = 'Flag key already exists';

export interface FlagsServiceDeps {
  db: Db;
  flags: FlagsRepository;
  environments: EnvironmentsRepository;
  audit: AuditRepository;
}

/** 16 hex characters: well above the schema's 8-character floor, unique per flag (A6). */
function newSalt(): string {
  return randomBytes(8).toString('hex');
}

export class FlagsService {
  constructor(private readonly deps: FlagsServiceDeps) {}

  async list(
    principal: Principal,
    environmentId: string,
    query: ListFlagsQuery,
  ): Promise<{ items: FlagDto[]; total: number; nextCursor: string | null }> {
    const { db, flags, environments, audit } = this.deps;
    const env = await environments.findById(db, environmentId);
    if (!env) throw new NotFoundError();
    assertAdminOf(principal, env.id);

    const page = await flags.listPage(db, env.id, query);
    const actors = await audit.latestActors(
      db,
      page.items.map((a) => a.flag.id),
    );
    const items = page.items.map((a) => toFlagDto(a, actors.get(a.flag.id) ?? null));
    const last = page.items.at(-1);
    const nextCursor = last && page.items.length === query.limit ? last.flag.key : null;
    return { items, total: page.total, nextCursor };
  }

  async create(
    principal: Principal,
    environmentId: string,
    body: CreateFlagBody,
  ): Promise<FlagDto> {
    const { db, flags, environments } = this.deps;
    const variantKeys =
      body.kind === 'boolean' ? [...BOOLEAN_VARIANTS] : body.variants.map((v) => v.key);

    try {
      return await db.transaction(async (tx) => {
        // The row lock serializes creates per environment, so the count below cannot be
        // raced past the limit by concurrent requests.
        const env = await environments.findByIdForUpdate(tx, environmentId);
        if (!env) throw new NotFoundError();
        assertAdminOf(principal, env.id);

        const existing = await flags.countInEnvironment(tx, env.id);
        if (existing >= LIMITS.flagsPerEnvironment) {
          throw new LimitExceededError(
            'Flags per environment exceeded',
            LIMITS.flagsPerEnvironment,
            existing + 1,
          );
        }

        const created = await flags.insert(
          tx,
          {
            environmentId: env.id,
            key: body.key,
            description: body.description ?? null,
            kind: body.kind,
            defaultVariant: body.default,
            salt: newSalt(),
            enabled: body.enabled,
          },
          variantKeys,
        );
        await this.record(tx, env, principal, 'flag.created', created.flag.id, null, created);
        return toFlagDto(created, actorOf(principal));
      });
    } catch (err) {
      if (uniqueViolation(err) === 'flags_environment_key_uq')
        throw new ConflictError(DUPLICATE_KEY);
      throw err;
    }
  }

  async get(principal: Principal, flagId: string): Promise<FlagDto> {
    const { db, flags, audit } = this.deps;
    const aggregate = await flags.findById(db, flagId);
    if (!aggregate) throw new NotFoundError();
    assertAdminOf(principal, aggregate.flag.environmentId);
    const actors = await audit.latestActors(db, [flagId]);
    return toFlagDto(aggregate, actors.get(flagId) ?? null);
  }

  async update(principal: Principal, flagId: string, body: UpdateFlagBody): Promise<FlagDto> {
    try {
      return await this.mutate(principal, flagId, body.expectedUpdatedAt, async (tx, before) => {
        const variantKeys = before.variants.map((v) => v.key);
        if (body.default !== undefined && !variantKeys.includes(body.default)) {
          throw new ValidationError([
            { path: 'default', message: `must be one of: ${variantKeys.join(', ')}` },
          ]);
        }
        const changes: FlagChanges = {};
        if (body.key !== undefined) changes.key = body.key;
        if (body.description !== undefined) changes.description = body.description;
        if (body.default !== undefined) changes.defaultVariant = body.default;
        if (body.enabled !== undefined) changes.enabled = body.enabled;
        await this.deps.flags.update(tx, flagId, changes);

        const onlyToggled = Object.keys(changes).length === 1 && changes.enabled !== undefined;
        if (!onlyToggled) return 'flag.updated';
        return changes.enabled ? 'flag.enabled' : 'flag.disabled';
      });
    } catch (err) {
      if (uniqueViolation(err) === 'flags_environment_key_uq')
        throw new ConflictError(DUPLICATE_KEY);
      throw err;
    }
  }

  async replaceRules(
    principal: Principal,
    flagId: string,
    body: ReplaceRulesBody,
  ): Promise<FlagDto> {
    return this.mutate(principal, flagId, body.expectedUpdatedAt, async (tx, before) => {
      const declared = new Set(before.variants.map((v) => v.key));
      const allowed = [...declared].join(', ');
      const problems: ValidationDetail[] = [];
      body.rules.forEach((rule, i) => {
        if (rule.kind === 'segment' && !declared.has(rule.serve)) {
          problems.push({ path: `rules.${i}.serve`, message: `must be one of: ${allowed}` });
        }
        if (rule.kind === 'percentage') {
          for (const variant of Object.keys(rule.weights)) {
            if (!declared.has(variant)) {
              problems.push({
                path: `rules.${i}.weights.${variant}`,
                message: `must be one of: ${allowed}`,
              });
            }
          }
        }
      });
      if (problems.length > 0) throw new ValidationError(problems);

      await this.deps.flags.replaceRules(tx, flagId, body.rules.map(ruleToRow));
      return 'flag.rules_replaced';
    });
  }

  async delete(principal: Principal, flagId: string): Promise<void> {
    const { db, flags, environments } = this.deps;
    await db.transaction(async (tx) => {
      const before = await flags.findByIdForUpdate(tx, flagId);
      if (!before) throw new NotFoundError();
      assertAdminOf(principal, before.flag.environmentId);
      const env = await environments.findById(tx, before.flag.environmentId);
      if (!env) throw new NotFoundError();
      await this.record(tx, env, principal, 'flag.deleted', flagId, before, null);
      await flags.delete(tx, flagId);
    });
  }

  /**
   * The shared shape of every change to an existing flag: lock it, check access and the
   * optional precondition, apply the change, and write the audit entry with the before and
   * after state, all in one transaction so the log and the data cannot disagree (E1).
   */
  private async mutate(
    principal: Principal,
    flagId: string,
    expectedUpdatedAt: string | undefined,
    apply: (tx: Tx, before: FlagAggregate) => Promise<string>,
  ): Promise<FlagDto> {
    const { db, flags, environments } = this.deps;
    return db.transaction(async (tx) => {
      const before = await flags.findByIdForUpdate(tx, flagId);
      if (!before) throw new NotFoundError();
      assertAdminOf(principal, before.flag.environmentId);

      if (
        expectedUpdatedAt !== undefined &&
        before.flag.updatedAt.getTime() !== Date.parse(expectedUpdatedAt)
      ) {
        const actors = await this.deps.audit.latestActors(tx, [flagId]);
        throw new ConflictError(
          'Flag was changed since it was loaded',
          toFlagDto(before, actors.get(flagId) ?? null),
        );
      }

      const action = await apply(tx, before);
      const after = await flags.findById(tx, flagId);
      const env = await environments.findById(tx, before.flag.environmentId);
      if (!after || !env) throw new NotFoundError();
      await this.record(tx, env, principal, action, flagId, before, after);
      return toFlagDto(after, actorOf(principal));
    });
  }

  private async record(
    tx: Tx,
    env: Environment,
    principal: Principal,
    action: string,
    flagId: string,
    before: FlagAggregate | null,
    after: FlagAggregate | null,
  ): Promise<void> {
    await this.deps.audit.insert(tx, {
      environmentId: env.id,
      environmentKey: env.key,
      actor: actorOf(principal),
      action,
      entityType: 'flag',
      entityId: flagId,
      before: before ? toAuditSnapshot(before) : null,
      after: after ? toAuditSnapshot(after) : null,
    });
  }
}
