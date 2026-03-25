BEGIN;

-- Pre-normalization snapshot for debugging dirty role values.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT COALESCE(role, '<NULL>') AS role_value, COUNT(*)::int AS cnt
    FROM users
    GROUP BY COALESCE(role, '<NULL>')
    ORDER BY COALESCE(role, '<NULL>')
  LOOP
    RAISE NOTICE 'users.role before normalization: % => % row(s)', rec.role_value, rec.cnt;
  END LOOP;
END $$;

-- Normalize legacy/dirty role values to canonical role codes.
UPDATE users
SET role = CASE
  WHEN role IS NULL OR BTRIM(role) = '' THEN 'ADMIN'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('SUPER_ADMIN', 'SUPERADMIN', 'SUPER-ADMIN') THEN 'SUPER_ADMIN'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('ADMIN', 'ADMIN_USER', 'SYSTEM_ADMIN') THEN 'ADMIN'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('WAREHOUSE_MANAGER', 'WAREHOUSEMANAGER', 'WH_MANAGER') THEN 'WAREHOUSE_MANAGER'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('SUPERVISOR') THEN 'SUPERVISOR'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) = 'OPERATOR' THEN 'OPERATOR'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('OPS', 'OPERATIONS') THEN 'OPERATIONS'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('GATE', 'GATE_USER', 'GATESTAFF', 'GATE_STAFF') THEN 'GATE_STAFF'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('FINANCE', 'FINANCE_USER', 'FINANCE_MANAGER') THEN 'FINANCE'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('CLIENT', 'CLIENT_USER') THEN 'CLIENT'
  WHEN UPPER(REPLACE(BTRIM(role), ' ', '_')) IN ('VIEWER', 'READ_ONLY', 'READONLY') THEN 'VIEWER'
  ELSE 'ADMIN'
END;

-- Post-normalization snapshot to keep migration output actionable.
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT role AS role_value, COUNT(*)::int AS cnt
    FROM users
    GROUP BY role
    ORDER BY role
  LOOP
    RAISE NOTICE 'users.role after normalization: % => % row(s)', rec.role_value, rec.cnt;
  END LOOP;
END $$;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (
    role IN (
      'SUPER_ADMIN',
      'ADMIN',
      'WAREHOUSE_MANAGER',
      'SUPERVISOR',
      'OPERATOR',
      'OPERATIONS',
      'GATE_STAFF',
      'FINANCE',
      'CLIENT',
      'VIEWER'
    )
  )
  NOT VALID;

ALTER TABLE users VALIDATE CONSTRAINT users_role_check;

COMMIT;
