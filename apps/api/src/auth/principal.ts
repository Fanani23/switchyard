import type { KeyScope } from '@switchyard/shared';
import { ForbiddenError } from '../errors.js';

/**
 * Who is making a request. API keys are environment-scoped (D1), which leaves nobody able
 * to create the first project or environment; the root key, configured by the operator
 * through `SWITCHYARD_ROOT_KEY`, is that bootstrap identity. See the SPEC.md notes in the PR.
 */
export type Principal =
  | { kind: 'root' }
  | {
      kind: 'key';
      keyId: string;
      environmentId: string;
      projectId: string;
      scope: KeyScope;
    };

/** The audit `actor`: stable, contains no secret, and survives the key being revoked. */
export function actorOf(principal: Principal): string {
  return principal.kind === 'root' ? 'root' : `key:${principal.keyId}`;
}

/** Admin access to one environment: the root key, or an admin key of that environment. */
export function assertAdminOf(principal: Principal, environmentId: string): void {
  if (principal.kind === 'root') return;
  if (principal.scope !== 'admin' || principal.environmentId !== environmentId) {
    throw new ForbiddenError();
  }
}

/** Any admin key, regardless of environment; used for listing the caller's own project. */
export function assertAdmin(principal: Principal): void {
  if (principal.kind === 'key' && principal.scope !== 'admin') throw new ForbiddenError();
}

export function assertRoot(principal: Principal): void {
  if (principal.kind !== 'root') throw new ForbiddenError();
}
