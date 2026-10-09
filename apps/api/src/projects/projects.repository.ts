import { asc, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../db/executor.js';
import { environments, projects, type Environment, type Project } from '../db/schema.js';

export const projectsRepository = {
  async insert(ex: Executor, row: { name: string; slug: string }): Promise<Project> {
    const [created] = await ex.insert(projects).values(row).returning();
    if (!created) throw new Error('insert returned no row');
    return created;
  },

  async findById(ex: Executor, id: string): Promise<Project | null> {
    const [row] = await ex.select().from(projects).where(eq(projects.id, id));
    return row ?? null;
  },

  /** All projects, or only those with the given ids. */
  async list(ex: Executor, ids?: string[]): Promise<Project[]> {
    const query = ex.select().from(projects);
    const filtered = ids ? query.where(inArray(projects.id, ids)) : query;
    return filtered.orderBy(asc(projects.slug));
  },

  async listEnvironments(ex: Executor, projectIds: string[]): Promise<Environment[]> {
    if (projectIds.length === 0) return [];
    return ex
      .select()
      .from(environments)
      .where(inArray(environments.projectId, projectIds))
      .orderBy(asc(environments.key));
  },
};

export type ProjectsRepository = typeof projectsRepository;
