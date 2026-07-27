-- Track C: cycle counting.
--
-- Cycle counting was NOT greenfield. A mobile service already writes
-- mobile_cycle_count_tasks and mobile_cycle_count_submissions, including the
-- blind_count flag and a requires_approval / approval_status pair. What was
-- missing was the other half: nothing could plan a count run, and nothing could
-- action an approval — a submission had been sitting at PENDING with no route
-- to a decision.
--
-- So this migration ADOPTS those tables rather than raising a second, competing
-- cycle-count system. The keys already line up with WMS stock:
--
--   mobile_cycle_count_tasks.bin_id  <-> stock_serial_numbers.bin_location
--   mobile_cycle_count_tasks.sku     <-> items.item_code
--
-- Two deliberate constraints:
--
-- 1. CREATE TABLE IF NOT EXISTS mirrors the live shape exactly, so a fresh WMS
--    deploy gets these tables while an existing database is left untouched.
--    They were previously outside db/migrations entirely, which meant a clean
--    install had no cycle counting at all.
--
-- 2. Everything added here is ADDITIVE AND NULLABLE. The mobile service writes
--    these tables and cannot be changed from this repo, so no column becomes
--    required and no existing column changes type or default. Mobile keeps
--    inserting exactly what it inserts today.
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE. Every other tenant table
-- carries FORCE RLS, and these should too — but the mobile service is outside
-- this repo and there is no evidence it sets app.company_id. Turning RLS on
-- would stop mobile counting the moment it deployed. WMS queries therefore scope
-- company_id explicitly, exactly as the rest of the app already does, and
-- closing the RLS gap is left as follow-up work that needs the mobile team.

BEGIN;

-- ---------------------------------------------------------------------------
-- The adopted tables, matching the live shape byte for byte.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS mobile_cycle_count_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  worker_id INTEGER,
  task_type TEXT NOT NULL,
  blind_count BOOLEAN NOT NULL DEFAULT false,
  bin_id TEXT NOT NULL,
  lp_id TEXT,
  sku TEXT NOT NULL,
  expected_qty INTEGER,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS mobile_cycle_count_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT,
  company_id INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  worker_id INTEGER,
  bin_id TEXT NOT NULL,
  lp_id TEXT,
  sku TEXT NOT NULL,
  expected_qty INTEGER,
  counted_qty INTEGER,
  discrepancy INTEGER,
  blind_count BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  approval_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The live tables predate this migration and their id columns carry no default:
-- the mobile service generates uuids client-side. WMS inserts server-side, so
-- give the columns a default. This is safe for mobile — an insert that supplies
-- its own id still wins, a default only fills in when the column is omitted.
ALTER TABLE mobile_cycle_count_tasks ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE mobile_cycle_count_submissions ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- ---------------------------------------------------------------------------
-- WMS-owned count planning. Nullable plan_id on the adopted task table, so a
-- mobile-created ad-hoc task simply has no plan and nothing about mobile's
-- insert path changes.
-- ---------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.cycle_count_plan_number_seq;

CREATE TABLE IF NOT EXISTS cycle_count_plans (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  plan_number VARCHAR(64) NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER REFERENCES clients(id),
  -- How the bins in scope were chosen. ZONE = every bin under a zone code,
  -- ABC = highest-movement SKUs first, MANUAL = an explicit bin list.
  strategy VARCHAR(20) NOT NULL DEFAULT 'ZONE',
  blind_count BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  zone_code VARCHAR(50),
  total_tasks INTEGER NOT NULL DEFAULT 0 CHECK (total_tasks >= 0),
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER REFERENCES users(id),
  closed_at TIMESTAMP,
  closed_by INTEGER REFERENCES users(id),
  CONSTRAINT uq_ccp_company_number UNIQUE (company_id, plan_number),
  CONSTRAINT ck_ccp_strategy CHECK (strategy IN ('ZONE', 'ABC', 'MANUAL')),
  CONSTRAINT ck_ccp_status CHECK (status IN ('OPEN', 'COUNTING', 'CLOSED', 'CANCELLED'))
);

ALTER TABLE mobile_cycle_count_tasks
  ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES cycle_count_plans(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Approval audit. approval_status already exists and mobile sets it; what was
-- missing is who decided, when, and what the decision did to stock.
-- ---------------------------------------------------------------------------

ALTER TABLE mobile_cycle_count_submissions
  ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_remarks TEXT,
  -- How many serials the approval actually wrote off. A shortage can only be
  -- applied down to the serials physically present, and an overage cannot be
  -- applied at all (WMS has no serial to invent), so the applied count is not
  -- always the discrepancy and must be recorded separately.
  ADD COLUMN IF NOT EXISTS adjusted_serial_count INTEGER;

-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_cc_tasks_company_status
  ON mobile_cycle_count_tasks(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_plan
  ON mobile_cycle_count_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_cc_tasks_company_bin
  ON mobile_cycle_count_tasks(company_id, warehouse_id, bin_id);
CREATE INDEX IF NOT EXISTS idx_cc_subs_company_approval
  ON mobile_cycle_count_submissions(company_id, approval_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cc_subs_task
  ON mobile_cycle_count_submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_ccp_company_status
  ON cycle_count_plans(company_id, status, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      public.cycle_count_plans,
      public.mobile_cycle_count_tasks,
      public.mobile_cycle_count_submissions
      TO wms_app;
    GRANT USAGE, SELECT ON SEQUENCE public.cycle_count_plans_id_seq TO wms_app;
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.cycle_count_plan_number_seq TO wms_app;
  END IF;
END
$$;

COMMIT;