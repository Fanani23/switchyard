import type {
  ApiKeyDto,
  AuditEntryDto,
  CreateFlagBody,
  EnvironmentDto,
  FlagDto,
  ProjectDto,
  Rule,
} from '@switchyard/shared';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);

export type ProjectWithEnvironments = ProjectDto & { environments: EnvironmentDto[] };

/** An HTTP error from the API, with the body the error table promises. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: {
      error?: string;
      current?: FlagDto;
      details?: Array<{ path: string; message: string }>;
    } | null,
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * The Admin API, bound to one key. Every call takes an AbortSignal: a superseded request is
 * aborted, never allowed to resolve into state (UX.md, interaction budget).
 */
export function createApi(apiKey: string) {
  async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      signal: opts.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, json as ApiError['body']);
    return json as T;
  }

  return {
    listProjects: (signal?: AbortSignal) =>
      request<{ items: ProjectWithEnvironments[] }>('GET', '/v1/projects', { signal }),
    listFlags: (
      envId: string,
      q: { q?: string; cursor?: string; limit?: number },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams();
      if (q.q) params.set('q', q.q);
      if (q.cursor) params.set('cursor', q.cursor);
      params.set('limit', String(q.limit ?? 50));
      return request<{ items: FlagDto[]; total: number; nextCursor: string | null }>(
        'GET',
        `/v1/environments/${envId}/flags?${params}`,
        { signal },
      );
    },
    createFlag: (envId: string, body: CreateFlagBody) =>
      request<FlagDto>('POST', `/v1/environments/${envId}/flags`, { body }),
    getFlag: (id: string, signal?: AbortSignal) =>
      request<FlagDto>('GET', `/v1/flags/${id}`, { signal }),
    patchFlag: (
      id: string,
      body: { enabled?: boolean; default?: string; key?: string; expectedUpdatedAt?: string },
    ) => request<FlagDto>('PATCH', `/v1/flags/${id}`, { body }),
    putRules: (id: string, rules: Rule[], expectedUpdatedAt?: string) =>
      request<FlagDto>('PUT', `/v1/flags/${id}/rules`, { body: { rules, expectedUpdatedAt } }),
    deleteFlag: (id: string) => request<void>('DELETE', `/v1/flags/${id}`),
    listAudit: (envId: string, cursor: string | undefined, signal?: AbortSignal) =>
      request<{ items: AuditEntryDto[]; nextCursor: string | null }>(
        'GET',
        `/v1/environments/${envId}/audit?limit=25${cursor ? `&cursor=${cursor}` : ''}`,
        { signal },
      ),
    listKeys: (envId: string, signal?: AbortSignal) =>
      request<{ items: ApiKeyDto[] }>('GET', `/v1/environments/${envId}/keys`, { signal }),
    createKey: (envId: string, body: { name: string; scope: 'admin' | 'client' }) =>
      request<ApiKeyDto & { key: string }>('POST', `/v1/environments/${envId}/keys`, { body }),
    revokeKey: (id: string) => request<void>('DELETE', `/v1/keys/${id}`),
  };
}

export type Api = ReturnType<typeof createApi>;
