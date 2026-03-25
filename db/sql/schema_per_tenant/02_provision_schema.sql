-- ADVANCE plan provisioning: create schema per tenant and clone template objects

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_admin;
CREATE SCHEMA IF NOT EXISTS app_security;

CREATE OR REPLACE FUNCTION app_admin.validate_tenant_schema_name(p_schema_name text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_schema_name IS NULL OR p_schema_name = '' THEN
    RAISE EXCEPTION 'Schema name cannot be empty';
  END IF;

  IF p_schema_name !~ '^tenant_[a-z0-9_]{3,48}$' THEN
    RAISE EXCEPTION 'Invalid schema name format: %', p_schema_name;
  END IF;

  RETURN p_schema_name;
END;
$$;

CREATE OR REPLACE FUNCTION app_admin.provision_advance_tenant(
  p_company_id integer,
  p_tenant_key text,
  p_tenant_name text
)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema text;
  v_table text;
  v_tables text[] := ARRAY[
    'warehouses',
    'clients',
    'items',
    'grn_header',
    'grn_line_items',
    'do_header',
    'do_line_items',
    'stock_movements',
    'stock_serial_numbers'
  ];
BEGIN
  IF p_tenant_key !~ '^[a-z0-9_]{3,48}$' THEN
    RAISE EXCEPTION 'Invalid tenant key: %', p_tenant_key;
  END IF;

  v_schema := app_admin.validate_tenant_schema_name('tenant_' || p_tenant_key);

  IF EXISTS (SELECT 1 FROM public.tenant_registry WHERE company_id = p_company_id) THEN
    RAISE EXCEPTION 'Company already registered: %', p_company_id;
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION wms_migrator', v_schema);

  FOREACH v_table IN ARRAY v_tables
  LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I.%I (LIKE tenant_template.%I INCLUDING ALL)',
      v_schema,
      v_table,
      v_table
    );
  END LOOP;

  INSERT INTO public.tenant_registry (
    company_id,
    tenant_key,
    tenant_name,
    plan_code,
    schema_name,
    status
  )
  VALUES (
    p_company_id,
    p_tenant_key,
    p_tenant_name,
    'ADVANCE',
    v_schema,
    'ACTIVE'
  );

  RETURN v_schema;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.set_advance_search_path(p_company_id integer)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema text;
BEGIN
  SELECT schema_name
  INTO v_schema
  FROM public.tenant_registry
  WHERE company_id = p_company_id
    AND plan_code = 'ADVANCE'
    AND status = 'ACTIVE';

  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'No active ADVANCE schema for company %', p_company_id;
  END IF;

  PERFORM app_admin.validate_tenant_schema_name(v_schema);
  EXECUTE format('SET LOCAL search_path = %I, public', v_schema);
END;
$$;

COMMIT;

-- Example:
-- SELECT app_admin.provision_advance_tenant(
--   1001,
--   'acme01',
--   'ACME Logistics'
-- );
