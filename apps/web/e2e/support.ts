import { randomBytes } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const API = 'http://localhost:4000';
/** Matches SWITCHYARD_ROOT_KEY given to the API server in playwright.config.ts. */
export const ROOT_KEY = 'e2e-root-key-not-a-secret-0123456789abcdef';

async function call<T>(method: string, path: string, body?: unknown, key = ROOT_KEY): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  patch: (flagId: string, body: unknown) => call('PATCH', `/v1/flags/${flagId}`, body),
  rules: (flagId: string, rules: unknown[]) => call('PUT', `/v1/flags/${flagId}/rules`, { rules }),
  flag: (flagId: string) =>
    call<{ enabled: boolean; rules: unknown[]; default: string }>('GET', `/v1/flags/${flagId}`),
};

export interface World {
  slug: string;
  staging: { id: string; flags: Record<string, string> };
  production: { id: string; flags: Record<string, string> };
}

/**
 * A fresh project per test, so tests never see each other's flags. Each environment gets
 * the given boolean flags; `rules` lets a test set a rollout up front.
 */
export async function world(
  flags: Array<{ key: string; enabled?: boolean; default?: 'on' | 'off'; rules?: unknown[] }>,
): Promise<World> {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  const project = await call<{ id: string }>('POST', '/v1/projects', { name: `E2E ${slug}`, slug });
  const out = { slug } as World;
  for (const key of ['staging', 'production'] as const) {
    const env = await call<{ id: string }>('POST', `/v1/projects/${project.id}/environments`, {
      name: key[0]!.toUpperCase() + key.slice(1),
      key,
    });
    const ids: Record<string, string> = {};
    for (const f of flags) {
      const created = await call<{ id: string }>('POST', `/v1/environments/${env.id}/flags`, {
        kind: 'boolean',
        key: f.key,
        default: f.default ?? 'off',
        enabled: f.enabled ?? true,
      });
      if (f.rules) await api.rules(created.id, f.rules);
      ids[f.key] = created.id;
    }
    out[key] = { id: env.id, flags: ids };
  }
  return out;
}

export async function signIn(page: Page, key = ROOT_KEY) {
  await page.goto('/');
  await page.getByLabel('API key').fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
}

export async function openFlags(page: Page, w: World, env: 'staging' | 'production') {
  await page.goto(`/projects/${w.slug}/${env}`);
  await expect(page.getByRole('heading', { name: 'Flags' })).toBeVisible();
}
