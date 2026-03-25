-- ADVANCE plan permissions and schema migration audit helpers

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_admin;

CREATE TABLE IF NOT EXISTS public.schema_migration_audit (
  id bigserial PRIMARY KEY,
  schema_name text NOT NULL,
  migration_key text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user,
  UNIQUE (schema_name, migration_key)
);

CREATE OR REPLACE FUNCTION app_admin.grant_advance_schema_access(p_schema_name text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM app_admin.validate_tenant_schema_name(p_schema_name);

  EXECUTE format('ALTER SCHEMA %I OWNER TO wms_migrator', p_schema_name);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO wms_app', p_schema_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO wms_app', p_schema_name);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO wms_app', p_schema_name);

  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app', p_schema_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wms_app', p_schema_name);
END;
$$;

CREATE OR REPLACE FUNCTION app_admin.apply_migration_to_all_advance_schemas(
  p_migration_key text,
  p_statement text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  IF p_migration_key IS NULL OR p_migration_key = '' THEN
    RAISE EXCEPTION 'Migration key is required';
  END IF;

  IF p_statement IS NULL OR p_statement = '' THEN
    RAISE EXCEPTION 'Migration SQL statement is required';
  END IF;

  FOR r IN
    SELECT schema_name
    FROM public.tenant_registry
    WHERE plan_code = 'ADVANCE'
      AND status = 'ACTIVE'
      AND schema_name IS NOT NULL
    ORDER BY schema_name
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.schema_migration_audit
      WHERE schema_name = r.schema_name
        AND migration_key = p_migration_key
    ) THEN
      CONTINUE;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(r.schema_name));

    EXECUTE format('SET LOCAL search_path = %I, public', r.schema_name);
    EXECUTE p_statement;

    INSERT INTO public.schema_migration_audit (schema_name, migration_key)
    VALUES (r.schema_name, p_migration_key);
  END LOOP;
END;
$$;

COMMIT;

-- Example migration fan-out:
-- BEGIN;
-- SELECT app_admin.apply_migration_to_all_advance_schemas(
--   '20260302_add_item_hsn_code',
--   'ALTER TABLE items ADD COLUMN IF NOT EXISTS hsn_code text'
-- );
-- COMMIT;
