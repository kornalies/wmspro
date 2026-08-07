// Shared query building blocks for the stock-search endpoints so the item-summary
// list, the per-item serial drill-down, and the export stream all apply identical
// filtering. Every fragment references the `ssn` (stock_serial_numbers) alias.

export type StockSearchFilters = {
  whereClause: string
  params: Array<string | number>
}

/**
 * Build the WHERE clause + positional params for a stock search from request query
 * params. `$1` is always the tenant company_id; callers append LIMIT/OFFSET (or any
 * further params) starting at `params.length + 1`.
 */
export function buildStockSearchFilters(
  searchParams: URLSearchParams,
  companyId: number
): StockSearchFilters {
  const serial = searchParams.get("serial")?.trim()
  const lp = searchParams.get("lp")?.trim()
  const item = searchParams.get("item")?.trim()
  const clientId = Number(searchParams.get("client_id") || 0)
  const status = searchParams.get("status")
  const warehouseId = Number(searchParams.get("warehouse_id") || 0)
  const itemId = Number(searchParams.get("item_id") || 0)
  const minAge = searchParams.get("min_age")
  const maxAge = searchParams.get("max_age")

  const where: string[] = [`ssn.company_id = $1`]
  const params: Array<string | number> = [companyId]
  let idx = 2

  if (serial) {
    where.push(`ssn.serial_number ILIKE $${idx++}`)
    params.push(`%${serial}%`)
  }
  if (lp) {
    // Match the LP via the stamped FK first; fall back to the legacy naming convention
    // (serial = lp_code OR serial LIKE "<lp_code>-%") for stock received before migration 059.
    where.push(
      `EXISTS (
        SELECT 1
        FROM public.mobile_lp_records lpf
        WHERE (
            ssn.lp_record_id = lpf.id
            OR ssn.serial_number = lpf.lp_code
            OR ssn.serial_number LIKE lpf.lp_code || '-%'
          )
          AND lpf.lp_code ILIKE $${idx++}
      )`
    )
    params.push(`%${lp}%`)
  }
  if (item) {
    where.push(
      `EXISTS (
        SELECT 1
        FROM items i2
        WHERE i2.id = ssn.item_id
          AND (i2.item_name ILIKE $${idx} OR i2.item_code ILIKE $${idx})
      )`
    )
    params.push(`%${item}%`)
    idx += 1
  }
  if (status && status !== "all") {
    where.push(`ssn.status = $${idx++}`)
    params.push(status)
  }
  if (clientId) {
    where.push(`ssn.client_id = $${idx++}`)
    params.push(clientId)
  }
  if (warehouseId) {
    where.push(`ssn.warehouse_id = $${idx++}`)
    params.push(warehouseId)
  }
  // Exact item filter powers the lazy per-item serial drill-down.
  if (itemId) {
    where.push(`ssn.item_id = $${idx++}`)
    params.push(itemId)
  }
  if (minAge) {
    where.push(`(CURRENT_DATE - ssn.received_date::date) >= $${idx++}`)
    params.push(Number(minAge))
  }
  if (maxAge) {
    where.push(`(CURRENT_DATE - ssn.received_date::date) <= $${idx++}`)
    params.push(Number(maxAge))
  }

  return { whereClause: `WHERE ${where.join(" AND ")}`, params }
}

/**
 * Where a unit is, as one expression.
 *
 * The naive form — `COALESCE(bin_location, CONCAT(zone, '/', rack, '/', bin),
 * 'Unassigned')` — never reaches its fallback, because Postgres CONCAT renders
 * NULL as an empty string: unlocated stock came out as the string `'//'`, which
 * every screen then displayed verbatim. StockSearch.tsx still carries a
 * `location === "//"` workaround from the first time someone hit this.
 *
 * CONCAT_WS skips NULLs and the outer NULLIF turns the all-null case back into
 * NULL so COALESCE can do its job. Exported because four queries need it and
 * three of them had drifted into the broken version.
 */
export function binLocationExpr(ssnAlias = "ssn", zlAlias = "zl"): string {
  return `COALESCE(
      NULLIF(${ssnAlias}.bin_location, ''),
      NULLIF(CONCAT_WS('/', NULLIF(${zlAlias}.zone_code, ''), NULLIF(${zlAlias}.rack_code, ''), NULLIF(${zlAlias}.bin_code, '')), ''),
      'Unassigned'
    )`
}

/** Full serial-row projection used by the drill-down and export queries. */
export const STOCK_SERIAL_SELECT = `
    ssn.id,
    ssn.serial_number,
    ssn.status,
    ssn.received_date,
    ssn.warehouse_id,
    ssn.item_id,
    (CURRENT_DATE - ssn.received_date::date) AS age_days,
    i.item_name,
    i.item_code,
    c.client_name,
    w.warehouse_name,
    COALESCE(zl.zone_name, 'Unassigned') AS zone_name,
    zl.rack_name,
    zl.bin_name,
    ${binLocationExpr()} AS bin_location,
    COALESCE(lpdir.lp_code, lp.lp_code) AS lp_code`

/** Joins backing {@link STOCK_SERIAL_SELECT}. */
export const STOCK_SERIAL_JOINS = `
  FROM stock_serial_numbers ssn
  JOIN items i ON i.id = ssn.item_id AND i.company_id = ssn.company_id
  JOIN clients c ON c.id = ssn.client_id AND c.company_id = ssn.company_id
  JOIN warehouses w ON w.id = ssn.warehouse_id AND w.company_id = ssn.company_id
  LEFT JOIN warehouse_zone_layouts zl ON zl.id = ssn.zone_layout_id AND zl.company_id = ssn.company_id
  -- Preferred: the LP stamped on the row at GRN confirm (works for real Mfg serials too).
  LEFT JOIN public.mobile_lp_records lpdir ON lpdir.id = ssn.lp_record_id
  -- Fallback for pre-migration-059 stock that only carries the "<lp_code>-<n>" convention.
  LEFT JOIN LATERAL (
    SELECT lpr.lp_code
    FROM public.mobile_lp_records lpr
    WHERE ssn.serial_number = lpr.lp_code
       OR ssn.serial_number LIKE lpr.lp_code || '-%'
    ORDER BY LENGTH(lpr.lp_code) DESC
    LIMIT 1
  ) lp ON TRUE`