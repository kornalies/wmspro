-- ADVANCE plan foundations: template schema + tenant registry

BEGIN;

CREATE SCHEMA IF NOT EXISTS app_admin;
CREATE SCHEMA IF NOT EXISTS app_security;

CREATE TABLE IF NOT EXISTS public.tenant_registry (
  company_id integer PRIMARY KEY REFERENCES public.companies(id),
  tenant_key text NOT NULL UNIQUE,
  tenant_name text NOT NULL,
  plan_code text NOT NULL CHECK (plan_code IN ('BASIC', 'ADVANCE', 'ENTERPRISE')),
  schema_name text UNIQUE,
  database_name text UNIQUE,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'MIGRATING')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Shared/global tables stay in public (examples):
-- public.tenants, public.users, public.api_keys, public.tenant_registry

CREATE SCHEMA IF NOT EXISTS tenant_template AUTHORIZATION wms_migrator;

-- Tenant-local tables (example subset for WMS core flows).
CREATE TABLE IF NOT EXISTS tenant_template.warehouses (
  id bigserial PRIMARY KEY,
  warehouse_code text NOT NULL UNIQUE,
  warehouse_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.clients (
  id bigserial PRIMARY KEY,
  client_code text NOT NULL UNIQUE,
  client_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.items (
  id bigserial PRIMARY KEY,
  item_code text NOT NULL UNIQUE,
  item_name text NOT NULL,
  uom text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.grn_header (
  id bigserial PRIMARY KEY,
  grn_number text NOT NULL UNIQUE,
  warehouse_id bigint NOT NULL REFERENCES tenant_template.warehouses(id),
  client_id bigint NOT NULL REFERENCES tenant_template.clients(id),
  status text NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.grn_line_items (
  id bigserial PRIMARY KEY,
  grn_header_id bigint NOT NULL REFERENCES tenant_template.grn_header(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES tenant_template.items(id),
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.do_header (
  id bigserial PRIMARY KEY,
  do_number text NOT NULL UNIQUE,
  warehouse_id bigint NOT NULL REFERENCES tenant_template.warehouses(id),
  client_id bigint NOT NULL REFERENCES tenant_template.clients(id),
  status text NOT NULL DEFAULT 'DRAFT',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.do_line_items (
  id bigserial PRIMARY KEY,
  do_header_id bigint NOT NULL REFERENCES tenant_template.do_header(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES tenant_template.items(id),
  quantity numeric(18,3) NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.stock_movements (
  id bigserial PRIMARY KEY,
  movement_type text NOT NULL,
  warehouse_id bigint NOT NULL REFERENCES tenant_template.warehouses(id),
  item_id bigint NOT NULL REFERENCES tenant_template.items(id),
  ref_type text,
  ref_number text,
  quantity numeric(18,3) NOT NULL,
  movement_date timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_template.stock_serial_numbers (
  id bigserial PRIMARY KEY,
  item_id bigint NOT NULL REFERENCES tenant_template.items(id),
  serial_number text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'AVAILABLE',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
