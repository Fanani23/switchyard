'use client';

import { useParams } from 'next/navigation';
import { FlagDetail } from '@/components/flag-detail';
import { findEnvironment, useProjects } from '@/lib/use-environment';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import type { EnvironmentDto } from '@switchyard/shared';

export default function FlagPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useSession();
  const [projects] = useProjects();
  const [environmentId, setEnvironmentId] = useState<string | null>(null);

  // The environment decides how much friction a toggle gets (production or not).
  useEffect(() => {
    if (!api) return;
    const abort = new AbortController();
    api
      .getFlag(id, abort.signal)
      .then((f) => setEnvironmentId(f.environmentId))
      .catch(() => {});
    return () => abort.abort();
  }, [api, id]);

  let environment: EnvironmentDto | null = null;
  if (projects.state === 'ready' && environmentId) {
    environment =
      findEnvironment(projects.value, (e) => e.id === environmentId)?.environment ?? null;
  }
  return <FlagDetail flagId={id} environment={environment} />;
}
