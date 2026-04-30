import { getSession } from "@/lib/auth"
import { fail, ok } from "@/lib/api-response"
import { query } from "@/lib/db"
import { getEffectivePolicy, resolvePolicyActorType } from "@/lib/policy/effective"
import { guardToFailResponse, requireScope } from "@/lib/policy/guards"
import { assertProductEnabled, guardProductError } from "@/lib/product-access"

export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    await assertProductEnabled(session.companyId, "WMS")
    const { searchParams } = new URL(request.url)
    const requestedWarehouseId = Number(searchParams.get("warehouse_id") || 0)
    const warehouseId = requestedWarehouseId || session.warehouseId || 0
    const policy = await getEffectivePolicy(
      session.companyId,
      session.userId,
      resolvePolicyActorType(session)
    )
    if (warehouseId) requireScope(policy, "warehouse", warehouseId)

    const [clients, warehouses, items, gateIns] = await Promise.all([
      query(
        `SELECT id, client_code, client_name
         FROM clients
         WHERE is_active = true
         ORDER BY client_name ASC`
      ),
      query(
        `SELECT id, warehouse_code, warehouse_name
         FROM warehouses
         WHERE is_active = true
         ORDER BY warehouse_name ASC`
      ),
      query(
        `SELECT id, item_code, item_name, uom, hsn_code
         FROM items
         WHERE is_active = true
         ORDER BY item_name ASC
         LIMIT 500`
      ),
      warehouseId
        ? query(
            `SELECT id, gate_in_number, transport_company, truck_number
             FROM gate_in
             WHERE company_id = $1
               AND warehouse_id = $2
             ORDER BY gate_in_datetime DESC
             LIMIT 200`,
            [session.companyId, warehouseId]
          )
        : query(
            `SELECT id, gate_in_number, transport_company, truck_number
             FROM gate_in
             WHERE company_id = $1
             ORDER BY gate_in_datetime DESC
             LIMIT 200`,
            [session.companyId]
          ),
    ])

    return ok({
      gateIns: gateIns.rows,
      clients: clients.rows,
      warehouses: warehouses.rows,
      items: items.rows,
      defaults: {
        warehouse_id: warehouseId || null,
      },
    })
  } catch (error: unknown) {
    const productGuarded = guardProductError(error)
    if (productGuarded) return productGuarded
    const guarded = guardToFailResponse(error)
    if (guarded) return guarded
    const message = error instanceof Error ? error.message : "Failed to fetch GRN form data"
    return fail("SERVER_ERROR", message, 500)
  }
}
