-- BASIC plan: shared tables + tenant_id UUID + RLS
-- PostgreSQL 15/16/18 compatible

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_security;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL UNIQUE,
  tenant_name text NOT NULL,
  plan_code text NOT NULL CHECK (plan_code IN ('BASIC', 'ADVANCE', 'ENTERPRISE')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.tenants (tenant_key, tenant_name, plan_code)
SELECT 'default', 'Default Tenant', 'BASIC'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_key = 'default');

CREATE OR REPLACE FUNCTION app_security.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- Set tenant_id for all tenant-owned tables; adapt list to your final schema.
DO $$
DECLARE
  v_tables text[] := ARRAY[
    'users',
    'warehouses',
    'clients',
    'items',
    'stock_movements',
    'stock_serial_numbers',
    'grn_header',
    'grn_line_items',
    'do_header',
    'do_line_items',
    'gate_in',
    'gate_out'
  ];
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY v_tables
  LOOP
    IF to_regclass(format('public.%I', v_t)) IS NULL THEN
      RAISE NOTICE 'Skipping missing table %', v_t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS tenant_id uuid', v_t);

    EXECUTE format(
      'UPDATE public.%I SET tenant_id = (SELECT id FROM public.tenants WHERE tenant_key = ''default'' LIMIT 1) WHERE tenant_id IS NULL',
      v_t
    );

    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN tenant_id SET NOT NULL', v_t);

    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES public.tenants(id)',
        v_t,
        v_t || '_tenant_fk'
      );
    EXCEPTION
      WHEN duplicate_object THEN
        NULL;
    END;

    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT app_security.current_tenant_id()',
      v_t
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (tenant_id)',
      'idx_' || v_t || '_tenant_id',
      v_t
    );
  END LOOP;
END
$$;

-- Composite indexes for frequent predicates.
CREATE INDEX IF NOT EXISTS idx_items_tenant_code ON public.items (tenant_id, item_code);
CREATE INDEX IF NOT EXISTS idx_warehouses_tenant_code ON public.warehouses (tenant_id, warehouse_code);
CREATE INDEX IF NOT EXISTS idx_clients_tenant_code ON public.clients (tenant_id, client_code);
CREATE INDEX IF NOT EXISTS idx_grn_header_tenant_number ON public.grn_header (tenant_id, grn_number);
CREATE INDEX IF NOT EXISTS idx_do_header_tenant_number ON public.do_header (tenant_id, do_number);
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant_item ON public.stock_movements (tenant_id, item_id, movement_date);

-- Enforce tenant isolation with RLS.
DO $$
DECLARE
  v_rls_tables text[] := ARRAY[
    'users',
    'warehouses',
    'clients',
    'items',
    'stock_movements',
    'stock_serial_numbers',
    'grn_header',
    'grn_line_items',
    'do_header',
    'do_line_items',
    'gate_in',
    'gate_out'
  ];
  v_t text;
  v_policy text;
BEGIN
  FOREACH v_t IN ARRAY v_rls_tables
  LOOP
    IF to_regclass(format('public.%I', v_t)) IS NULL THEN
      CONTINUE;
    END IF;

    v_policy := v_t || '_tenant_isolation';

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy, v_t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO wms_app USING (tenant_id = app_security.current_tenant_id()) WITH CHECK (tenant_id = app_security.current_tenant_id())',
      v_policy,
      v_t
    );
  END LOOP;
END
$$;

COMMIT;

-- Verification (run as wms_app):
-- BEGIN;
-- SELECT set_config('app.tenant_id', '<TENANT_UUID>', true);
-- SELECT count(*) FROM public.items;
-- COMMIT;
