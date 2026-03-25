import { getClient, query, setTenantContext } from "@/lib/db"
import { writeAudit } from "@/lib/audit"
import { invalidateEffectivePolicyCache } from "@/lib/policy/cache"
import {
  getDefaultTenantSettings,
  mergeTenantSettings,
  type TenantSettingsShape,
  validateTenantSettings,
} from "@/lib/policy/schema"

type TenantSettingsRecord = {
  company_id: number
  config_version: number
  feature_flags: unknown
  workflow_policies: unknown
  security_policies: unknown
  mobile_policies: unknown
  ui_branding: unknown
  updated_by: number | null
  updated_at: string
}

export type TenantSettingsRow = {
  companyId: number
  configVersion: number
  settings: TenantSettingsShape
  updatedBy: number | null
  updatedAt: string
}

function mapRow(row: TenantSettingsRecord): TenantSettingsRow {
  const settings = validateTenantSettings({
    feature_flags: row.feature_flags,
    workflow_policies: row.workflow_policies,
    security_policies: row.security_policies,
    mobile_policies: row.mobile_policies,
    ui_branding: row.ui_branding,
  })

  return {
    companyId: Number(row.company_id),
    configVersion: Number(row.config_version),
    settings,
    updatedBy: row.updated_by == null ? null : Number(row.updated_by),
    updatedAt: row.updated_at,
  }
}

async function ensureTenantSettingsRow(companyId: number) {
  const defaults = getDefaultTenantSettings()
  await query(
    `INSERT INTO tenant_settings (
      company_id,
      feature_flags,
      workflow_policies,
      security_policies,
      mobile_policies,
      ui_branding
    )
    VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)
    ON CONFLICT (company_id) DO NOTHING`,
    [
      companyId,
      JSON.stringify(defaults.feature_flags),
      JSON.stringify(defaults.workflow_policies),
      JSON.stringify(defaults.security_policies),
      JSON.stringify(defaults.mobile_policies),
      JSON.stringify(defaults.ui_branding),
    ]
  )
}

export async function getTenantSettings(companyId: number): Promise<TenantSettingsRow> {
  await ensureTenantSettingsRow(companyId)
  const result = await query(
    `SELECT
      company_id,
      config_version,
      feature_flags,
      workflow_policies,
      security_policies,
      mobile_policies,
      ui_branding,
      updated_by,
      updated_at
     FROM tenant_settings
     WHERE company_id = $1
     LIMIT 1`,
    [companyId]
  )

  if (!result.rows.length) {
    throw new Error("Tenant settings not found")
  }

  return mapRow(result.rows[0] as TenantSettingsRecord)
}

type UpdateTenantSettingsInput = {
  companyId: number
  patch: Partial<TenantSettingsShape>
  actorUserId?: number | null
  req?: Request
}

export async function updateTenantSettings(
  input: UpdateTenantSettingsInput
): Promise<TenantSettingsRow> {
  const db = await getClient()
  try {
    await db.query("BEGIN")
    await setTenantContext(db, input.companyId)

    const defaults = getDefaultTenantSettings()
    await db.query(
      `INSERT INTO tenant_settings (
        company_id,
        feature_flags,
        workflow_policies,
        security_policies,
        mobile_policies,
        ui_branding
      )
      VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb)
      ON CONFLICT (company_id) DO NOTHING`,
      [
        input.companyId,
        JSON.stringify(defaults.feature_flags),
        JSON.stringify(defaults.workflow_policies),
        JSON.stringify(defaults.security_policies),
        JSON.stringify(defaults.mobile_policies),
        JSON.stringify(defaults.ui_branding),
      ]
    )

    const currentResult = await db.query(
      `SELECT
        company_id,
        config_version,
        feature_flags,
        workflow_policies,
        security_policies,
        mobile_policies,
        ui_branding,
        updated_by,
        updated_at
      FROM tenant_settings
      WHERE company_id = $1
      FOR UPDATE`,
      [input.companyId]
    )

    if (!currentResult.rows.length) {
      throw new Error("Tenant settings not found")
    }

    const current = mapRow(currentResult.rows[0] as TenantSettingsRecord)
    const merged = mergeTenantSettings(current.settings, input.patch)

    const updatedResult = await db.query(
      `UPDATE tenant_settings
       SET feature_flags = $1::jsonb,
           workflow_policies = $2::jsonb,
           security_policies = $3::jsonb,
           mobile_policies = $4::jsonb,
           ui_branding = $5::jsonb,
           config_version = config_version + 1,
           updated_by = $6,
           updated_at = NOW()
       WHERE company_id = $7
       RETURNING
         company_id,
         config_version,
         feature_flags,
         workflow_policies,
         security_policies,
         mobile_policies,
         ui_branding,
         updated_by,
         updated_at`,
      [
        JSON.stringify(merged.feature_flags),
        JSON.stringify(merged.workflow_policies),
        JSON.stringify(merged.security_policies),
        JSON.stringify(merged.mobile_policies),
        JSON.stringify(merged.ui_branding),
        input.actorUserId ?? null,
        input.companyId,
      ]
    )

    const updated = mapRow(updatedResult.rows[0] as TenantSettingsRecord)
    await writeAudit(
      {
        companyId: input.companyId,
        actorUserId: input.actorUserId ?? null,
        actorType: "web",
        action: "settings.update",
        entityType: "tenant_settings",
        entityId: String(input.companyId),
        before: current.settings,
        after: updated.settings,
        req: input.req,
      },
      db
    )

    await db.query("COMMIT")
    invalidateEffectivePolicyCache(input.companyId)
    return updated
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
}
