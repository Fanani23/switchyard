import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { KeyScope } from '@switchyard/shared';
import type { Executor } from '../db/executor.js';
import { apiKeys, environments, type ApiKey } from '../db/schema.js';

export interface KeyWithProject {
  key: ApiKey;
  projectId: string;
}

export const keysRepository = {
  async insert(
    ex: Executor,
    row: {
      environmentId: string;
      name: string;
      scope: KeyScope;
      tokenHash: string;
      tokenPrefix: string;
    },
  ): Promise<ApiKey> {
    const [created] = await ex.insert(apiKeys).values(row).returning();
    if (!created) throw new Error('insert returned no row');
    return created;
  },

  async findById(ex: Executor, id: string): Promise<ApiKey | null> {
    const [row] = await ex.select().from(apiKeys).where(eq(apiKeys.id, id));
    return row ?? null;
  },

  /** Looks up a live (unrevoked) key by hash, with the project it belongs to. */
  async findActiveByHash(ex: Executor, tokenHash: string): Promise<KeyWithProject | null> {
    const [row] = await ex
      .select({ key: apiKeys, projectId: environments.projectId })
      .from(apiKeys)
      .innerJoin(environments, eq(environments.id, apiKeys.environmentId))
      .where(and(eq(apiKeys.tokenHash, tokenHash), isNull(apiKeys.revokedAt)));
    return row ?? null;
  },

  async touchLastUsed(ex: Executor, id: string): Promise<void> {
    await ex
      .update(apiKeys)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(apiKeys.id, id));
  },

  async listByEnvironment(ex: Executor, environmentId: string): Promise<ApiKey[]> {
    return ex
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.environmentId, environmentId))
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  },

  /** Revokes a live key; returns the updated row, or null if it was already revoked. */
  async revoke(ex: Executor, id: string): Promise<ApiKey | null> {
    const [row] = await ex
      .update(apiKeys)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning();
    return row ?? null;
  },
};

export type KeysRepository = typeof keysRepository;
