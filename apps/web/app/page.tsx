'use client';

import Link from 'next/link';
import { ErrorState, SkeletonRows } from '@/components/ui';
import { useProjects } from '@/lib/use-environment';

export default function Home() {
  const [projects, retry] = useProjects();
  const count = projects.state === 'ready' ? projects.value.length : 0;

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">
            {projects.state === 'ready'
              ? `${count} project${count === 1 ? '' : 's'} visible to this key.`
              : 'Every project this key can reach.'}
          </p>
        </div>
      </div>

      {projects.state === 'loading' && <SkeletonRows count={3} />}
      {projects.state === 'error' && <ErrorState message={projects.message} onRetry={retry} />}

      {projects.state === 'ready' && count === 0 && (
        <div className="card empty">
          <h2>No projects yet</h2>
          <p className="muted">
            A project groups environments such as production and staging. Create the first one with
            the root key:
          </p>
          <pre className="diff">
            {`curl -X POST $API/v1/projects \\
  -H "Authorization: Bearer $ROOT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"My app","slug":"my-app"}'`}
          </pre>
        </div>
      )}

      {projects.state === 'ready' &&
        projects.value.map((project, i) => (
          <article key={project.id} className="card stagger" style={{ '--i': i } as React.CSSProperties}>
            <div className="card-head">
              <h2>{project.name}</h2>
              <span className="pill">
                {project.environments.length} environment
                {project.environments.length === 1 ? '' : 's'}
              </span>
            </div>
            <ul className="rows">
              {project.environments.map((env) => (
                <li key={env.id} className="row">
                  <Link href={`/projects/${project.slug}/${env.key}`} className="row-main env-link">
                    <span className="env-name">{env.name}</span>
                    <span className="muted">{env.key}</span>
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
