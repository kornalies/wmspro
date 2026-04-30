import { query } from "@/lib/db"

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
}

export async function generateFreightShipmentNumber(
  client: Queryable,
  companyId: number
): Promise<string> {
  const year = new Date().getFullYear()
  const sequenceResult = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(shipment_no FROM '([0-9]+)$') AS INTEGER)), 0) + 1 AS next_seq
     FROM ff_shipments
     WHERE company_id = $1
       AND shipment_no LIKE $2`,
    [companyId, `FF-${year}-%`]
  )
  const nextSeq = Number(sequenceResult.rows[0]?.next_seq || 1)
  return `FF-${year}-${String(nextSeq).padStart(5, "0")}`
}

export async function resolveFreightShipmentId(companyId: number, shipmentRef: string): Promise<number | null> {
  const normalized = decodeURIComponent(String(shipmentRef || "")).trim()
  if (!normalized) return null

  const numericId = /^\d+$/.test(normalized) ? Number(normalized) : null
  const result = await query(
    `SELECT id
     FROM ff_shipments
     WHERE company_id = $1
       AND (
         ($2::int IS NOT NULL AND id = $2)
         OR ($3::text IS NOT NULL AND shipment_no ILIKE $3)
       )
     LIMIT 1`,
    [companyId, numericId, numericId ? null : normalized]
  )

  if (!result.rows.length) return null
  return Number(result.rows[0].id)
}

export function toNullableTimestamp(value?: string | null): string | null {
  if (!value) return null
  const trimmed = String(value).trim()
  return trimmed.length ? trimmed : null
}
