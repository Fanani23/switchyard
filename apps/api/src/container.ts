import { AuditService } from './audit/audit.service.js';
import { auditRepository } from './audit/audit.repository.js';
import { AuthService } from './auth/auth.service.js';
import type { Db } from './db/client.js';
import { environmentsRepository } from './environments/environments.repository.js';
import { FlagsService } from './flags/flags.service.js';
import { flagsRepository } from './flags/flags.repository.js';
import { KeysService } from './keys/keys.service.js';
import { keysRepository } from './keys/keys.repository.js';
import { ProjectsService } from './projects/projects.service.js';
import { projectsRepository } from './projects/projects.repository.js';
import { RulesetService } from './ruleset/ruleset.service.js';
import type { ChangeFeed } from './stream/change-feed.js';
import { ChangeHub } from './stream/change-hub.js';
import { StreamService } from './stream/stream.service.js';

export interface ServiceConfig {
  rootKey?: string;
  authCacheTtlMs?: number;
  changeFeed: ChangeFeed;
  streamHeartbeatMs?: number;
  onError?: (err: unknown, context: string) => void;
}

/** Wires repositories into services. The only place that knows the whole graph. */
export function createServices(db: Db, config: ServiceConfig) {
  const repos = {
    projects: projectsRepository,
    environments: environmentsRepository,
    flags: flagsRepository,
    keys: keysRepository,
    audit: auditRepository,
  };
  const auth = new AuthService({
    db,
    keys: repos.keys,
    rootKey: config.rootKey,
    cacheTtlMs: config.authCacheTtlMs,
  });
  // One LISTEN connection per instance, shared by the ruleset cache and the streams. The
  // cache subscribes first, so it is invalidated before the streams re-read.
  const hub = new ChangeHub(config.changeFeed);
  const ruleset = new RulesetService({ db, ...repos, hub });
  return {
    auth,
    projects: new ProjectsService({ db, ...repos }),
    flags: new FlagsService({
      db,
      ...repos,
      onRulesetChanged: (environmentId) => ruleset.invalidate(environmentId),
    }),
    keys: new KeysService({ db, ...repos, onRevoked: (keyId) => auth.forget(keyId) }),
    audit: new AuditService({ db, ...repos }),
    ruleset,
    stream: new StreamService({
      auth,
      ruleset,
      hub,
      heartbeatMs: config.streamHeartbeatMs,
      onError: config.onError,
    }),
  };
}

export type Services = ReturnType<typeof createServices>;
