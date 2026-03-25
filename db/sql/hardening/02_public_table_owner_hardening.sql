-- Run as DB owner/superuser (for example: postgres) on target DB.
-- Command:
-- psql -h localhost -U postgres -d wms_db -v ON_ERROR_STOP=1 -f db/sql/hardening/02_public_table_owner_hardening.sql
--
-- Purpose:
-- 1) Transfer ownership of public TABLES and SEQUENCES from superuser/bypass roles to wms_migrator.
-- 2) Optionally transfer ownership of selected public TYPES (ENUM/DOMAIN/RANGE/MULTIRANGE).
-- 3) Verify no unsafe ownership posture remains for those object classes.
--
-- CTO caution:
-- - Ownership transfer should not disable RLS/FORCE RLS, but verify tenant posture after execution.
-- - Existing runtime grants are not revoked by this script; verify grants/default privileges remain correct.

BEGIN;

-- Transfer ownership of public tables (regular + partitioned) owned by superuser/bypass roles.
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
      AND c.relkind IN ('r', 'p')
      AND (r.rolsuper OR r.rolbypassrls)
  LOOP
    RAISE NOTICE 'Changing owner of TABLE %.% (was %) -> wms_migrator',
      rec.schema_name, rec.object_name, rec.owner_role;
    EXECUTE format('ALTER TABLE %I.%I OWNER TO wms_migrator', rec.schema_name, rec.object_name);
  END LOOP;
END
$$;

-- Transfer ownership of public sequences owned by superuser/bypass roles.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, c.relname AS object_name, r.rolname AS owner_role
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND (r.rolsuper OR r.rolbypassrls)
  LOOP
    RAISE NOTICE 'Changing owner of SEQUENCE %.% (was %) -> wms_migrator',
      rec.schema_name, rec.object_name, rec.owner_role;
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO wms_migrator', rec.schema_name, rec.object_name);
  END LOOP;
END
$$;

-- Optional: transfer selected custom types in public schema.
-- Included types:
--   e = enum, d = domain, r = range, m = multirange
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT n.nspname AS schema_name, t.typname AS object_name, t.typtype, r.rolname AS owner_role
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_roles r ON r.oid = t.typowner
    WHERE n.nspname = 'public'
      AND t.typtype IN ('e', 'd', 'r', 'm')
      AND (r.rolsuper OR r.rolbypassrls)
  LOOP
    RAISE NOTICE 'Changing owner of TYPE %.% (typtype=%; was %) -> wms_migrator',
      rec.schema_name, rec.object_name, rec.typtype, rec.owner_role;
    EXECUTE format('ALTER TYPE %I.%I OWNER TO wms_migrator', rec.schema_name, rec.object_name);
  END LOOP;
END
$$;

-- Verification: fail if any public tables still owned by superuser/bypass roles.
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND (r.rolsuper OR r.rolbypassrls);

  IF cnt > 0 THEN
    RAISE EXCEPTION 'Ownership hardening incomplete: % public tables still owned by superuser/bypass roles', cnt;
  ELSE
    RAISE NOTICE 'Ownership hardening OK: no public tables owned by superuser/bypass roles';
  END IF;
END
$$;

-- Verification: fail if any public sequences still owned by superuser/bypass roles.
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_roles r ON r.oid = c.relowner
  WHERE n.nspname = 'public'
    AND c.relkind = 'S'
    AND (r.rolsuper OR r.rolbypassrls);

  IF cnt > 0 THEN
    RAISE EXCEPTION 'Ownership hardening incomplete: % public sequences still owned by superuser/bypass roles', cnt;
  ELSE
    RAISE NOTICE 'Ownership hardening OK: no public sequences owned by superuser/bypass roles';
  END IF;
END
$$;

-- Verification: fail if selected custom public types still owned by superuser/bypass roles.
DO $$
DECLARE
  cnt int;
BEGIN
  SELECT count(*) INTO cnt
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_roles r ON r.oid = t.typowner
  WHERE n.nspname = 'public'
    AND t.typtype IN ('e', 'd', 'r', 'm')
    AND (r.rolsuper OR r.rolbypassrls);

  IF cnt > 0 THEN
    RAISE EXCEPTION 'Ownership hardening incomplete: % selected public types still owned by superuser/bypass roles', cnt;
  ELSE
    RAISE NOTICE 'Ownership hardening OK: no selected public types owned by superuser/bypass roles';
  END IF;
END
$$;

COMMIT;

-- Recommended post-run checks:
-- 1) Tenant safety posture:
--    npm run check:tenant-safety
-- 2) Runtime grants posture:
--    SELECT grantee, table_schema, table_name, privilege_type
--    FROM information_schema.role_table_grants
--    WHERE table_schema = 'public' AND grantee IN ('wms_app', 'wms_migrator')
--    ORDER BY table_name, grantee, privilege_type;
