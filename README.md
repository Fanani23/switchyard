# Switchyard

> Feature flags for teams that ship continuously: turn a feature on for a chosen slice of
> users in production without a deploy. See [SPEC.md](SPEC.md) and [UX.md](UX.md).

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
a repository never decides. The evaluation engine (`apps/api/src/evaluation`) sits beside
the layers, not in them: it is pure, imports neither the database nor HTTP, and is what an
in-process SDK runs.

## Trade-offs

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Validation | Zod schemas shared by web and API | hand-written checks | One contract, parsed at the boundary, reused as the OpenAPI spec |
| Pagination | keyset cursor | `OFFSET` | Stable under concurrent inserts and stays fast on large tables |
| Primary key | `uuid` | `serial` | Ids are not guessable and not enumerable in URLs |
| Timestamps | `timestamptz` | `timestamp` | Bare `timestamp` silently drops the offset and breaks across regions |
| Error detail | field-level on 4xx, opaque on 5xx | uniform messages | Clients can fix their request; internals never leak |
| Evaluation | in the SDK, from a cached ruleset | one API call per check | Microseconds per check, keeps working when the API is down (SPEC.md) |
| Key storage | SHA-256 only, plaintext shown once | encrypted at rest | A database leak yields no working credential; nothing needs to be decrypted |
| Auth cache | 30 s TTL, dropped on local revoke | lookup per request | Off the hot path, still inside SPEC.md's 60 s revocation bound (D4) |
| Size limits | 422 `{error, limit, actual}` | 400 with the rest | The request is well-formed, just bigger than allowed; the client needs the number |

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
  evaluation/     pure engine: murmur3, bucket, evaluate (no db, no http)
  http/           route registration and shared response schemas
  auth/           key generation and hashing, principal, auth service with TTL cache
  projects/ flags/ keys/ audit/ ruleset/ environments/
                  one slice each: *.repository.ts (read/write) and *.service.ts (decide)
  container.ts    wires repositories into services
apps/api/test             Unit tests; no database
apps/api/test-integration Integration tests; real PostgreSQL required
packages/shared   Zod request/response contracts shared by web and api
packages/config   Base tsconfig
```

## Setup

```bash
pnpm install
cp .env.example .env                            # set SWITCHYARD_ROOT_KEY
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

Verified by tests in `apps/api/test/app.test.ts` and `apps/api/test-integration/auth.test.ts`:

- Helmet security headers, CORS restricted to `CORS_ORIGINS`, rate limiting, `BODY_LIMIT`.
- Every request body and query parsed by a Zod schema at the boundary.
- 5xx responses never carry the internal message; 4xx carry field-level detail.
- All queries parameterized through Drizzle; no string-built SQL.
- Secrets come from the environment, validated at startup in `env.ts`. `.env` is gitignored.
- CI runs `pnpm audit --audit-level high` and a gitleaks secret scan.

**Authorization.** Every `/v1` route authenticates in an `onRequest` hook, before the body
is parsed, with `Authorization: Bearer <key>`. Keys belong to one environment and carry a
scope: `admin` keys use the Admin API for their own environment, `client` keys read only
`/v1/ruleset`. Creating projects and environments needs the root key
(`SWITCHYARD_ROOT_KEY`), because no environment-scoped key can create the environment it
would belong to. Services, not routes, decide access.

## Deploy

- **API (Fly.io):** `flyctl deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile`.
  CI deploys on `main` when the repo variable `DEPLOY=true` and secret `FLY_API_TOKEN` are set.
  Roll back with `flyctl releases` then `flyctl deploy --image <previous>`.
- **Web (Vercel):** import the repo, set the root directory to `apps/web`, set `NEXT_PUBLIC_API_URL`.

## Using this as a template

Copy the repo, rename the `@switchyard/*` scope, rename the app in `apps/api/fly.toml`, then
replace the `examples` slice end to end: schema, repository, service, routes, contracts in
`packages/shared`, and the page in `apps/web/app`. Keep the layering and the five-state UI.
