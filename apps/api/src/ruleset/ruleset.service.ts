import type { RulesetResponse } from '@switchyard/shared';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { EnvironmentsRepository } from '../environments/environments.repository.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import { toRulesetFlag } from '../flags/flag.mapper.js';
import type { FlagsRepository } from '../flags/flags.repository.js';

export interface RulesetServiceDeps {
  db: Db;
  flags: FlagsRepository;
  environments: EnvironmentsRepository;
}

export class RulesetService {
  constructor(private readonly deps: RulesetServiceDeps) {}

  /**
   * The whole evaluable ruleset for the key's environment. Any key scope may read it (D2);
   * the root key has no environment and so has no ruleset.
   *
   * Version and flags are read in one REPEATABLE READ snapshot. Read separately, a write
   * landing between them would pair version N with the flags of N+1; an SDK holding N+1
   * would then ignore the real N+1 push as "already seen" and keep stale rules.
   */
  async get(principal: Principal): Promise<RulesetResponse> {
    if (principal.kind !== 'key') throw new ForbiddenError();
    const { db, flags, environments } = this.deps;
    return db.transaction(
      async (tx) => {
        const env = await environments.findById(tx, principal.environmentId);
        if (!env) throw new NotFoundError();
        const all = await flags.listAll(tx, env.id);
        return {
          environmentId: env.id,
          version: env.rulesetVersion,
          flags: all.map(toRulesetFlag),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
