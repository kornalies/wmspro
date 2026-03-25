-- Run as DB owner/superuser (for example: postgres) on target DB.
-- Purpose:
-- 1) Ensure migrator can create/alter objects in public schema.
-- 2) Transfer unsafe public view/matview ownership from superuser/bypass roles to wms_migrator.
-- 3) Transfer ONLY NON-SECURITY-DEFINER public functions from superuser/bypass roles to wms_migrator.
-- Notes:
-- - SECURITY DEFINER functions are intentionally NOT modified by default; review manually if needed.

BEGIN;

-- Ensure migrator can create schema_migrations and apply SQL migrations in public schema.
GRANT USAGE, CREATE ON SCHEMA public TO wms_migrator;

-- Transfer ownership of public views/materialized views owned by superuser/bypass roles.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind, r.rolname AS owner_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
      AND (r.rolsuper OR r.rolbypassrls)
  LOOP
    IF rec.relkind = 'v' THEN
      RAISE NOTICE 'Changing owner of VIEW %.% (was %) -> wms_migrator', rec.schema_name, rec.object_name, rec.owner_role;
      EXECUTE format('ALTER VIEW %I.%I OWNER TO wms_migrator', rec.schema_name, rec.object_name);
    ELSIF rec.relkind = 'm' THEN
      RAISE NOTICE 'Changing owner of MATVIEW %.% (was %) -> wms_migrator', rec.schema_name, rec.object_name, rec.owner_role;
      EXECUTE format('ALTER MATERIALIZED VIEW %I.%I OWNER TO wms_migrator', rec.schema_name, rec.object_name);
    END IF;
  END LOOP;
END
$$;

-- Transfer ownership of ONLY NON-SECURITY-DEFINER public functions owned by superuser/bypass roles.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_get_function_identity_arguments(p.oid) AS args,
      r.rolname AS owner_role,
      p.prosecdef AS is_security_definer
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND (r.rolsuper OR r.rolbypassrls)
  LOOP
    IF rec.is_security_definer THEN
      -- Do not modify SECURITY DEFINER functions automatically.
      RAISE NOTICE 'Skipping SECURITY DEFINER FUNCTION %.%(%) owned by % (manual review required)',
        rec.schema_name, rec.function_name, rec.args, rec.owner_role;
    ELSE
      RAISE NOTICE 'Changing owner of FUNCTION %.%(%) (was %) -> wms_migrator',
        rec.schema_name, rec.function_name, rec.args, rec.owner_role;
      EXECUTE format(
        'ALTER FUNCTION %I.%I(%s) OWNER TO wms_migrator',
        rec.schema_name,
        rec.function_name,
        rec.args
      );
    END IF;
  END LOOP;
END
$$;

-- Posture verification for views/materialized views: fail if any remain owned by superuser/bypass roles.
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public'
    AND c.relkind IN ('v','m')
    AND (r.rolsuper OR r.rolbypassrls);

  IF cnt > 0 THEN
    RAISE EXCEPTION 'Ownership hardening incomplete: % public views/matviews still owned by superuser/bypass roles', cnt;
  ELSE
    RAISE NOTICE 'Ownership hardening OK: no public views/matviews owned by superuser/bypass roles';
  END IF;
END $$;

-- Posture verification for functions:
-- - FAIL if any NON-SECURITY-DEFINER functions remain owned by superuser/bypass roles.
-- - Only NOTICE if SECURITY DEFINER functions exist under superuser/bypass roles (manual review).
DO $$
DECLARE
  cnt_invoker int;
  cnt_secdef int;
BEGIN
  SELECT count(*) INTO cnt_invoker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE n.nspname = 'public'
    AND (r.rolsuper OR r.rolbypassrls)
    AND p.prosecdef = false;

  IF cnt_invoker > 0 THEN
    RAISE EXCEPTION 'Ownership hardening incomplete: % NON-SECURITY-DEFINER public functions still owned by superuser/bypass roles', cnt_invoker;
  ELSE
    RAISE NOTICE 'Ownership hardening OK: no NON-SECURITY-DEFINER public functions owned by superuser/bypass roles';
  END IF;

  SELECT count(*) INTO cnt_secdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE n.nspname = 'public'
    AND (r.rolsuper OR r.rolbypassrls)
    AND p.prosecdef = true;

  IF cnt_secdef > 0 THEN
    RAISE NOTICE 'Manual review: % SECURITY DEFINER public functions remain owned by superuser/bypass roles (left unchanged by design)', cnt_secdef;
  END IF;
END $$;

COMMIT;

-- Optional verification queries (run after script):
-- 1) Views/matviews ownership:
-- SELECT n.nspname, c.relname, c.relkind, r.rolname AS owner_role, r.rolsuper, r.rolbypassrls
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- JOIN pg_roles r ON r.oid = c.relowner
-- WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
-- ORDER BY c.relname;
--
-- 2) Functions ownership + security definer flag:
-- SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args, r.rolname AS owner_role, p.prosecdef
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- JOIN pg_roles r ON r.oid = p.proowner
-- WHERE n.nspname = 'public'
-- ORDER BY p.proname;
