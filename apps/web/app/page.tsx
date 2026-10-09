'use client';

import Link from 'next/link';
import { ErrorState, SkeletonRows } from '@/components/ui';
import { useProjects } from '@/lib/use-environment';

export default function Home() {
  const [projects, retry] = useProjects();
  return (
    <section>
      <h1>Projects</h1>
      {projects.state === 'loading' && <SkeletonRows count={3} />}
      {projects.state === 'error' && <ErrorState message={projects.message} onRetry={retry} />}
      {projects.state === 'ready' && projects.value.length === 0 && (
        <p className="state">
          No projects yet. Create one with the root key through the Admin API.
        </p>
      )}
      {projects.state === 'ready' &&
        projects.value.map((project) => (
          <article key={project.id} className="card">
            <h2>{project.name}</h2>
            <ul className="rows">
              {project.environments.map((env) => (
                <li key={env.id} className="row">
                  <Link href={`/projects/${project.slug}/${env.key}`} className="row-main">
                    {env.name} <span className="muted">({env.key})</span>
                  </Link>
                  <span className="row-meta">
                    <Link href={`/environments/${env.id}/audit`}>Audit</Link>
                    {' · '}
                    <Link href={`/environments/${env.id}/keys`}>Keys</Link>
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}
    </section>
  );
}
