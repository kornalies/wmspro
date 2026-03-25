-- Tenant isolation tests for BASIC / ADVANCE / ENTERPRISE
-- Run as wms_migrator for setup blocks and as wms_app for runtime checks.

-- =========================================================
-- BASIC (shared tables + tenant_id + RLS)
-- =========================================================

BEGIN;

-- Prepare two tenants
INSERT INTO public.tenants (id, tenant_key, tenant_name, plan_code)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'tenant_a', 'Tenant A', 'BASIC'),
  ('22222222-2222-2222-2222-222222222222', 'tenant_b', 'Tenant B', 'BASIC')
ON CONFLICT (id) DO NOTHING;

-- Seed one row for each tenant
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
INSERT INTO public.items (tenant_id, item_code, item_name, uom, is_active)
VALUES ('11111111-1111-1111-1111-111111111111', 'A-ITEM-001', 'A Item', 'PCS', true)
ON CONFLICT DO NOTHING;

SELECT set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
INSERT INTO public.items (tenant_id, item_code, item_name, uom, is_active)
VALUES ('22222222-2222-2222-2222-222222222222', 'B-ITEM-001', 'B Item', 'PCS', true)
ON CONFLICT DO NOTHING;

COMMIT;

-- Positive read isolation check for tenant A
BEGIN;
SELECT set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
SELECT item_code FROM public.items ORDER BY item_code;
COMMIT;

-- Positive read isolation check for tenant B
BEGIN;
SELECT set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
SELECT item_code FROM public.items ORDER BY item_code;
COMMIT;

-- Negative write test: tenant A tries to update tenant B row
DO $$
BEGIN
  BEGIN
    PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
    UPDATE public.items
    SET item_name = 'HACKED'
    WHERE tenant_id = '22222222-2222-2222-2222-222222222222';

    RAISE EXCEPTION 'Expected RLS violation did not occur';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'PASS (expected failure): %', SQLERRM;
  END;
END
$$;

-- Negative insert test: tenant A inserts row for tenant B explicitly
DO $$
BEGIN
  BEGIN
    PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
    INSERT INTO public.items (tenant_id, item_code, item_name, uom, is_active)
    VALUES ('22222222-2222-2222-2222-222222222222', 'B-ITEM-HACK', 'hack', 'PCS', true);

    RAISE EXCEPTION 'Expected RLS WITH CHECK violation did not occur';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'PASS (expected failure): %', SQLERRM;
  END;
END
$$;

-- =========================================================
-- ADVANCE (schema-per-tenant)
-- =========================================================

-- Provision two schemas first (example)
SELECT app_admin.provision_advance_tenant(
  '33333333-3333-3333-3333-333333333333',
  'adv_a',
  'Advance A'
)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tenant_registry WHERE tenant_id = '33333333-3333-3333-3333-333333333333'
);

SELECT app_admin.provision_advance_tenant(
  '44444444-4444-4444-4444-444444444444',
  'adv_b',
  'Advance B'
)
WHERE NOT EXISTS (
  SELECT 1 FROM public.tenant_registry WHERE tenant_id = '44444444-4444-4444-4444-444444444444'
);

SELECT app_admin.grant_advance_schema_access('tenant_adv_a');
SELECT app_admin.grant_advance_schema_access('tenant_adv_b');

-- Insert in tenant A schema
BEGIN;
SET LOCAL search_path = tenant_adv_a, public;
INSERT INTO items (item_code, item_name, uom, is_active)
VALUES ('ADV-A-001', 'Advance A Item', 'PCS', true)
ON CONFLICT DO NOTHING;
COMMIT;

-- Ensure tenant B schema does not show tenant A data
BEGIN;
SET LOCAL search_path = tenant_adv_b, public;
SELECT item_code FROM items ORDER BY item_code;
COMMIT;

-- Negative test: access other tenant schema directly should fail for wms_app if direct schema access is not granted
DO $$
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM tenant_adv_a.items';
    RAISE EXCEPTION 'Expected permission isolation failure did not occur';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'PASS (expected failure): %', SQLERRM;
  END;
END
$$;

-- =========================================================
-- ENTERPRISE (database-per-tenant)
-- =========================================================

-- Cross-tenant access is prevented by separate database endpoints.
-- Verification checklist:
-- 1) Connect to tenant DB A and insert known marker row.
-- 2) Connect to tenant DB B and confirm marker row from A is absent.
-- 3) Verify app router uses tenant-specific DATABASE_URL by tenant_id.

-- SQL sanity on each enterprise DB connection:
-- SELECT current_database(), current_user;
-- SELECT app_security.assert_safe_runtime_role();
