-- PostgreSQL 15/16/18 compatible
-- Run as a privileged admin once per cluster/database bootstrap.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_security;
CREATE SCHEMA IF NOT EXISTS app_admin;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_migrator') THEN
    CREATE ROLE wms_migrator
      LOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEROLE
      NOCREATEDB
      INHERIT
      PASSWORD '<MIGRATOR_PASSWORD>';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    CREATE ROLE wms_app
      LOGIN
      NOSUPERUSER
      NOBYPASSRLS
      NOCREATEROLE
      NOCREATEDB
      INHERIT
      PASSWORD '<APP_PASSWORD>';
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO wms_migrator', current_database());
  EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO wms_app', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO wms_migrator;
GRANT CREATE ON SCHEMA public TO wms_migrator;
GRANT USAGE ON SCHEMA public TO wms_app;
GRANT USAGE ON SCHEMA app_security TO wms_migrator, wms_app;
GRANT USAGE ON SCHEMA app_admin TO wms_migrator;

-- Migrator owns DDL lifecycle in public schema.
ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO wms_app;

-- Existing objects grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO wms_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO wms_app;

CREATE OR REPLACE FUNCTION app_security.assert_safe_runtime_role()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_is_super boolean;
  v_is_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls
  INTO v_is_super, v_is_bypass
  FROM pg_roles
  WHERE rolname = current_user;

  IF v_is_super IS NULL THEN
    RAISE EXCEPTION 'Unable to verify current role: %', current_user;
  END IF;

  IF v_is_super OR v_is_bypass THEN
    RAISE EXCEPTION
      'Unsafe DB role detected: %, rolsuper=%, rolbypassrls=%',
      current_user,
      v_is_super,
      v_is_bypass;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION app_security.assert_safe_runtime_role() TO wms_app, wms_migrator;

COMMIT;

-- Verification commands (run after COMMIT)
-- 1) role posture
-- SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
-- FROM pg_roles
-- WHERE rolname IN ('wms_migrator','wms_app')
-- ORDER BY rolname;

-- 2) runtime role self-check (run as wms_app)
-- SELECT app_security.assert_safe_runtime_role();

-- 3) what user is app currently connected as
-- SELECT current_user, session_user;

