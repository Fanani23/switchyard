import type {
  CreateEnvironmentBody,
  CreateProjectBody,
  EnvironmentDto,
  ProjectDto,
} from '@switchyard/shared';
import type { AuditRepository } from '../audit/audit.repository.js';
import { actorOf, assertAdmin, assertRoot, type Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import { uniqueViolation } from '../db/executor.js';
import type { Environment, Project } from '../db/schema.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { ProjectsRepository } from './projects.repository.js';

export interface ProjectsServiceDeps {
  db: Db;
  projects: ProjectsRepository;
  environments: EnvironmentsRepository;
  audit: AuditRepository;
}

export function toProjectDto(p: Project): ProjectDto {
  return { id: p.id, name: p.name, slug: p.slug, createdAt: p.createdAt.toISOString() };
}

export function toEnvironmentDto(e: Environment): EnvironmentDto {
  return {
    id: e.id,
    projectId: e.projectId,
    name: e.name,
    key: e.key,
    rulesetVersion: e.rulesetVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

export class ProjectsService {
  constructor(private readonly deps: ProjectsServiceDeps) {}

  /**
   * Root only. Not audited: audit_log requires an environment, and a new project has none.
   * This is a gap between E1 ("every change") and the data model, reported with the PR.
   */
  async create(principal: Principal, body: CreateProjectBody): Promise<ProjectDto> {
    assertRoot(principal);
    try {
      return toProjectDto(await this.deps.projects.insert(this.deps.db, body));
    } catch (err) {
      if (uniqueViolation(err) === 'projects_slug_unique') {
        throw new ConflictError('Project slug already exists');
      }
      throw err;
    }
  }

  /** Root sees every project; an admin key sees only the project its environment is in. */
  async list(
    principal: Principal,
  ): Promise<Array<ProjectDto & { environments: EnvironmentDto[] }>> {
    assertAdmin(principal);
    const { db, projects } = this.deps;
    const rows = await projects.list(
      db,
      principal.kind === 'root' ? undefined : [principal.projectId],
    );
    const envs = await projects.listEnvironments(
      db,
      rows.map((p) => p.id),
    );
    return rows.map((p) => ({
      ...toProjectDto(p),
      environments: envs.filter((e) => e.projectId === p.id).map(toEnvironmentDto),
    }));
  }

  /** Root only: an environment-scoped key cannot be allowed to mint new environments. */
  async createEnvironment(
    principal: Principal,
    projectId: string,
    body: CreateEnvironmentBody,
  ): Promise<EnvironmentDto> {
    assertRoot(principal);
    const { db, projects, environments, audit } = this.deps;
    try {
      return await db.transaction(async (tx) => {
        const project = await projects.findById(tx, projectId);
        if (!project) throw new NotFoundError();
        const env = await environments.insert(tx, { projectId, name: body.name, key: body.key });
        const dto = toEnvironmentDto(env);
        await audit.insert(tx, {
          environmentId: env.id,
          environmentKey: env.key,
          actor: actorOf(principal),
          action: 'environment.created',
          entityType: 'environment',
          entityId: env.id,
          before: null,
          after: dto,
        });
        return dto;
      });
    } catch (err) {
      if (uniqueViolation(err) === 'environments_project_key_uq') {
        throw new ConflictError('Environment key already exists');
      }
      throw err;
    }
  }
}
