'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FlagList } from '@/components/flag-list';
import { ErrorState, SkeletonRows } from '@/components/ui';
import { findEnvironment, useProjects } from '@/lib/use-environment';

export default function FlagListPage() {
  const { slug, envKey } = useParams<{ slug: string; envKey: string }>();
  const [projects, retry] = useProjects();

  if (projects.state === 'loading') return <SkeletonRows count={6} />;
  if (projects.state === 'error')
    return <ErrorState message="Could not load flags" onRetry={retry} />;
  const found = findEnvironment(projects.value, (e, p) => p.slug === slug && e.key === envKey);
  if (!found)
    return (
      <p className="state">
        No environment {envKey} in project {slug}.
      </p>
    );

  const { project, environment } = found;
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/">Projects</Link> / {project.name} / <strong>{environment.name}</strong>
        {' · '}
        <Link href={`/environments/${environment.id}/audit`}>Audit</Link>
        {' · '}
        <Link href={`/environments/${environment.id}/keys`}>Keys</Link>
      </nav>
      <h1>Flags</h1>
      <FlagList environment={environment} />
    </>
  );
}
