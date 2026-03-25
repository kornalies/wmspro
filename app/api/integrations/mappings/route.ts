import { NextRequest } from "next/server"
import { z } from "zod"

import { fail, ok } from "@/lib/api-response"
import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { getIntegrationAccess } from "@/app/api/integrations/_utils"

const fieldSchema = z.object({
  source_path: z.string().trim().min(1).max(200),
  target_path: z.string().trim().min(1).max(200),
  data_type: z.string().trim().min(1).max(30).default("string"),
  transform_rule: z.string().trim().max(120).optional(),
  default_value: z.string().max(500).optional(),
  required: z.boolean().default(false),
  sequence_no: z.number().int().positive().default(1),
})

const mappingSchema = z.object({
  connector_id: z.number().int().positive(),
  entity_type: z.string().trim().min(2).max(40),
  direction: z.enum(["INBOUND", "OUTBOUND"]).default("OUTBOUND"),
  mapping_version: z.number().int().positive().default(1),
  is_default: z.boolean().default(true),
  fields: z.array(fieldSchema).min(1),
})

export async function GET(request: NextRequest) {
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!

    const { searchParams } = new URL(request.url)
    const connectorId = Number(searchParams.get("connector_id") || 0)

    const result = await query(
      `SELECT
         m.id,
         m.connector_id,
         c.connector_name,
         m.entity_type,
         m.direction,
         m.mapping_version,
         m.is_default,
         m.is_active,
         m.updated_at,
         COALESCE(
           json_agg(
             json_build_object(
               'id', f.id,
               'source_path', f.source_path,
               'target_path', f.target_path,
               'data_type', f.data_type,
               'transform_rule', f.transform_rule,
               'default_value', f.default_value,
               'required', f.required,
               'sequence_no', f.sequence_no
             )
             ORDER BY f.sequence_no ASC
           ) FILTER (WHERE f.id IS NOT NULL),
           '[]'::json
         ) AS fields
       FROM integration_schema_mappings m
       JOIN integration_connectors c ON c.id = m.connector_id AND c.company_id = m.company_id
       LEFT JOIN integration_mapping_fields f ON f.mapping_id = m.id AND f.company_id = m.company_id
       WHERE m.company_id = $1
         AND ($2::int = 0 OR m.connector_id = $2)
       GROUP BY m.id, c.connector_name
       ORDER BY m.updated_at DESC`,
      [access.companyId, connectorId]
    )

    return ok(result.rows)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to fetch mappings"
    return fail("SERVER_ERROR", message, 500)
  }
}

export async function POST(request: NextRequest) {
  const db = await getClient()
  try {
    const accessResult = await getIntegrationAccess()
    if (accessResult.error) return accessResult.error
    const access = accessResult.access!
    if (!access.canManage) return fail("FORBIDDEN", "Insufficient permissions", 403)

    const payload = mappingSchema.parse(await request.json())

    await db.query("BEGIN")
    await setTenantContext(db, access.companyId)

    const exists = await db.query(
      `SELECT id
       FROM integration_connectors
       WHERE company_id = $1
         AND id = $2`,
      [access.companyId, payload.connector_id]
    )
    if (!exists.rows.length) {
      await db.query("ROLLBACK")
      return fail("NOT_FOUND", "Connector not found", 404)
    }

    const mapping = await db.query(
      `INSERT INTO integration_schema_mappings (
         company_id,
         connector_id,
         entity_type,
         direction,
         mapping_version,
         is_default,
         is_active,
         created_by,
         updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7)
       ON CONFLICT (company_id, connector_id, entity_type, direction, mapping_version)
       DO UPDATE SET
         is_default = EXCLUDED.is_default,
         is_active = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING id, connector_id, entity_type, direction, mapping_version`,
      [
        access.companyId,
        payload.connector_id,
        payload.entity_type.toUpperCase(),
        payload.direction,
        payload.mapping_version,
        payload.is_default,
        access.userId,
      ]
    )
    const mappingId = Number(mapping.rows[0].id)

    await db.query(
      `DELETE FROM integration_mapping_fields
       WHERE company_id = $1
         AND mapping_id = $2`,
      [access.companyId, mappingId]
    )

    for (const field of payload.fields) {
      await db.query(
        `INSERT INTO integration_mapping_fields (
           company_id, mapping_id, source_path, target_path, data_type,
           transform_rule, default_value, required, sequence_no
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          access.companyId,
          mappingId,
          field.source_path,
          field.target_path,
          field.data_type,
          field.transform_rule || null,
          field.default_value || null,
          field.required,
          field.sequence_no,
        ]
      )
    }

    await writeAudit(
      {
        companyId: access.companyId,
        actorUserId: access.userId,
        actorType: "web",
        action: "integration.mapping.upsert",
        entityType: "integration_schema_mappings",
        entityId: String(mappingId),
        after: {
          connector_id: payload.connector_id,
          entity_type: payload.entity_type,
          direction: payload.direction,
          mapping_version: payload.mapping_version,
          field_count: payload.fields.length,
        },
        req: request,
      },
      db
    )

    await db.query("COMMIT")
    return ok({ id: mappingId }, "Mapping saved")
  } catch (error: unknown) {
    await db.query("ROLLBACK")
    const message = error instanceof Error ? error.message : "Failed to save mapping"
    return fail("SAVE_FAILED", message, 400)
  } finally {
    db.release()
  }
}
