-- Close the TRUNCATE gap in the append-only audit log.
--
-- 0001 rejects UPDATE and in-window DELETE with a row-level trigger, but row-level triggers
-- do not fire on TRUNCATE, which removes every row at once. Found in Stage 4 by testing
-- against PostgreSQL 17: `TRUNCATE audit_log` erased entries written seconds earlier.
-- A statement-level BEFORE TRUNCATE trigger is the only hook PostgreSQL offers for it.
--
-- Retention cleanup is unaffected: it uses DELETE, which 0001 already permits past 90 days.
CREATE OR REPLACE FUNCTION reject_audit_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_truncate();
