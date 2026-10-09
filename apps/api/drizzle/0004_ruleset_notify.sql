-- Publish ruleset changes to every API instance.
--
-- The trigger from 0001 already bumps environments.ruleset_version on every change to a
-- flag, variant or rule. It now also NOTIFYs channel `ruleset_changed` with the
-- environment id. NOTIFY is transactional: it is delivered only when the writing
-- transaction commits, and identical payloads within one transaction are collapsed into a
-- single notification. So every API instance LISTENing learns of every committed change
-- exactly when it becomes visible, and no write path can change a ruleset without
-- announcing it (SPEC.md B1, B3).
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
    PERFORM pg_notify('ruleset_changed', target_env::text);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
