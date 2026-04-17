import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { parseBoolean, parseCsv, parseNumber, type CsvRow } from "@/lib/csv-import"
import { normalizeRoleCode } from "@/lib/role-utils"

type ImportType = "clients" | "items" | "users" | "opening-stock" | "rate-cards"

type ImportReport = {
  total_rows: number
  inserted: number
  updated: number
  skipped: number
  errors: Array<{ row: number; message: string }>
}

function canRunImport(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return false
  if (session.role === "SUPER_ADMIN" || session.role === "ADMIN") return true
  if (session.permissions?.includes("master.data.manage")) return true
  if (session.permissions?.includes("admin.users.manage")) return true
  if (session.permissions?.includes("finance.view")) return true
  return false
}

function getRequiredField(row: CsvRow, key: string) {
  const value = row[key]?.trim()
  if (!value) throw new Error(`${key} is required`)
  return value
}

async function importClients(rows: CsvRow[], sessionUserId: number): Promise<ImportReport> {
  const report: ImportReport = { total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const clientCode = getRequiredField(row, "client_code").toUpperCase()
      const clientName = getRequiredField(row, "client_name")
      const exists = await query("SELECT id FROM clients WHERE client_code = $1 LIMIT 1", [clientCode])
      if (!exists.rows.length) {
        await query(
          `INSERT INTO clients (
            client_code, client_name, contact_person, contact_email, contact_phone,
            gst_number, pan_number, registered_address, city, state, pincode, is_active, created_by
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            clientCode,
            clientName,
            row.contact_person || null,
            row.contact_email || null,
            row.contact_phone || null,
            row.gst_number || null,
            row.pan_number || null,
            row.address || null,
            row.city || null,
            row.state || null,
            row.pincode || null,
            parseBoolean(row.is_active, true),
            sessionUserId,
          ]
        )
        report.inserted++
      } else {
        await query(
          `UPDATE clients
           SET client_name = $1,
               contact_person = $2,
               contact_email = $3,
               contact_phone = $4,
               gst_number = $5,
               pan_number = $6,
               registered_address = $7,
               city = $8,
               state = $9,
               pincode = $10,
               is_active = $11,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $12`,
          [
            clientName,
            row.contact_person || null,
            row.contact_email || null,
            row.contact_phone || null,
            row.gst_number || null,
            row.pan_number || null,
            row.address || null,
            row.city || null,
            row.state || null,
            row.pincode || null,
            parseBoolean(row.is_active, true),
            Number(exists.rows[0].id),
          ]
        )
        report.updated++
      }
    } catch (error: unknown) {
      report.errors.push({ row: i + 2, message: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  report.skipped = report.total_rows - report.inserted - report.updated - report.errors.length
  return report
}

async function importItems(rows: CsvRow[]): Promise<ImportReport> {
  const report: ImportReport = { total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const itemCode = getRequiredField(row, "item_code").toUpperCase()
      const itemName = getRequiredField(row, "item_name")
      const uom = getRequiredField(row, "uom").toUpperCase()
      const exists = await query("SELECT id FROM items WHERE item_code = $1 LIMIT 1", [itemCode])

      if (!exists.rows.length) {
        await query(
          `INSERT INTO items (
            item_code, item_name, uom, hsn_code, standard_mrp, min_stock_alert, is_active
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            itemCode,
            itemName,
            uom,
            row.hsn_code || null,
            parseNumber(row.standard_mrp),
            parseNumber(row.min_stock_alert),
            parseBoolean(row.is_active, true),
          ]
        )
        report.inserted++
      } else {
        await query(
          `UPDATE items
           SET item_name = $1, uom = $2, hsn_code = $3, standard_mrp = $4, min_stock_alert = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP
           WHERE id = $7`,
          [
            itemName,
            uom,
            row.hsn_code || null,
            parseNumber(row.standard_mrp),
            parseNumber(row.min_stock_alert),
            parseBoolean(row.is_active, true),
            Number(exists.rows[0].id),
          ]
        )
        report.updated++
      }
    } catch (error: unknown) {
      report.errors.push({ row: i + 2, message: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  report.skipped = report.total_rows - report.inserted - report.updated - report.errors.length
  return report
}

async function importUsers(rows: CsvRow[], sessionUserId: number): Promise<ImportReport> {
  const report: ImportReport = { total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const username = getRequiredField(row, "username")
      const fullName = getRequiredField(row, "full_name")
      const email = getRequiredField(row, "email")
      const roleCode = normalizeRoleCode(getRequiredField(row, "role"))
      const roleResult = await query(
        "SELECT id, role_code FROM rbac_roles WHERE role_code = $1 AND is_active = true",
        [roleCode]
      )
      if (!roleResult.rows.length) throw new Error(`Invalid role code: ${roleCode}`)

      const existing = await query("SELECT id FROM users WHERE username = $1 LIMIT 1", [username])
      let userId: number
      if (!existing.rows.length) {
        const password = row.password?.trim()
        if (!password) {
          throw new Error(`password is required for new user: ${username}`)
        }
        const passwordHash = await bcrypt.hash(password, 10)
        const created = await query(
          `INSERT INTO users (username, email, full_name, role, password_hash, is_active)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [username, email, fullName, roleCode, passwordHash, parseBoolean(row.is_active, true)]
        )
        userId = Number(created.rows[0].id)
        report.inserted++
      } else {
        userId = Number(existing.rows[0].id)
        const password = row.password?.trim()
        if (password) {
          const passwordHash = await bcrypt.hash(password, 10)
          await query(
            `UPDATE users
             SET email = $1, full_name = $2, role = $3, is_active = $4, password_hash = $5, updated_at = CURRENT_TIMESTAMP
             WHERE id = $6`,
            [email, fullName, roleCode, parseBoolean(row.is_active, true), passwordHash, userId]
          )
        } else {
          await query(
            `UPDATE users
             SET email = $1, full_name = $2, role = $3, is_active = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5`,
            [email, fullName, roleCode, parseBoolean(row.is_active, true), userId]
          )
        }
        report.updated++
      }

      await query("DELETE FROM rbac_user_roles WHERE user_id = $1", [userId])
      await query(
        `INSERT INTO rbac_user_roles (user_id, role_id, is_primary, assigned_by)
         VALUES ($1, $2, true, $3)
         ON CONFLICT (user_id, role_id)
         DO UPDATE SET is_primary = true, assigned_by = EXCLUDED.assigned_by, assigned_at = CURRENT_TIMESTAMP`,
        [userId, Number(roleResult.rows[0].id), sessionUserId]
      )
    } catch (error: unknown) {
      report.errors.push({ row: i + 2, message: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  report.skipped = report.total_rows - report.inserted - report.updated - report.errors.length
  return report
}

async function importOpeningStock(rows: CsvRow[]): Promise<ImportReport> {
  const report: ImportReport = { total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const warehouseCode = getRequiredField(row, "warehouse_code").toUpperCase()
      const clientCode = getRequiredField(row, "client_code").toUpperCase()
      const itemCode = getRequiredField(row, "item_code").toUpperCase()
      const serialNumber = getRequiredField(row, "serial_number")
      const status = (row.status || "IN_STOCK").toUpperCase()
      const receivedDate = row.received_date || new Date().toISOString().slice(0, 10)

      const [warehouseResult, clientResult, itemResult] = await Promise.all([
        query("SELECT id FROM warehouses WHERE warehouse_code = $1 LIMIT 1", [warehouseCode]),
        query("SELECT id FROM clients WHERE client_code = $1 LIMIT 1", [clientCode]),
        query("SELECT id FROM items WHERE item_code = $1 LIMIT 1", [itemCode]),
      ])

      if (!warehouseResult.rows.length) throw new Error(`Warehouse not found: ${warehouseCode}`)
      if (!clientResult.rows.length) throw new Error(`Client not found: ${clientCode}`)
      if (!itemResult.rows.length) throw new Error(`Item not found: ${itemCode}`)

      const existing = await query(
        "SELECT id FROM stock_serial_numbers WHERE serial_number = $1 AND item_id = $2 LIMIT 1",
        [serialNumber, Number(itemResult.rows[0].id)]
      )
      if (existing.rows.length) {
        report.skipped++
        continue
      }

      await query(
        `INSERT INTO stock_serial_numbers (
          serial_number, item_id, client_id, warehouse_id, status, received_date, grn_line_item_id
        ) VALUES ($1,$2,$3,$4,$5,$6::date,NULL)`,
        [
          serialNumber,
          Number(itemResult.rows[0].id),
          Number(clientResult.rows[0].id),
          Number(warehouseResult.rows[0].id),
          status,
          receivedDate,
        ]
      )
      report.inserted++
    } catch (error: unknown) {
      report.errors.push({ row: i + 2, message: error instanceof Error ? error.message : "Unknown error" })
    }
  }
  return report
}

async function importRateCards(
  rows: CsvRow[],
  sessionUserId: number,
  sessionCompanyId: number
): Promise<ImportReport> {
  const report: ImportReport = { total_rows: rows.length, inserted: 0, updated: 0, skipped: 0, errors: [] }
  const db = await getClient()
  try {
    const groups = new Map<string, CsvRow[]>()
    for (const row of rows) {
      const key = `${(row.client_code || "").toUpperCase()}::${(row.rate_card_code || "").toUpperCase()}`
      const list = groups.get(key) || []
      list.push(row)
      groups.set(key, list)
    }

    for (const [key, groupRows] of groups.entries()) {
      await db.query("BEGIN")
      try {
        await setTenantContext(db, sessionCompanyId)
        const first = groupRows[0]
        const clientCode = getRequiredField(first, "client_code").toUpperCase()
        const rateCardCode = getRequiredField(first, "rate_card_code").toUpperCase()
        const rateCardName = getRequiredField(first, "rate_card_name")
        const effectiveFrom = getRequiredField(first, "effective_from")
        const effectiveTo = first.effective_to || null
        const billingCycle = (first.billing_cycle || "MONTHLY").toUpperCase()
        const currency = (first.currency || "INR").toUpperCase()
        const taxInclusive = parseBoolean(first.tax_inclusive, false)
        const priority = parseNumber(first.priority) ?? 100

        const clientLookup = await db.query("SELECT id FROM clients WHERE client_code = $1 LIMIT 1", [clientCode])
        if (!clientLookup.rows.length) throw new Error(`Client not found: ${clientCode}`)
        const clientId = Number(clientLookup.rows[0].id)

        const masterLookup = await db.query(
          `SELECT id FROM client_rate_master
           WHERE client_id = $1 AND rate_card_code = $2
           LIMIT 1`,
          [clientId, rateCardCode]
        )

        let masterId: number
        if (!masterLookup.rows.length) {
          const created = await db.query(
            `INSERT INTO client_rate_master (
              client_id, rate_card_code, rate_card_name, effective_from, effective_to, billing_cycle,
              currency, tax_inclusive, priority, is_active, created_by, updated_by
            ) VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,true,$10,$10)
            RETURNING id`,
            [clientId, rateCardCode, rateCardName, effectiveFrom, effectiveTo, billingCycle, currency, taxInclusive, priority, sessionUserId]
          )
          masterId = Number(created.rows[0].id)
          report.inserted++
        } else {
          masterId = Number(masterLookup.rows[0].id)
          await db.query(
            `UPDATE client_rate_master
             SET rate_card_name = $1, effective_from = $2::date, effective_to = $3::date, billing_cycle = $4,
                 currency = $5, tax_inclusive = $6, priority = $7, updated_by = $8, updated_at = CURRENT_TIMESTAMP
             WHERE id = $9`,
            [rateCardName, effectiveFrom, effectiveTo, billingCycle, currency, taxInclusive, priority, sessionUserId, masterId]
          )
          report.updated++
        }

        await db.query("DELETE FROM client_rate_details WHERE rate_master_id = $1", [masterId])
        for (const row of groupRows) {
          const chargeType = getRequiredField(row, "charge_type").toUpperCase()
          const calcMethod = (row.calc_method || "PER_UNIT").toUpperCase()
          const slabMode = (row.slab_mode || "ABSOLUTE").toUpperCase()
          let itemId: number | null = null
          const itemCode = String(row.item_code || "").trim().toUpperCase()
          if (itemCode) {
            const itemLookup = await db.query(
              "SELECT id FROM items WHERE company_id = $1 AND item_code = $2 LIMIT 1",
              [sessionCompanyId, itemCode]
            )
            if (!itemLookup.rows.length) throw new Error(`Item not found for rate detail: ${itemCode}`)
            itemId = Number(itemLookup.rows[0].id)
          } else {
            itemId = parseNumber(row.item_id)
          }
          const uom = (row.uom || "UNIT").toUpperCase()
          const unitRate = parseNumber(row.unit_rate)
          if (unitRate === null) throw new Error(`unit_rate is required for ${key}`)

          await db.query(
            `INSERT INTO client_rate_details (
              rate_master_id, charge_type, calc_method, slab_mode, item_id, uom, min_qty, max_qty, free_qty, unit_rate,
              min_charge, max_charge, tax_code, gst_rate, is_active, created_by, updated_by
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$15)`,
            [
              masterId,
              chargeType,
              calcMethod,
              slabMode,
              itemId,
              uom,
              parseNumber(row.min_qty),
              parseNumber(row.max_qty),
              parseNumber(row.free_qty) ?? 0,
              unitRate,
              parseNumber(row.min_charge) ?? 0,
              parseNumber(row.max_charge),
              (row.tax_code || "GST").toUpperCase(),
              parseNumber(row.tax_rate) ?? 18,
              sessionUserId,
            ]
          )
        }

        await db.query("COMMIT")
      } catch (error: unknown) {
        await db.query("ROLLBACK")
        report.errors.push({
          row: 0,
          message: error instanceof Error ? error.message : `Rate card import failed for ${key}`,
        })
      }
    }
  } finally {
    db.release()
  }
  report.skipped = report.total_rows - report.errors.length - report.inserted - report.updated
  return report
}

export async function POST(request: NextRequest, context: { params: Promise<{ type: string }> }) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    if (!canRunImport(session)) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const { type } = await context.params
    const importType = type as ImportType
    if (!["clients", "items", "users", "opening-stock", "rate-cards"].includes(importType)) {
      return fail("VALIDATION_ERROR", "Invalid import type", 400)
    }

    const formData = await request.formData()
    const file = formData.get("file")
    if (!(file instanceof File)) {
      return fail("VALIDATION_ERROR", "CSV file is required", 400)
    }
    const text = await file.text()
    const rows = parseCsv(text)
    if (!rows.length) {
      return fail("VALIDATION_ERROR", "CSV has no data rows", 400)
    }

    let report: ImportReport
    if (importType === "clients") {
      report = await importClients(rows, session.userId)
    } else if (importType === "items") {
      report = await importItems(rows)
    } else if (importType === "users") {
      report = await importUsers(rows, session.userId)
    } else if (importType === "opening-stock") {
      report = await importOpeningStock(rows)
    } else {
      report = await importRateCards(rows, session.userId, session.companyId)
    }

    return ok({
      type: importType,
      file_name: file.name,
      ...report,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Import failed"
    return fail("IMPORT_FAILED", message, 400)
  }
}

