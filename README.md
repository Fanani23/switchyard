# Project Name

> One-line pitch: what it does and for whom.

**Live demo:** <link> · **API docs:** <link>/docs · **CI:** ![CI](badge-url)

## Architecture

```mermaid
flowchart LR
  Client[Next.js web] -->|HTTPS| API[Fastify API]
  API --> SVC[Service layer]
  SVC --> REPO[Repository]
  REPO --> PG[(PostgreSQL)]
  API --> R[(Redis)]
```

Layers run one way only: route → service → repository → database. A route never queries;
a repository never decides. Replace this diagram per project.

## Trade-offs

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Validation | Zod schemas shared by web and API | hand-written checks | One contract, parsed at the boundary, reused as the OpenAPI spec |
| Pagination | keyset cursor | `OFFSET` | Stable under concurrent inserts and stays fast on large tables |
| Primary key | `uuid` | `serial` | Ids are not guessable and not enumerable in URLs |
| Timestamps | `timestamptz` | `timestamp` | Bare `timestamp` silently drops the offset and breaks across regions |
| Error detail | field-level on 4xx, opaque on 5xx | uniform messages | Clients can fix their request; internals never leak |

## Results

Benchmarks, load-test numbers, eval scores. Real numbers only.

## Stack

pnpm workspaces · Next.js · Fastify · PostgreSQL (Drizzle) · Redis · Vitest · Playwright · GitHub Actions · Docker · Fly.io / Vercel

## Layout

```
apps/web          Next.js frontend; app/examples-list.tsx is the five-state reference
apps/api/src
  app.ts          Fastify wiring: helmet, CORS, rate limit, error handler
  env.ts          Environment parsed and validated at startup
  db/             Drizzle schema, client, migration runner
  examples/       routes -> service -> repository, one example slice
apps/api/test             Unit tests; no database
apps/api/test-integration Integration tests; real PostgreSQL required
packages/shared   Zod request/response contracts shared by web and api
packages/config   Base tsconfig
```

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d                            # Postgres + Redis
pnpm --filter @switchyard/api db:migrate
pnpm -r --parallel run dev                      # web :3000, api :4000
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm -r run lint` | ESLint |
| `pnpm -r run typecheck` | TypeScript strict check |
| `pnpm -r run test` | Vitest unit tests, no database |
| `pnpm --filter @switchyard/api test:integration` | Integration tests against real PostgreSQL |
| `pnpm --filter @switchyard/web e2e` | Playwright E2E |
| `pnpm --filter @switchyard/api openapi` | Regenerate `openapi.json` |
| `pnpm --filter @switchyard/api db:generate` | Create a migration from the schema |

On Windows, run the `pnpm -r` forms above. The root aggregate scripts (`pnpm test`,
`pnpm build`) fail under some pnpm shims that cannot spawn a nested pnpm; CI runs Linux
and is unaffected.

## Database migrations

Migrations are forward-only SQL in `apps/api/drizzle/`, applied in journal order.

- **Apply:** `pnpm --filter @switchyard/api db:migrate`
- **Never edit an applied migration.** Add a new one; editing desynchronizes the journal
  against databases that already ran it.
- **Rollback:** write a new forward migration that reverses the change, and deploy it the
  same way. Drizzle generates no `down` step, so this is the only reversal path.
- **Destructive changes** (dropping or narrowing a column) ship in two releases: first
  deploy code that stops using the column, then drop it in the next release. A single
  release makes rollback lossy.
- CI applies every migration to an empty PostgreSQL before the integration tests, so a
  migration that does not apply fails the build.

## Security baseline

Carried by the template, verified by tests in `apps/api/test/app.test.ts`:

- Helmet security headers, CORS restricted to `CORS_ORIGINS`, rate limiting, `BODY_LIMIT`.
- Every request body and query parsed by a Zod schema at the boundary.
- 5xx responses never carry the internal message; 4xx carry field-level detail.
- All queries parameterized through Drizzle; no string-built SQL.
- Secrets come from the environment, validated at startup in `env.ts`. `.env` is gitignored.
- CI runs `pnpm audit --audit-level high` and a gitleaks secret scan.

**Per project, replace the authorization comment in `examples.routes.ts` with the real
rule and add a `preHandler`.** The template ships these routes public because it has no
users; a project that keeps them public has skipped a decision rather than made one.

## Deploy

- **API (Fly.io):** `flyctl deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile`.
  CI deploys on `main` when the repo variable `DEPLOY=true` and secret `FLY_API_TOKEN` are set.
  Roll back with `flyctl releases` then `flyctl deploy --image <previous>`.
- **Web (Vercel):** import the repo, set the root directory to `apps/web`, set `NEXT_PUBLIC_API_URL`.

## Using this as a template

Copy the repo, rename the `@switchyard/*` scope, rename the app in `apps/api/fly.toml`, then
replace the `examples` slice end to end: schema, repository, service, routes, contracts in
`packages/shared`, and the page in `apps/web/app`. Keep the layering and the five-state UI.
