import process from "node:process"
import bcrypt from "bcryptjs"
import pg from "pg"

const { Client } = pg

function required(name, localFallback) {
  const value = process.env[name]
  if (!value || !String(value).trim()) {
    if (process.env.GITHUB_ACTIONS === "true" || !localFallback) {
      throw new Error(`Missing env var: ${name}`)
    }
    console.warn(`Using local fallback for ${name}`)
    return String(localFallback)
  }
  return String(value)
}

async function ensureRuntimeRole(client) {
  let savepointId = 0
  const safeExec = async (sql) => {
    const sp = `seed_grant_sp_${++savepointId}`
    await client.query(`SAVEPOINT ${sp}`)
    try {
      await client.query(sql)
      await client.query(`RELEASE SAVEPOINT ${sp}`)
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`)
      await client.query(`RELEASE SAVEPOINT ${sp}`)
      const message = error instanceof Error ? error.message : String(error)
      if (/permission denied|insufficient privilege|must be owner/i.test(message)) {
        console.warn(`Warning: skipped grant statement due to privileges: ${message}`)
        return
      }
      throw error
    }
  }

  await safeExec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wms_app') THEN
        CREATE ROLE wms_app
          LOGIN
          NOSUPERUSER
          NOBYPASSRLS
          NOCREATEROLE
          NOCREATEDB
          INHERIT
          PASSWORD 'wms_app';
      END IF;
    END
    $$;
  `)
  await safeExec(`DO $$ BEGIN EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO wms_app', current_database()); END $$;`)
  await safeExec(`GRANT USAGE ON SCHEMA public TO wms_app`)
  await safeExec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app`)
  await safeExec(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO wms_app`)
  await safeExec(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO wms_app`)

  // Some installs contain legacy tables/sequences created by a different owner.
  // Ensure runtime role can access LP sync tables used by smoke fixtures.
  await safeExec(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'mobile_lp_records'
      ) THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_lp_records TO wms_app;
      END IF;
      IF EXISTS (
        SELECT 1
        FROM information_schema.sequences
        WHERE sequence_schema = 'public' AND sequence_name = 'mobile_lp_records_id_seq'
      ) THEN
        GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.mobile_lp_records_id_seq TO wms_app;
      END IF;
    END
    $$;
  `)
}

async function ensureRbacSeed(client, userId) {
  const roleSeeds = [
    ["SUPER_ADMIN", "Super Admin", "CI seeded super admin role", true],
    ["ADMIN", "Admin", "Tenant admin role", true],
    ["CLIENT", "Client", "Client portal role", true],
    ["VIEWER", "Viewer", "Read-only client portal role", true],
  ]
  for (const [roleCode, roleName, description, isSystem] of roleSeeds) {
    await client.query(
      `INSERT INTO rbac_roles (role_code, role_name, description, is_system, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (role_code)
       DO UPDATE SET
         role_name = EXCLUDED.role_name,
         description = EXCLUDED.description,
         is_system = EXCLUDED.is_system,
         is_active = true`,
      [roleCode, roleName, description, isSystem]
    )
  }

  const permissionSeeds = [
    ["admin.users.manage", "Manage Users"],
    ["admin.companies.manage", "Manage Companies"],
    ["master.data.manage", "Manage Master Data"],
    ["settings.read", "Read Tenant Settings"],
    ["settings.update", "Update Tenant Settings"],
    ["scopes.read", "Read User Scopes"],
    ["scopes.update", "Update User Scopes"],
    ["audit.view", "View Audit Logs"],
    ["grn.manage", "Manage GRN"],
    ["grn.mobile.approve", "Approve Mobile GRN"],
    ["do.manage", "Manage Delivery Orders"],
    ["gate.in.create", "Create Gate In"],
    ["reports.view", "View Reports"],
    ["finance.view", "View Finance"],
    ["billing.view", "View Billing"],
    ["billing.generate_invoice", "Generate Billing Invoices"],
    ["stock.adjust", "Adjust Stock"],
    ["portal.client.view", "Access Client Portal"],
    ["portal.inventory.view", "View Portal Inventory"],
    ["portal.orders.view", "View Portal Orders"],
    ["portal.billing.view", "View Portal Billing"],
    ["portal.reports.view", "View Portal Reports"],
    ["portal.asn.view", "View Portal ASN"],
    ["portal.asn.create", "Create Portal ASN"],
  ]

  for (const [permissionKey, permissionName] of permissionSeeds) {
    await client.query(
      `INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (permission_key) DO NOTHING`,
      [permissionKey, permissionName]
    )
  }

  await client.query(
    `INSERT INTO rbac_role_permissions (role_id, permission_id)
     SELECT r.id, p.id
     FROM rbac_roles r
     JOIN rbac_permissions p ON p.permission_key = ANY($1::text[])
     WHERE r.role_code = 'SUPER_ADMIN'
     ON CONFLICT DO NOTHING`,
    [permissionSeeds.map(([key]) => key)]
  )

  await client.query(
    `INSERT INTO rbac_role_permissions (role_id, permission_id)
     SELECT r.id, p.id
     FROM rbac_roles r
     JOIN rbac_permissions p ON p.permission_key = ANY($1::text[])
     WHERE r.role_code IN ('CLIENT', 'VIEWER')
     ON CONFLICT DO NOTHING`,
    [["portal.client.view"]]
  )

  await client.query("DELETE FROM rbac_user_roles WHERE user_id = $1", [userId])

  await client.query(
    `INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
     SELECT $1, r.id, true
     FROM rbac_roles r
     WHERE r.role_code = 'SUPER_ADMIN'
     ON CONFLICT (user_id, role_id)
     DO UPDATE SET is_primary = true`,
    [userId]
  )
}

async function ensureStagedDoFixture(client, {
  companyId,
  clientId,
  warehouseId,
  itemId,
  userId,
}) {
  const doNumber = "DO-GWU-CI-STAGED-001"
  const grnNumber = "GRN-GWU-CI-STAGED-001"
  const serialNumber = "SER-GWU-CI-STAGED-001"

  const grnResult = await client.query(
    `INSERT INTO grn_header (
       company_id, grn_number, grn_date, client_id, warehouse_id, invoice_number, invoice_date,
       total_items, total_quantity, total_value, status, created_by
     )
     VALUES ($1, $2, CURRENT_DATE, $3, $4, 'INV-GWU-CI-STAGED-001', CURRENT_DATE, 1, 1, 100, 'CONFIRMED', $5)
     ON CONFLICT (company_id, grn_number)
     DO UPDATE SET
       client_id = EXCLUDED.client_id,
       warehouse_id = EXCLUDED.warehouse_id,
       invoice_number = EXCLUDED.invoice_number,
       invoice_date = EXCLUDED.invoice_date,
       total_items = 1,
       total_quantity = 1,
       total_value = 100,
       status = 'CONFIRMED',
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [companyId, grnNumber, clientId, warehouseId, userId]
  )
  const grnId = Number(grnResult.rows[0].id)

  const grnLineResult = await client.query(
    `SELECT id
     FROM grn_line_items
     WHERE company_id = $1
       AND grn_header_id = $2
       AND line_number = 1
     LIMIT 1`,
    [companyId, grnId]
  )
  const grnLineId = Number(grnLineResult.rows[0]?.id || 0)
  if (grnLineId) {
    await client.query(
      `UPDATE grn_line_items
       SET item_id = $1,
           quantity = 1,
           uom = 'PCS',
           mrp = 100,
           serial_numbers_json = $2::jsonb
       WHERE id = $3
         AND company_id = $4`,
      [itemId, JSON.stringify([serialNumber]), grnLineId, companyId]
    )
  } else {
    await client.query(
      `INSERT INTO grn_line_items (
         company_id, grn_header_id, line_number, item_id, quantity, uom, mrp, serial_numbers_json
       )
       VALUES ($1, $2, 1, $3, 1, 'PCS', 100, $4::jsonb)`,
      [companyId, grnId, itemId, JSON.stringify([serialNumber])]
    )
  }

  await client.query(
    `DELETE FROM grn_line_items
     WHERE company_id = $1
       AND grn_header_id = $2
       AND line_number <> 1`,
    [companyId, grnId]
  )

  const seededGrnLine = await client.query(
    `SELECT id
     FROM grn_line_items
     WHERE company_id = $1
       AND grn_header_id = $2
       AND line_number = 1
     LIMIT 1`,
    [companyId, grnId]
  )
  const seededGrnLineId = Number(seededGrnLine.rows[0]?.id || 0)
  if (!seededGrnLineId) {
    throw new Error("Failed to resolve seeded GRN line fixture")
  }

  const doResult = await client.query(
    `INSERT INTO do_header (
       company_id, do_number, request_date, client_id, warehouse_id, requested_by,
       total_items, total_quantity_requested, total_quantity_dispatched, status, created_by
     )
     VALUES ($1, $2, CURRENT_DATE, $3, $4, 'CI seeded dispatch fixture', 1, 1, 0, 'STAGED', $5)
     ON CONFLICT (company_id, do_number)
     DO UPDATE SET
       client_id = EXCLUDED.client_id,
       warehouse_id = EXCLUDED.warehouse_id,
       requested_by = EXCLUDED.requested_by,
       total_items = 1,
       total_quantity_requested = 1,
       total_quantity_dispatched = 0,
       status = 'STAGED',
       dispatch_date = NULL,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [companyId, doNumber, clientId, warehouseId, userId]
  )
  const doId = Number(doResult.rows[0].id)

  const lineResult = await client.query(
    `SELECT id
     FROM do_line_items
     WHERE company_id = $1
       AND do_header_id = $2
       AND line_number = 1
     LIMIT 1`,
    [companyId, doId]
  )
  const lineId = Number(lineResult.rows[0]?.id || 0)

  if (lineId) {
    await client.query(
      `UPDATE do_line_items
       SET item_id = $1,
           quantity_requested = 1,
           quantity_dispatched = 0,
           uom = 'PCS'
       WHERE id = $2
         AND company_id = $3`,
      [itemId, lineId, companyId]
    )
  } else {
    await client.query(
      `INSERT INTO do_line_items (
         company_id, do_header_id, line_number, item_id, quantity_requested, quantity_dispatched, uom
       )
       VALUES ($1, $2, 1, $3, 1, 0, 'PCS')`,
      [companyId, doId, itemId]
    )
  }

  await client.query(
    `DELETE FROM do_line_items
     WHERE company_id = $1
       AND do_header_id = $2
       AND line_number <> 1`,
    [companyId, doId]
  )

  try {
    await client.query(
      `INSERT INTO stock_serial_numbers (
         company_id, serial_number, item_id, client_id, warehouse_id, status, received_date, do_line_item_id, grn_line_item_id
       )
       VALUES ($1, $2, $3, $4, $5, 'IN_STOCK', CURRENT_DATE, NULL, $6)
       ON CONFLICT DO NOTHING`,
      [companyId, serialNumber, itemId, clientId, warehouseId, seededGrnLineId]
    )

    await client.query(
      `UPDATE stock_serial_numbers
       SET item_id = $1,
           client_id = $2,
           warehouse_id = $3,
           status = 'IN_STOCK',
           do_line_item_id = NULL,
           grn_line_item_id = $4,
           dispatched_date = NULL,
           received_date = COALESCE(received_date, CURRENT_DATE)
       WHERE company_id = $5
         AND serial_number = $6
         AND (
           item_id IS DISTINCT FROM $1
           OR client_id IS DISTINCT FROM $2
           OR warehouse_id IS DISTINCT FROM $3
           OR status IS DISTINCT FROM 'IN_STOCK'
           OR do_line_item_id IS NOT NULL
           OR grn_line_item_id IS DISTINCT FROM $4
           OR dispatched_date IS NOT NULL
           OR received_date IS NULL
         )`,
      [itemId, clientId, warehouseId, seededGrnLineId, companyId, serialNumber]
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/permission denied for table mobile_lp_records/i.test(message)) {
      console.warn(
        "Warning: skipped stock serial fixture due to mobile_lp_records permission; staged DO fixture remains available."
      )
      return
    }
    throw error
  }
}

async function main() {
  const databaseUrl = process.env.MIGRATOR_DATABASE_URL || required("DATABASE_URL")
  const companyCode = required("WMS_COMPANY_CODE", "DEFAULT").toUpperCase()
  const username = required("WMS_USERNAME", "wms_ci")
  const password = required("WMS_PASSWORD", "wms_ci_password")
  const passwordHash = await bcrypt.hash(password, 10)

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await client.query("BEGIN")
    await ensureRuntimeRole(client)

    const companyResult = await client.query(
      `INSERT INTO companies (company_code, company_name, is_active)
       VALUES ($1, $2, true)
       ON CONFLICT (company_code)
       DO UPDATE SET company_name = EXCLUDED.company_name, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyCode, `${companyCode} CI Company`]
    )
    const companyId = Number(companyResult.rows[0].id)
    await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)])

    const warehouseResult = await client.query(
      `INSERT INTO warehouses (company_id, warehouse_code, warehouse_name, is_active)
       VALUES ($1, 'GWU-CI-WH', 'GWU CI Warehouse', true)
       ON CONFLICT (company_id, warehouse_code)
       DO UPDATE SET warehouse_name = EXCLUDED.warehouse_name, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyId]
    )
    const warehouseId = Number(warehouseResult.rows[0].id)

    const clientResult = await client.query(
      `INSERT INTO clients (company_id, client_code, client_name, is_active)
       VALUES ($1, 'GWU-CI-CLIENT', 'GWU CI Client', true)
       ON CONFLICT (company_id, client_code)
       DO UPDATE SET client_name = EXCLUDED.client_name, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyId]
    )
    const clientId = Number(clientResult.rows[0].id)

    const itemResult = await client.query(
      `INSERT INTO items (company_id, item_code, item_name, uom, is_active)
       VALUES ($1, 'GWU-CI-ITEM', 'GWU CI Item', 'PCS', true)
       ON CONFLICT (company_id, item_code)
        DO UPDATE SET item_name = EXCLUDED.item_name, updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyId]
    )
    const itemId = Number(itemResult.rows[0].id)

    const userResult = await client.query(
      `INSERT INTO users (company_id, username, email, full_name, role, password_hash, warehouse_id, is_active)
       VALUES ($1, $2, $3, 'CI User', 'SUPER_ADMIN', $4, $5, true)
       ON CONFLICT (company_id, username)
       DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         warehouse_id = EXCLUDED.warehouse_id,
         is_active = true,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [companyId, username, `${username}@ci.local`, passwordHash, warehouseId]
    )
    const userId = Number(userResult.rows[0].id)

    await ensureRbacSeed(client, userId)
    try {
      await ensureStagedDoFixture(client, {
        companyId,
        clientId,
        warehouseId,
        itemId,
        userId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        /permission denied for table mobile_lp_records/i.test(message) ||
        /stock_movements_movement_number_key/i.test(message)
      ) {
        console.warn(
          `Warning: staged stock fixture partially skipped due to runtime ownership/idempotency constraints (${message}). Core tenant/user seed completed.`
        )
      } else {
        throw error
      }
    }

    await client.query("COMMIT")
    console.log("Seed completed.")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
