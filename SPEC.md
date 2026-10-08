# Switchyard — Specification

Stage 1 of the universal development pipeline. No implementation begins until the
acceptance criteria below each map to a named test.

## Outcome

Turn a feature on for a chosen slice of users in production without deploying code, and
have every running application see the change in under a second.

## The central design decision

**SDKs evaluate flags locally, not over the network.**

The SDK fetches the whole ruleset for its environment once, holds it in memory, and
evaluates in process. A flag check is a map lookup and a hash — microseconds, no network,
no failure mode. Rule changes arrive by Server-Sent Events, so the cache stays fresh.

| | Local evaluation (chosen) | Remote evaluation per check |
| --- | --- | --- |
| Latency per check | microseconds, in process | one network round trip |
| API load | one connection per instance | one request per check |
| Behavior when API is down | keeps working on the cached ruleset | every check fails or blocks |
| Cost of a rule change | one SSE push per connected client | none |
| User identity leaves the app | never | on every check |

The cost is that the ruleset must be small enough to ship whole, and a client can serve a
stale ruleset for as long as it is disconnected. Both are acceptable; neither is true of
the alternative's failure mode.

## Scope

A project contains environments (`production`, `staging`, …). An environment contains
flags. A flag has a default value and an ordered list of rules. The first matching rule
wins; if none match, the default applies.

**Flag kinds**
- `boolean` — on or off.
- `multivariate` — one of several named variants, each with a weight.

**Rule kinds**
- `segment` — match on user attributes (`country == "ID"`, `plan in ["pro","team"]`).
- `percentage` — match a stable share of users, by hashing the user key.

### Out of scope

Named here so the work cannot quietly expand: billing and plans, SSO, scheduled or
time-boxed rollouts, approval workflows, experiment statistics and significance testing,
flag dependencies, mobile SDKs, and self-hosted relay proxies.

## Acceptance criteria

Each line is one assertion, and each names the test that must exist.

### Evaluation correctness

| # | Assertion | Test |
| --- | --- | --- |
| A1 | The same user key and ruleset always yield the same variant | `evaluate.deterministic` |
| A2 | With no matching rule, the flag's default is returned | `evaluate.falls-back-to-default` |
| A3 | Rules are applied in order; the first match wins | `evaluate.first-rule-wins` |
| A4 | A 10% rollout assigns between 9% and 11% of 10,000 keys | `evaluate.rollout-distribution` |
| A5 | Changing a flag's rollout from 10% to 20% keeps every user already inside the 10% | `evaluate.rollout-is-monotonic` |
| A6 | Two flags at 50% in the same environment do not assign the same users together | `evaluate.no-cross-flag-correlation` |
| A7 | A segment rule matches only users whose attributes satisfy every clause | `evaluate.segment-all-clauses` |
| A8 | An unknown user attribute never matches, and never throws | `evaluate.unknown-attribute` |

A5 matters because it is what makes a gradual rollout safe: users must never be moved
*out* of a feature as the percentage grows. A6 matters because correlated assignment would
silently invalidate every result the flags are used to measure.

### Propagation

| # | Assertion | Test |
| --- | --- | --- |
| B1 | A flag change reaches a connected SDK in under 1 second | `stream.propagates-under-1s` |
| B2 | An SDK that reconnects after downtime receives the current ruleset | `stream.resync-on-reconnect` |
| B3 | A change made against one API instance reaches clients on another instance | `stream.fans-out-across-instances` |
| B4 | A dropped connection retries with backoff and does not spin | `stream.reconnect-backoff` |

### Resilience

| # | Assertion | Test |
| --- | --- | --- |
| C1 | With the API unreachable at startup, the SDK returns caller-supplied defaults | `sdk.cold-start-offline` |
| C2 | With the API unreachable after a successful fetch, the SDK serves the cached ruleset | `sdk.warm-offline` |
| C3 | The SDK never throws from an evaluation call, whatever its state | `sdk.evaluation-never-throws` |

### Access control

| # | Assertion | Test |
| --- | --- | --- |
| D1 | An API key scoped to `staging` cannot read `production` flags | `auth.key-is-environment-scoped` |
| D2 | A client key can read the ruleset but cannot modify a flag | `auth.client-key-is-read-only` |
| D3 | A request with no key, or an unknown key, is rejected with 401 | `auth.rejects-missing-and-unknown-keys` |
| D4 | A revoked key stops working within 60 seconds | `auth.revocation-takes-effect` |

### Auditability

| # | Assertion | Test |
| --- | --- | --- |
| E1 | Every flag change records actor, timestamp, before and after | `audit.records-change` |
| E2 | Audit entries cannot be edited or deleted through the API | `audit.is-append-only` |

### Performance

| # | Assertion | Test |
| --- | --- | --- |
| F1 | `GET /ruleset` serves p99 under 50 ms at 500 requests/second | `load.ruleset-p99` |
| F2 | In-process evaluation of 1,000,000 flag checks completes under 1 second | `bench.evaluation-throughput` |
| F3 | 1,000 concurrent SSE connections stay open for 5 minutes with no leak | `load.sse-connection-ceiling` |

## Limits

Stated now so they are enforced, not discovered.

| Limit | Value | Enforced at |
| --- | --- | --- |
| Flags per environment | 500 | Create endpoint |
| Rules per flag | 20 | Validation schema |
| Variants per flag | 10 | Validation schema |
| Clauses per segment rule | 10 | Validation schema |
| Flag key length | 64 characters, `[a-z0-9-_.]` | Validation schema |
| Request body | 256 KB | Fastify `bodyLimit` |
| Admin API rate | 100 requests/minute per key | Rate limiter |
| Ruleset read rate | 1,000 requests/minute per key | Rate limiter |
| SSE connections | 50 per API key | Connection registry |
| SSE idle heartbeat | 30 seconds | Stream handler |
| Audit retention | 90 days | Scheduled cleanup |

## Error cases

| Condition | Status | Body |
| --- | --- | --- |
| Malformed body or query | 400 | `{error, details:[{path,message}]}` |
| Missing or unknown API key | 401 | `{error:"Unauthorized"}` |
| Key valid but wrong environment or scope | 403 | `{error:"Forbidden"}` |
| Unknown flag or environment | 404 | `{error:"Not found"}` |
| Duplicate flag key in an environment | 409 | `{error:"Flag key already exists"}` |
| Limit exceeded (table above) | 422 | `{error, limit, actual}` |
| Rate limit exceeded | 429 | `{error}` + `Retry-After` |
| Anything unexpected | 500 | `{error:"Internal Server Error"}` — never a detail |

## Interface contract

Two surfaces with different audiences and different keys.

### Admin API — dashboard, server key, read/write

```
POST   /v1/projects                          create a project
GET    /v1/projects
POST   /v1/projects/:projectId/environments
GET    /v1/environments/:envId/flags         list flags with their rules
POST   /v1/environments/:envId/flags         create a flag
GET    /v1/flags/:flagId
PATCH  /v1/flags/:flagId                     rename, change default, enable/disable
PUT    /v1/flags/:flagId/rules               replace the ordered rule list
DELETE /v1/flags/:flagId
GET    /v1/environments/:envId/audit         paginated, newest first
POST   /v1/environments/:envId/keys          mint an API key
DELETE /v1/keys/:keyId                       revoke
```

### Client API — SDKs, client key, read-only

```
GET    /v1/ruleset        the whole evaluable ruleset for the key's environment
GET    /v1/stream         SSE; emits `ruleset` on every change, `ping` every 30s
```

`GET /v1/ruleset` returns:

```json
{
  "environmentId": "uuid",
  "version": 42,
  "flags": [
    {
      "key": "new-checkout",
      "kind": "multivariate",
      "default": "control",
      "variants": [{ "key": "control" }, { "key": "treatment" }],
      "rules": [
        { "kind": "segment", "clauses": [{ "attribute": "plan", "op": "in", "values": ["pro"] }], "serve": "treatment" },
        { "kind": "percentage", "weights": { "control": 90, "treatment": 10 }, "salt": "a1b2" }
      ]
    }
  ]
}
```

`version` increments on every change. An SDK that already holds `version` 42 ignores a
push for 42, which makes redelivery harmless.

### SDK surface

```ts
const client = new Switchyard({ apiKey, fallbacks: { 'new-checkout': 'control' } });
await client.ready();                                  // resolves on first ruleset, or on timeout
client.variant('new-checkout', { key: userId, plan }); // string, never throws
client.enabled('dark-mode', { key: userId });          // boolean, never throws
client.close();
```

## Assignment algorithm

Fixed here so that A1, A4, A5 and A6 are provable rather than incidental.

```
bucket(flagSalt, userKey) = (murmur3_32(flagSalt + ":" + userKey) % 10000) / 100   // 0.00–99.99
```

Variants occupy contiguous ranges in declared order: with weights 90/10, `control` holds
`[0, 90)` and `treatment` holds `[90, 100)`.

- **A1** holds because the hash is pure.
- **A5** holds because raising a weight only extends a range upward; nobody already inside
  it is displaced.
- **A6** holds because `flagSalt` is unique per flag, so two flags hash the same user to
  independent buckets.

## Stage 1 exit gate

Every assertion in the tables above names a test. None of those tests exist yet. That is
the required state at the end of Stage 1 — the gate is that the criteria are *testable*,
not that they pass.

Next: Stage 2, the data model and migration.
