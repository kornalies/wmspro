BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'audit_logs'
      AND column_name = 'table_name'
  ) THEN
    ALTER TABLE audit_logs
      ALTER COLUMN table_name DROP NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'audit_logs'
      AND column_name = 'record_id'
  ) THEN
    ALTER TABLE audit_logs
      ALTER COLUMN record_id DROP NOT NULL;
  END IF;
END $$;

COMMIT;
