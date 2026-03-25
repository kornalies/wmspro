BEGIN;

CREATE TABLE IF NOT EXISTS do_wave_header (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  wave_number VARCHAR(80) NOT NULL,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER REFERENCES clients(id),
  strategy VARCHAR(20) NOT NULL DEFAULT 'BATCH',
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  total_orders INTEGER NOT NULL DEFAULT 0,
  total_tasks INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  released_by INTEGER REFERENCES users(id),
  released_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_do_wave_company_number UNIQUE (company_id, wave_number),
  CONSTRAINT ck_do_wave_strategy CHECK (strategy IN ('BATCH', 'CLUSTER')),
  CONSTRAINT ck_do_wave_status CHECK (status IN ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_do_wave_company_status ON do_wave_header(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_do_wave_company_warehouse ON do_wave_header(company_id, warehouse_id, created_at DESC);

CREATE TABLE IF NOT EXISTS do_wave_orders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  wave_id INTEGER NOT NULL REFERENCES do_wave_header(id) ON DELETE CASCADE,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  pick_sequence INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_do_wave_order UNIQUE (wave_id, do_header_id),
  CONSTRAINT ck_do_wave_order_status CHECK (status IN ('QUEUED', 'IN_PROGRESS', 'DONE', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_do_wave_orders_company_wave ON do_wave_orders(company_id, wave_id, pick_sequence);
CREATE INDEX IF NOT EXISTS idx_do_wave_orders_company_do ON do_wave_orders(company_id, do_header_id);

CREATE TABLE IF NOT EXISTS do_pick_tasks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
  wave_id INTEGER NOT NULL REFERENCES do_wave_header(id) ON DELETE CASCADE,
  do_header_id INTEGER NOT NULL REFERENCES do_header(id) ON DELETE CASCADE,
  do_line_item_id INTEGER NOT NULL REFERENCES do_line_items(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  task_type VARCHAR(20) NOT NULL DEFAULT 'PICK',
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  required_quantity INTEGER NOT NULL CHECK (required_quantity > 0),
  picked_quantity INTEGER NOT NULL DEFAULT 0 CHECK (picked_quantity >= 0),
  assigned_to INTEGER REFERENCES users(id),
  assigned_at TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_do_pick_task_wave_line UNIQUE (wave_id, do_line_item_id),
  CONSTRAINT ck_do_pick_task_type CHECK (task_type IN ('PICK', 'REPLENISH', 'QC')),
  CONSTRAINT ck_do_pick_task_status CHECK (status IN ('QUEUED', 'ASSIGNED', 'IN_PROGRESS', 'DONE', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_do_pick_tasks_company_status ON do_pick_tasks(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_do_pick_tasks_company_wave ON do_pick_tasks(company_id, wave_id, status);
CREATE INDEX IF NOT EXISTS idx_do_pick_tasks_company_assignee ON do_pick_tasks(company_id, assigned_to, status);

ALTER TABLE do_wave_header ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_wave_header FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_wave_header_tenant_isolation ON do_wave_header;
CREATE POLICY do_wave_header_tenant_isolation
  ON do_wave_header
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE do_wave_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_wave_orders FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_wave_orders_tenant_isolation ON do_wave_orders;
CREATE POLICY do_wave_orders_tenant_isolation
  ON do_wave_orders
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

ALTER TABLE do_pick_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE do_pick_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS do_pick_tasks_tenant_isolation ON do_pick_tasks;
CREATE POLICY do_pick_tasks_tenant_isolation
  ON do_pick_tasks
  USING (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER)
  WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::INTEGER);

COMMIT;
