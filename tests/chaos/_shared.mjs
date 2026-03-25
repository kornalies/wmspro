import process from "node:process"
import bcrypt from "bcryptjs"
import pg from "pg"

const { Client } = pg

export const BASE_URL = process.env.WMS_API_BASE_URL || "http://localhost:3000/api"
export const CHAOS_PASSWORD = "Chaos@12345"

export function fail(message) {
  throw new Error(message)
}

export function ensureEnv(keys) {
  const missing = keys.filter((k) => !process.env[k] || !String(process.env[k]).trim())
  if (missing.length) {
    fail(`Missing required env for chaos tests: ${missing.join(", ")}`)
  }
}

export async function withDb(fn) {
  ensureEnv(["DATABASE_URL"])
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

async function ensureRbac(client, userId) {
  const permissions = [
    ["admin.users.manage", "Manage Users"],
    ["admin.companies.manage", "Manage Companies"],
    ["master.data.manage", "Manage Master Data"],
    ["grn.manage", "Manage GRN"],
    ["grn.mobile.approve", "Approve Mobile GRN"],
    ["do.manage", "Manage Delivery Orders"],
    ["gate.in.create", "Create Gate In"],
    ["reports.view", "View Reports"],
    ["finance.view", "View Finance"],
    ["stock.putaway.manage", "Manage Putaway"],
  ]

  await client.query(
    `INSERT INTO rbac_roles (role_code, role_name, description, is_system, is_active)
     VALUES ('SUPER_ADMIN', 'Super Admin', 'Chaos test role', true, true)
     ON CONFLICT (role_code) DO NOTHING`
  )

  for (const [key, name] of permissions) {
    await client.query(
      `INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (permission_key) DO NOTHING`,
      [key, name]
    )
  }

  await client.query(
    `INSERT INTO rbac_role_permissions (role_id, permission_id)
     SELECT r.id, p.id
     FROM rbac_roles r
     JOIN rbac_permissions p ON p.permission_key = ANY($1::text[])
     WHERE r.role_code = 'SUPER_ADMIN'
     ON CONFLICT DO NOTHING`,
    [permissions.map(([k]) => k)]
  )

  await client.query(
    `INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
     SELECT $1, r.id, true
     FROM rbac_roles r
     WHERE r.role_code = 'SUPER_ADMIN'
     ON CONFLICT (user_id, role_id) DO UPDATE SET is_primary = true`,
    [userId]
  )
}

export async function ensureChaosFixtures() {
  return withDb(async (client) => {
    await client.query("BEGIN")
    try {
      const passwordHash = await bcrypt.hash(CHAOS_PASSWORD, 10)

      const companyA = await client.query(
        `INSERT INTO companies (company_code, company_name, is_active)
         VALUES ('DEFAULT', 'Default Company', true)
         ON CONFLICT (company_code)
         DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`
      )
      const companyB = await client.query(
        `INSERT INTO companies (company_code, company_name, is_active)
         VALUES ('DEMO', 'Demo Company', true)
         ON CONFLICT (company_code)
         DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`
      )
      const companyAId = Number(companyA.rows[0].id)
      const companyBId = Number(companyB.rows[0].id)
      const setTenant = async (companyId) =>
        client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])

      await setTenant(companyAId)
      const whA = await client.query(
        `INSERT INTO warehouses (company_id, warehouse_code, warehouse_name, city, state, is_active)
         VALUES ($1, 'WH-DEF', 'WH DEFAULT', 'Bengaluru', 'Karnataka', true)
         ON CONFLICT (company_id, warehouse_code)
         DO UPDATE SET warehouse_name = EXCLUDED.warehouse_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId]
      )
      await setTenant(companyBId)
      const whB = await client.query(
        `INSERT INTO warehouses (company_id, warehouse_code, warehouse_name, city, state, is_active)
         VALUES ($1, 'WH-DEM', 'WH DEMO', 'Hyderabad', 'Telangana', true)
         ON CONFLICT (company_id, warehouse_code)
         DO UPDATE SET warehouse_name = EXCLUDED.warehouse_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId]
      )
      const whAId = Number(whA.rows[0].id)
      const whBId = Number(whB.rows[0].id)

      await setTenant(companyAId)
      const clientA = await client.query(
        `INSERT INTO clients (company_id, client_code, client_name, city, state, is_active)
         VALUES ($1, 'CL-DEF', 'CLIENT_DEFAULT_MARKER', 'Bengaluru', 'Karnataka', true)
         ON CONFLICT (company_id, client_code)
         DO UPDATE SET client_name = EXCLUDED.client_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId]
      )
      await setTenant(companyBId)
      const clientB = await client.query(
        `INSERT INTO clients (company_id, client_code, client_name, city, state, is_active)
         VALUES ($1, 'CL-DEM', 'CLIENT_DEMO_MARKER', 'Hyderabad', 'Telangana', true)
         ON CONFLICT (company_id, client_code)
         DO UPDATE SET client_name = EXCLUDED.client_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId]
      )
      const clientAId = Number(clientA.rows[0].id)
      const clientBId = Number(clientB.rows[0].id)

      await setTenant(companyAId)
      const itemA = await client.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active)
         VALUES ($1, 'ITM-DEF', 'ITEM_DEFAULT_MARKER', 'PCS', true)
         ON CONFLICT (company_id, item_code)
         DO UPDATE SET item_name = EXCLUDED.item_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId]
      )
      await setTenant(companyBId)
      const itemB = await client.query(
        `INSERT INTO items (company_id, item_code, item_name, uom, is_active)
         VALUES ($1, 'ITM-DEM', 'ITEM_DEMO_MARKER', 'PCS', true)
         ON CONFLICT (company_id, item_code)
         DO UPDATE SET item_name = EXCLUDED.item_name, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId]
      )
      const itemAId = Number(itemA.rows[0].id)
      const itemBId = Number(itemB.rows[0].id)

      await setTenant(companyAId)
      const userA = await client.query(
        `INSERT INTO users (company_id, username, email, full_name, role, password_hash, warehouse_id, is_active)
         VALUES ($1, 'chaos_default', 'chaos_default@local', 'Chaos Default', 'SUPER_ADMIN', $2, $3, true)
         ON CONFLICT (company_id, username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'SUPER_ADMIN', warehouse_id = EXCLUDED.warehouse_id, is_active = true, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId, passwordHash, whAId]
      )
      await setTenant(companyBId)
      const userB = await client.query(
        `INSERT INTO users (company_id, username, email, full_name, role, password_hash, warehouse_id, is_active)
         VALUES ($1, 'chaos_demo', 'chaos_demo@local', 'Chaos Demo', 'SUPER_ADMIN', $2, $3, true)
         ON CONFLICT (company_id, username)
         DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'SUPER_ADMIN', warehouse_id = EXCLUDED.warehouse_id, is_active = true, updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId, passwordHash, whBId]
      )
      const userAId = Number(userA.rows[0].id)
      const userBId = Number(userB.rows[0].id)

      await setTenant(companyAId)
      await ensureRbac(client, userAId)
      await setTenant(companyBId)
      await ensureRbac(client, userBId)

      await setTenant(companyAId)
      const grnA = await client.query(
        `INSERT INTO grn_header (company_id, grn_number, grn_date, client_id, warehouse_id, invoice_number, invoice_date, total_items, total_quantity, total_value, status, created_by)
         VALUES ($1, 'GRN-DEF-CHAOS', CURRENT_DATE, $2, $3, 'INV-DEF-1', CURRENT_DATE, 1, 1, 100, 'CONFIRMED', $4)
         ON CONFLICT (company_id, grn_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId, clientAId, whAId, userAId]
      )
      await setTenant(companyBId)
      const grnB = await client.query(
        `INSERT INTO grn_header (company_id, grn_number, grn_date, client_id, warehouse_id, invoice_number, invoice_date, total_items, total_quantity, total_value, status, created_by)
         VALUES ($1, 'GRN-DEM-CHAOS', CURRENT_DATE, $2, $3, 'INV-DEM-1', CURRENT_DATE, 1, 1, 100, 'CONFIRMED', $4)
         ON CONFLICT (company_id, grn_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId, clientBId, whBId, userBId]
      )
      const grnAId = Number(grnA.rows[0].id)
      const grnBId = Number(grnB.rows[0].id)

      await setTenant(companyAId)
      const grnLineA = await client.query(
        `INSERT INTO grn_line_items (company_id, grn_header_id, line_number, item_id, quantity, uom, mrp, serial_numbers_json)
         VALUES ($1, $2, 1, $3, 1, 'PCS', 100, '["SER-DEF-CHAOS"]'::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [companyAId, grnAId, itemAId]
      )

      await setTenant(companyBId)
      const grnLineB = await client.query(
        `INSERT INTO grn_line_items (company_id, grn_header_id, line_number, item_id, quantity, uom, mrp, serial_numbers_json)
         VALUES ($1, $2, 1, $3, 1, 'PCS', 100, '["SER-DEM-CHAOS"]'::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [companyBId, grnBId, itemBId]
      )
      let grnLineAId = Number(grnLineA.rows[0]?.id || 0)
      if (!grnLineAId) {
        await setTenant(companyAId)
        const existingA = await client.query(
          `SELECT id FROM grn_line_items
           WHERE company_id = $1 AND grn_header_id = $2 AND item_id = $3
           ORDER BY id DESC LIMIT 1`,
          [companyAId, grnAId, itemAId]
        )
        grnLineAId = Number(existingA.rows[0]?.id || 0)
      }

      let grnLineBId = Number(grnLineB.rows[0]?.id || 0)
      if (!grnLineBId) {
        await setTenant(companyBId)
        const existingB = await client.query(
          `SELECT id FROM grn_line_items
           WHERE company_id = $1 AND grn_header_id = $2 AND item_id = $3
           ORDER BY id DESC LIMIT 1`,
          [companyBId, grnBId, itemBId]
        )
        grnLineBId = Number(existingB.rows[0]?.id || 0)
      }

      if (!grnLineAId || !grnLineBId) {
        fail("Failed to resolve GRN line fixture IDs for chaos setup")
      }

      await setTenant(companyAId)
      const doA = await client.query(
        `INSERT INTO do_header (company_id, do_number, request_date, client_id, warehouse_id, requested_by, total_items, total_quantity_requested, total_quantity_dispatched, status, created_by)
         VALUES ($1, 'DO-DEF-CHAOS', CURRENT_DATE, $2, $3, 'Chaos Default', 1, 1, 0, 'DRAFT', $4)
         ON CONFLICT (company_id, do_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId, clientAId, whAId, userAId]
      )
      await setTenant(companyBId)
      const doB = await client.query(
        `INSERT INTO do_header (company_id, do_number, request_date, client_id, warehouse_id, requested_by, total_items, total_quantity_requested, total_quantity_dispatched, status, created_by)
         VALUES ($1, 'DO-DEM-CHAOS', CURRENT_DATE, $2, $3, 'Chaos Demo', 1, 1, 0, 'DRAFT', $4)
         ON CONFLICT (company_id, do_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId, clientBId, whBId, userBId]
      )

      await setTenant(companyAId)
      const gateA = await client.query(
        `INSERT INTO gate_in (company_id, gate_in_number, gate_in_datetime, arrival_datetime, warehouse_id, client_id, truck_number, driver_name, status, created_by)
         VALUES ($1, 'GIN-DEF-CHAOS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $2, $3, 'KA01AA0001', 'Driver A', 'PENDING', $4)
         ON CONFLICT (company_id, gate_in_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyAId, whAId, clientAId, userAId]
      )
      await setTenant(companyBId)
      const gateB = await client.query(
        `INSERT INTO gate_in (company_id, gate_in_number, gate_in_datetime, arrival_datetime, warehouse_id, client_id, truck_number, driver_name, status, created_by)
         VALUES ($1, 'GIN-DEM-CHAOS', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $2, $3, 'TS01AA0001', 'Driver B', 'PENDING', $4)
         ON CONFLICT (company_id, gate_in_number)
         DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING id`,
        [companyBId, whBId, clientBId, userBId]
      )

      await setTenant(companyAId)
      await client.query(
        `INSERT INTO stock_serial_numbers (company_id, serial_number, item_id, client_id, warehouse_id, status, received_date, grn_line_item_id)
         VALUES ($1, 'SER-DEF-CHAOS', $2, $3, $4, 'IN_STOCK', CURRENT_DATE, $5)
         ON CONFLICT DO NOTHING`,
        [companyAId, itemAId, clientAId, whAId, grnLineAId]
      )
      await setTenant(companyBId)
      await client.query(
        `INSERT INTO stock_serial_numbers (company_id, serial_number, item_id, client_id, warehouse_id, status, received_date, grn_line_item_id)
         VALUES ($1, 'SER-DEM-CHAOS', $2, $3, $4, 'IN_STOCK', CURRENT_DATE, $5)
         ON CONFLICT DO NOTHING`,
        [companyBId, itemBId, clientBId, whBId, grnLineBId]
      )

      await client.query("COMMIT")
      return {
        tenantA: { code: "DEFAULT", username: "chaos_default", password: CHAOS_PASSWORD, companyId: companyAId },
        tenantB: { code: "DEMO", username: "chaos_demo", password: CHAOS_PASSWORD, companyId: companyBId },
        ids: {
          a: {
            clientId: clientAId,
            warehouseId: whAId,
            itemId: itemAId,
          },
          b: {
            grnId: grnBId,
            doId: Number(doB.rows[0].id),
            gateInId: Number(gateB.rows[0].id),
          },
        },
      }
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  })
}

export async function login(companyCode, username, password) {
  const res = await fetch(`${BASE_URL}/mobile/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_code: companyCode,
      username,
      password,
    }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.data?.access_token) {
    fail(`Login failed for ${companyCode}/${username} status=${res.status}`)
  }
  return json.data.access_token
}

export async function apiGet(path, token, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export function assertNoMarkerInRows(rows, forbiddenMarker, context) {
  const haystack = JSON.stringify(rows || [])
  if (haystack.includes(forbiddenMarker)) {
    fail(`${context}: detected forbidden marker '${forbiddenMarker}'`)
  }
}

export function summarizePass(name) {
  console.log(`PASS ${name}`)
}
