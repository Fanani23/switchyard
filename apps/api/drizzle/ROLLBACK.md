# Rollback paths

Drizzle generates no `down` step, so every reversal is a new forward migration. This file
records what each applied migration would take to undo, written at the time it was added
rather than reconstructed under pressure.

## 0003_audit_no_truncate

Drops one trigger and its function. Reversible with no data loss.

```sql
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
DROP FUNCTION IF EXISTS reject_audit_truncate();
```

**Consequences of rolling this back:** `TRUNCATE audit_log` once again erases the entire
log, including entries inside the 90-day window, despite the row-level append-only trigger.

## 0002_audit_entity_index

Adds one index; drops nothing. Reversible with no data loss.

```sql
DROP INDEX IF EXISTS audit_log_entity_created_idx;
```

**Consequences of rolling this back:** the flag list's "last changed by" lookup falls back
to scanning the environment's audit rows. Correct, but slower as the log grows.

## 0001_triggers

Drops three database-enforced invariants. Reversible with no data loss.

```sql
DROP TRIGGER IF EXISTS flags_bump_version ON flags;
DROP TRIGGER IF EXISTS variants_bump_version ON variants;
DROP TRIGGER IF EXISTS rules_bump_version ON rules;
DROP FUNCTION IF EXISTS bump_ruleset_version();

DROP TRIGGER IF EXISTS audit_log_is_append_only ON audit_log;
DROP FUNCTION IF EXISTS reject_audit_mutation();

DROP TRIGGER IF EXISTS flags_default_variant_exists ON flags;
DROP FUNCTION IF EXISTS check_default_variant_exists();
```

**Consequences of rolling this back:**

- `environments.ruleset_version` stops advancing, so connected SDKs will not learn about
  flag changes. Deploy an API that bumps the version in application code *before* dropping
  the trigger, or propagation silently stops while everything still looks healthy.
- `audit_log` becomes editable and deletable. Any compliance claim that rests on the log
  being append-only no longer holds from that moment.
- A flag may be written with a `default_variant` that matches no variant. SDKs will fall
  through to the caller-supplied fallback for that flag.

## 0000 (initial schema)

Reversing this drops every table and all data. There is no safe automated rollback. If the
schema must be abandoned, take a `pg_dump` first, then:

```sql
DROP TABLE IF EXISTS audit_log, api_keys, rules, variants, flags, environments, projects CASCADE;
DROP TYPE IF EXISTS flag_kind, rule_kind, key_scope;
```

`audit_log` has no foreign key by design, so it is not removed by any cascade and must be
dropped explicitly. That is the same property that makes it survive environment deletion.

## Rules for future migrations

1. Add the rollback SQL to this file in the same commit that adds the migration.
2. Destructive changes (dropping or narrowing a column) ship across two releases: first
   deploy code that stops reading the column, then drop it. A single release makes the
   rollback lossy.
3. Never edit a migration that has been applied anywhere. Add a new one.
4. A migration that cannot be reversed without data loss must say so here, explicitly.
