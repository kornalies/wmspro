// Reconciliation helper between the two zone tables.
//
// `warehouse_zone_layouts` is the bin-level master managed by the admin UI
// (Warehouse > Zone > Rack > Bin). `warehouse_zones` is the coarser, zone-level
// table the stock movement ledger FKs to (stock_movements.from_zone_id /
// to_zone_id and stock_serial_numbers.zone_id). Historically the two were only
// bridged by matching zone_code strings at write time, so a layout whose zone
// had no matching warehouse_zones row silently wrote NULL into the ledger.
//
// ensureWarehouseZone guarantees a canonical warehouse_zones row exists for a
// (warehouse_id, zone_code) pair and returns its id, so callers can link by id
// instead of by string. Must run inside a transaction whose tenant context
// (app.company_id) is already set, since warehouse_zones is RLS-protected.

type ZoneAwareClient = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<{ id: number }> }>
}

export type EnsureWarehouseZoneParams = {
  companyId: number
  warehouseId: number
  zoneCode: string
  zoneName?: string | null
  zoneType?: string | null
}

export async function ensureWarehouseZone(
  client: ZoneAwareClient,
  { companyId, warehouseId, zoneCode, zoneName, zoneType }: EnsureWarehouseZoneParams
): Promise<number> {
  const result = await client.query(
    `INSERT INTO warehouse_zones (company_id, warehouse_id, zone_code, zone_name, zone_type, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (warehouse_id, zone_code)
     DO UPDATE SET
       zone_name = COALESCE(EXCLUDED.zone_name, warehouse_zones.zone_name),
       zone_type = COALESCE(EXCLUDED.zone_type, warehouse_zones.zone_type),
       updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [companyId, warehouseId, zoneCode, zoneName ?? null, zoneType ?? null]
  )
  return result.rows[0].id
}
