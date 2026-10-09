'use client';

import { useCallback, useEffect, useState } from 'react';
import type { EnvironmentDto } from '@switchyard/shared';
import { isAbort, type ProjectWithEnvironments } from './api';
import { useSession } from './session';

export type Load<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

/** Projects with their environments: the sidebar, and how URLs resolve to ids. */
export function useProjects(): [Load<ProjectWithEnvironments[]>, () => void] {
  const { api } = useSession();
  const [load, setLoad] = useState<Load<ProjectWithEnvironments[]>>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    setLoad({ state: 'loading' });
    api
      .listProjects(abort.signal)
      .then((r) => setLoad({ state: 'ready', value: r.items }))
      .catch((err: unknown) => {
        if (!isAbort(err)) setLoad({ state: 'error', message: 'Could not load projects' });
      });
    return () => abort.abort();
  }, [api, attempt]);
  return [load, useCallback(() => setAttempt((n) => n + 1), [])];
}

export function findEnvironment(
  projects: ProjectWithEnvironments[],
  match: (env: EnvironmentDto, project: ProjectWithEnvironments) => boolean,
): { project: ProjectWithEnvironments; environment: EnvironmentDto } | null {
  for (const project of projects) {
    for (const environment of project.environments) {
      if (match(environment, project)) return { project, environment };
    }
  }
  return null;
}
