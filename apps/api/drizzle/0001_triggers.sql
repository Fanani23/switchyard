-- Database-enforced invariants that the application layer must not be trusted to maintain.

-- 1. Ruleset version.
--    Every change to a flag, variant or rule bumps its environment's ruleset_version.
--    Enforced here rather than in a service so that no write path, migration or manual
--    fix can leave SDKs holding a stale ruleset while believing it is current.
CREATE OR REPLACE FUNCTION bump_ruleset_version() RETURNS trigger AS $$
DECLARE
  target_env uuid;
  target_flag uuid;
BEGIN
  IF TG_TABLE_NAME = 'flags' THEN
    target_env := COALESCE(NEW.environment_id, OLD.environment_id);
  ELSE
    target_flag := COALESCE(NEW.flag_id, OLD.flag_id);
    SELECT environment_id INTO target_env FROM flags WHERE id = target_flag;
  END IF;

  IF target_env IS NOT NULL THEN
    UPDATE environments
       SET ruleset_version = ruleset_version + 1
     WHERE id = target_env;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER flags_bump_version
AFTER INSERT OR UPDATE OR DELETE ON flags
FOR EACH ROW EXECUTE FUNCTION bump_ruleset_version();
--> statement-breakpoint

CREATE TRIGGER variants_bump_version
AFTER INSERT OR UPDATE OR DELETE ON variants
FOR EACH ROW EXECUTE FUNCTION bump_ruleset_version();
--> statement-breakpoint

CREATE TRIGGER rules_bump_version
AFTER INSERT OR UPDATE OR DELETE ON rules
FOR EACH ROW EXECUTE FUNCTION bump_ruleset_version();
--> statement-breakpoint

-- 2. Append-only audit log.
--    An audit trail the application can rewrite proves nothing. Enforcing this in the
--    database means a compromised API cannot erase its own tracks, and the guarantee holds
--    for psql and migrations too, not only for code that goes through the service layer.
CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
  -- UPDATE is never permitted: rewriting history is exactly what this prevents.
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted'
      USING ERRCODE = 'check_violation';
  END IF;

  -- DELETE is permitted only past the retention window, so the scheduled cleanup can run
  -- while a compromised API still cannot erase what it just did.
  IF OLD.created_at > now() - interval '90 days' THEN
    RAISE EXCEPTION 'audit_log is append-only: entries within 90 days cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_is_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint

-- 3. Default variant must exist.
--    A flag whose default_variant names no variant would evaluate to a value the SDK
--    cannot serve. Deferred to a constraint trigger because a flag and its variants are
--    inserted in the same transaction, so a foreign key would reject the flag before its
--    variants land.
CREATE OR REPLACE FUNCTION check_default_variant_exists() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM variants v WHERE v.flag_id = NEW.id AND v.key = NEW.default_variant
  ) THEN
    RAISE EXCEPTION 'flag %: default_variant "%" is not one of its variants',
      NEW.key, NEW.default_variant
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER flags_default_variant_exists
AFTER INSERT OR UPDATE ON flags
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_default_variant_exists();
