import { query } from "@/lib/db"

type DBClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>
}

let bootstrapPermissionDenied = false

function isInsufficientPrivilege(error: unknown) {
  if (!(error instanceof Error)) return false
  return /permission denied|insufficient privilege|must be owner of (table|relation|function|schema)/i.test(error.message)
}

const manualGrnColumns = [
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS gate_in_number VARCHAR(100)",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS model_number VARCHAR(255)",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS material_description TEXT",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS receipt_date DATE",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS manufacturing_date DATE",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS basic_price NUMERIC(12,2)",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS invoice_quantity INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS received_quantity INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS quantity_difference INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS damage_quantity INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS case_count INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS pallet_count INTEGER",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(12,3)",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS handling_type VARCHAR(20)",
  "ALTER TABLE grn_header ADD COLUMN IF NOT EXISTS source_channel VARCHAR(30)",
]

const manualGrnLineColumns = [
  "ALTER TABLE grn_line_items ADD COLUMN IF NOT EXISTS zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id)",
  "ALTER TABLE grn_line_items ADD COLUMN IF NOT EXISTS serial_numbers_json JSONB NOT NULL DEFAULT '[]'::jsonb",
]

const mobileCaptureDDL = [
  `CREATE TABLE IF NOT EXISTS mobile_grn_captures (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    capture_ref VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    notes TEXT,
    approved_grn_id INTEGER REFERENCES grn_header(id),
    created_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE mobile_grn_captures ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "ALTER TABLE mobile_grn_captures DROP CONSTRAINT IF EXISTS mobile_grn_captures_capture_ref_key",
  "UPDATE mobile_grn_captures SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE mobile_grn_captures ALTER COLUMN company_id SET NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_mobile_grn_capture_company_ref ON mobile_grn_captures(company_id, capture_ref)",
  "CREATE INDEX IF NOT EXISTS idx_mobile_grn_captures_status_created ON mobile_grn_captures(status, created_at DESC)",
]

const zoneLayoutDDL = [
  `CREATE TABLE IF NOT EXISTS warehouse_zone_layouts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    zone_code VARCHAR(30) NOT NULL,
    zone_name VARCHAR(100) NOT NULL,
    rack_code VARCHAR(30) NOT NULL,
    rack_name VARCHAR(100) NOT NULL,
    bin_code VARCHAR(40) NOT NULL,
    bin_name VARCHAR(120) NOT NULL,
    capacity_units INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE warehouse_zone_layouts ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "UPDATE warehouse_zone_layouts SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE warehouse_zone_layouts ALTER COLUMN company_id SET NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_zone_layout_wh_zone_rack_bin ON warehouse_zone_layouts (company_id, warehouse_id, zone_code, rack_code, bin_code)",
  "CREATE INDEX IF NOT EXISTS idx_zone_layout_warehouse_active ON warehouse_zone_layouts (warehouse_id, is_active)",
]

const stockPutawayDDL = [
  "ALTER TABLE stock_serial_numbers ADD COLUMN IF NOT EXISTS zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id)",
  "ALTER TABLE stock_serial_numbers ADD COLUMN IF NOT EXISTS bin_location VARCHAR(200)",
  "CREATE INDEX IF NOT EXISTS idx_stock_serial_numbers_zone_layout ON stock_serial_numbers(zone_layout_id)",
]

const putawayMovementDDL = [
  `CREATE TABLE IF NOT EXISTS stock_putaway_movements (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    stock_serial_id INTEGER NOT NULL REFERENCES stock_serial_numbers(id),
    serial_number VARCHAR(255) NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    from_zone_layout_id INTEGER REFERENCES warehouse_zone_layouts(id),
    to_zone_layout_id INTEGER NOT NULL REFERENCES warehouse_zone_layouts(id),
    from_bin_location VARCHAR(200),
    to_bin_location VARCHAR(200) NOT NULL,
    remarks TEXT,
    moved_by INTEGER NOT NULL REFERENCES users(id),
    moved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE stock_putaway_movements ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "UPDATE stock_putaway_movements SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE stock_putaway_movements ALTER COLUMN company_id SET NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_putaway_movements_warehouse_moved_at ON stock_putaway_movements(warehouse_id, moved_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_putaway_movements_stock_serial_id ON stock_putaway_movements(stock_serial_id)",
]

const accountingDDL = [
  `CREATE TABLE IF NOT EXISTS chart_of_accounts (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    account_code VARCHAR(20) NOT NULL,
    account_name VARCHAR(150) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE')),
    parent_account_id INTEGER REFERENCES chart_of_accounts(id),
    is_system BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "UPDATE chart_of_accounts SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE chart_of_accounts ALTER COLUMN company_id SET NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_chart_of_accounts_company_code ON chart_of_accounts(company_id, account_code)",
  "CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_company_type ON chart_of_accounts(company_id, account_type)",
  `CREATE TABLE IF NOT EXISTS journal_entries (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    entry_date DATE NOT NULL,
    source_module VARCHAR(50),
    source_id VARCHAR(120),
    entry_type VARCHAR(50) NOT NULL,
    external_ref VARCHAR(180) NOT NULL,
    description TEXT,
    posted_by INTEGER REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "UPDATE journal_entries SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE journal_entries ALTER COLUMN company_id SET NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_company_external_ref ON journal_entries(company_id, external_ref)",
  "CREATE INDEX IF NOT EXISTS idx_journal_entries_company_date ON journal_entries(company_id, entry_date)",
  `CREATE TABLE IF NOT EXISTS journal_lines (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id),
    journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL DEFAULT 1,
    account_id INTEGER NOT NULL REFERENCES chart_of_accounts(id),
    debit NUMERIC(14,2) NOT NULL DEFAULT 0,
    credit NUMERIC(14,2) NOT NULL DEFAULT 0,
    narration TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  "ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS company_id INTEGER DEFAULT NULLIF(current_setting('app.company_id', true), '')::INTEGER REFERENCES companies(id)",
  "UPDATE journal_lines SET company_id = (SELECT id FROM companies ORDER BY id LIMIT 1) WHERE company_id IS NULL",
  "ALTER TABLE journal_lines ALTER COLUMN company_id SET NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_journal_lines_company_entry ON journal_lines(company_id, journal_entry_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_lines_entry_line_no ON journal_lines(journal_entry_id, line_no)",
]

async function runStatements(
  statements: string[],
  db?: DBClient
) {
  if (bootstrapPermissionDenied) {
    return
  }
  for (const statement of statements) {
    try {
      if (db) {
        await db.query(statement)
      } else {
        await query(statement)
      }
    } catch (error) {
      if (isInsufficientPrivilege(error)) {
        bootstrapPermissionDenied = true
        return
      }
      throw error
    }
  }
}

export async function ensureGrnManualSchema(db?: DBClient) {
  await runStatements(manualGrnColumns, db)
  await ensureZoneLayoutSchema(db)
  await runStatements(manualGrnLineColumns, db)
}

export async function ensureMobileGrnCaptureSchema(db?: DBClient) {
  await ensureGrnManualSchema(db)
  await runStatements(mobileCaptureDDL, db)
}

export async function ensureZoneLayoutSchema(db?: DBClient) {
  await runStatements(zoneLayoutDDL, db)
}

export async function ensureStockPutawaySchema(db?: DBClient) {
  await ensureZoneLayoutSchema(db)
  await runStatements(stockPutawayDDL, db)
}

export async function ensurePutawayMovementSchema(db?: DBClient) {
  await ensureStockPutawaySchema(db)
  await runStatements(putawayMovementDDL, db)
}

export async function ensureAccountingSchema(db?: DBClient) {
  await runStatements(accountingDDL, db)
}
