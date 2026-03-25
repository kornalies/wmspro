import { NextRequest } from "next/server"
import { z } from "zod"

import { getSession, requirePermission } from "@/lib/auth"
import { getClient, setTenantContext } from "@/lib/db"
import { fail, ok } from "@/lib/api-response"
import { stageChargeTransaction } from "@/lib/billing-service"

const payloadSchema = z.object({
  client_id: z.number().positive(),
  warehouse_id: z.number().positive().optional(),
  vas_task_id: z.number().positive(),
  vas_ref_no: z.string().optional(),
  event_date: z.string().min(10),
  quantity: z.number().min(0).default(1),
  uom: z.string().optional(),
  remarks: z.string().optional(),
})

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const session = await getSession()
    if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401)
    requirePermission(session, "finance.view")

    const payload = payloadSchema.parse(await request.json())
    await db.query("BEGIN")
    await setTenantContext(db, session.companyId)

    await stageChargeTransaction(db, {
      companyId: session.companyId,
      userId: session.userId,
      clientId: payload.client_id,
      warehouseId: payload.warehouse_id ?? null,
      chargeType: "VAS",
      sourceType: "VAS",
      sourceDocId: payload.vas_task_id,
      sourceRefNo: payload.vas_ref_no || `VAS-${payload.vas_task_id}`,
      eventDate: payload.event_date,
      periodFrom: payload.event_date,
      periodTo: payload.event_date,
      quantity: payload.quantity,
      uom: payload.uom || "UNIT",
      remarks: payload.remarks || "Auto staged on VAS completion",
    })

    await db.query("COMMIT")
    return ok({ vas_task_id: payload.vas_task_id }, "VAS billing transaction staged")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to stage VAS charge"
    return fail("CREATE_FAILED", message, 400)
  } finally {
    db.release()
  }
}


