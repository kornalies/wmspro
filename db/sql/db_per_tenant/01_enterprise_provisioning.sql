-- ENTERPRISE plan provisioning runbook (psql + SQL)
-- Note: CREATE DATABASE cannot run inside a transaction block.

-- 1) Register tenant as enterprise in control database
INSERT INTO public.tenant_registry (
  company_id,
  tenant_key,
  tenant_name,
  plan_code,
  database_name,
  status
)
VALUES (
  <COMPANY_ID>,
  '<TENANT_KEY>',
  '<TENANT_NAME>',
  'ENTERPRISE',
  '<TENANT_DB_NAME>',
  'ACTIVE'
)
ON CONFLICT (company_id)
DO UPDATE
SET tenant_key = EXCLUDED.tenant_key,
    tenant_name = EXCLUDED.tenant_name,
    plan_code = EXCLUDED.plan_code,
    database_name = EXCLUDED.database_name,
    status = EXCLUDED.status,
    updated_at = now();

-- 2) Create dedicated tenant database (run in psql connected to postgres/control DB)
-- CREATE DATABASE <TENANT_DB_NAME> OWNER wms_migrator TEMPLATE template0 ENCODING 'UTF8';

-- 3) Connect to tenant DB and grant runtime app rights
-- \c <TENANT_DB_NAME>

CREATE SCHEMA IF NOT EXISTS app_security;

GRANT USAGE ON SCHEMA public TO wms_app;
GRANT USAGE ON SCHEMA app_security TO wms_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE wms_migrator IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wms_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO wms_app;

-- 4) Run full schema migrations against this tenant DB using MIGRATOR_DATABASE_URL.
-- 5) Verify runtime role safety in tenant DB:
-- SELECT app_security.assert_safe_runtime_role();

-- 6) Connection routing metadata query
-- SELECT company_id, plan_code, database_name FROM public.tenant_registry WHERE company_id = <COMPANY_ID>;

-- Backup/restore checklist (per tenant DB)
-- Backup: pg_dump -Fc -d <TENANT_DB_NAME> -f <TENANT_DB_NAME>_<YYYYMMDD>.dump
-- Restore: createdb <TENANT_DB_NAME>_restore && pg_restore -d <TENANT_DB_NAME>_restore <dumpfile>
-- Validate: table counts, constraints, smoke tests before cutover.
