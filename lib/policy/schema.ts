import { z } from "zod"

export class PolicyValidationError extends Error {
  issues: z.ZodIssue[]

  constructor(message: string, issues: z.ZodIssue[]) {
    super(message)
    this.name = "PolicyValidationError"
    this.issues = issues
  }
}

const featureFlagsSchema = z.record(z.string(), z.boolean()).default({})

const workflowPoliciesSchema = z
  .object({
    requireGateInBeforeGrn: z.boolean().default(false),
    requireQc: z.boolean().default(false),
    disallowDispatchIfPaymentHold: z.boolean().default(false),
  })
  .catchall(z.unknown())
  .default({
    requireGateInBeforeGrn: false,
    requireQc: false,
    disallowDispatchIfPaymentHold: false,
  })

const securityPoliciesSchema = z
  .object({
    mfaRequired: z.boolean().default(false),
    sessionTimeoutMins: z.number().int().min(5).max(1440).default(60),
  })
  .catchall(z.unknown())
  .default({
    mfaRequired: false,
    sessionTimeoutMins: 60,
  })

const mobilePoliciesSchema = z
  .object({
    offlineEnabled: z.boolean().default(true),
    scanMode: z.enum(["serial_only", "batch"]).default("serial_only"),
  })
  .catchall(z.unknown())
  .default({
    offlineEnabled: true,
    scanMode: "serial_only",
  })

const brandingSchema = z
  .object({
    logoUrl: z.string().default(""),
    primaryColor: z.string().default("#2563eb"),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .catchall(z.unknown())
  .default({
    logoUrl: "",
    primaryColor: "#2563eb",
    labels: {},
  })

export const tenantSettingsSchema = z.object({
  feature_flags: featureFlagsSchema,
  workflow_policies: workflowPoliciesSchema,
  security_policies: securityPoliciesSchema,
  mobile_policies: mobilePoliciesSchema,
  ui_branding: brandingSchema,
})

export type TenantSettingsShape = z.infer<typeof tenantSettingsSchema>

export function getDefaultTenantSettings(): TenantSettingsShape {
  return {
    feature_flags: {
      dashboard: true,
      grn: true,
      do: true,
      gate: true,
      stock: true,
      reports: true,
      billing: true,
      finance: true,
      portal: true,
      mobile: true,
      admin: true,
    },
    workflow_policies: {
      requireGateInBeforeGrn: false,
      requireQc: false,
      disallowDispatchIfPaymentHold: false,
    },
    security_policies: {
      mfaRequired: false,
      sessionTimeoutMins: 60,
    },
    mobile_policies: {
      offlineEnabled: true,
      scanMode: "serial_only",
    },
    ui_branding: {
      logoUrl: "",
      primaryColor: "#2563eb",
      labels: {},
    },
  }
}

export function validateTenantSettings(payload: unknown): TenantSettingsShape {
  const parsed = tenantSettingsSchema.safeParse(payload)
  if (!parsed.success) {
    throw new PolicyValidationError("Invalid tenant settings payload", parsed.error.issues)
  }
  return parsed.data
}

export function mergeTenantSettings(
  base: TenantSettingsShape,
  patch: Partial<TenantSettingsShape>
): TenantSettingsShape {
  return validateTenantSettings({
    feature_flags: { ...base.feature_flags, ...(patch.feature_flags || {}) },
    workflow_policies: { ...base.workflow_policies, ...(patch.workflow_policies || {}) },
    security_policies: { ...base.security_policies, ...(patch.security_policies || {}) },
    mobile_policies: { ...base.mobile_policies, ...(patch.mobile_policies || {}) },
    ui_branding: {
      ...base.ui_branding,
      ...(patch.ui_branding || {}),
      labels: {
        ...(base.ui_branding?.labels || {}),
        ...(patch.ui_branding?.labels || {}),
      },
    },
  })
}
