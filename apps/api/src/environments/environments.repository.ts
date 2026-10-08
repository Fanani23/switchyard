import { eq } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import { environments, type Environment } from '../db/schema.js';

export const environmentsRepository = {
  async insert(
    ex: Executor,
    row: { projectId: string; name: string; key: string },
  ): Promise<Environment> {
    const [created] = await ex.insert(environments).values(row).returning();
    if (!created) throw new Error('insert returned no row');
    return created;
  },

  async findById(ex: Executor, id: string): Promise<Environment | null> {
    const [row] = await ex.select().from(environments).where(eq(environments.id, id));
    return row ?? null;
  },

  /**
   * Reads the environment and holds its row lock until the transaction ends. Flag creation
   * takes this lock so two concurrent creates cannot both pass the 500-flag count check.
   */
  async findByIdForUpdate(ex: Executor, id: string): Promise<Environment | null> {
    const [row] = await ex.select().from(environments).where(eq(environments.id, id)).for('update');
    return row ?? null;
  },
};

export type EnvironmentsRepository = typeof environmentsRepository;
