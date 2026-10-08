import { randomBytes } from 'node:crypto';
import { buildApp, type AppOptions } from '../src/app.js';
import type { AppInstance } from '../src/types.js';

export const ROOT_KEY = `root-${randomBytes(24).toString('hex')}`;

/** Rate limits are raised so tests exercise behavior, not the limiter, unless they mean to. */
export async function testApp(opts: AppOptions = {}): Promise<AppInstance> {
  const app = await buildApp({
    logLevel: 'silent',
    rootKey: ROOT_KEY,
    rateLimits: { admin: 100_000, ruleset: 100_000 },
    ...opts,
  });
  await app.ready();
  return app;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Res<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export async function call<T = Record<string, unknown>>(
  app: AppInstance,
  method: Method,
  url: string,
  key: string | null,
  payload?: unknown,
): Promise<Res<T>> {
  const res = await app.inject({
    method,
    url,
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : null) as T,
    headers: res.headers,
  };
}

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString('hex')}`;
}

export interface Env {
  id: string;
  key: string;
  adminKey: string;
  adminKeyId: string;
  clientKey: string;
  clientKeyId: string;
}

export interface World {
  projectId: string;
  production: Env;
  staging: Env;
}

async function mintKey(app: AppInstance, envId: string, scope: 'admin' | 'client') {
  const res = await call<{ id: string; key: string }>(
    app,
    'POST',
    `/v1/environments/${envId}/keys`,
    ROOT_KEY,
    {
      name: `${scope} key`,
      scope,
    },
  );
  if (res.status !== 201)
    throw new Error(`mint ${scope} key: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A fresh project with production and staging, each with an admin and a client key. */
export async function createWorld(app: AppInstance): Promise<World> {
  const project = await call<{ id: string }>(app, 'POST', '/v1/projects', ROOT_KEY, {
    name: 'Test project',
    slug: uniqueSlug('proj'),
  });
  if (project.status !== 201) throw new Error(`create project: ${project.status}`);

  const env = async (key: string): Promise<Env> => {
    const created = await call<{ id: string }>(
      app,
      'POST',
      `/v1/projects/${project.body.id}/environments`,
      ROOT_KEY,
      { name: key, key },
    );
    if (created.status !== 201) throw new Error(`create env: ${created.status}`);
    const admin = await mintKey(app, created.body.id, 'admin');
    const client = await mintKey(app, created.body.id, 'client');
    return {
      id: created.body.id,
      key,
      adminKey: admin.key,
      adminKeyId: admin.id,
      clientKey: client.key,
      clientKeyId: client.id,
    };
  };

  return {
    projectId: project.body.id,
    production: await env('production'),
    staging: await env('staging'),
  };
}

export interface FlagBody {
  id: string;
  key: string;
  default: string;
  enabled: boolean;
  updatedAt: string;
  rules: unknown[];
  variants: Array<{ key: string }>;
  lastChangedBy: string | null;
}

export async function createBooleanFlag(
  app: AppInstance,
  env: Env,
  key: string,
): Promise<FlagBody> {
  const res = await call<FlagBody>(app, 'POST', `/v1/environments/${env.id}/flags`, env.adminKey, {
    kind: 'boolean',
    key,
  });
  if (res.status !== 201) throw new Error(`create flag: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
