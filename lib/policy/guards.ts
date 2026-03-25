import { fail } from "@/lib/api-response"
import type { EffectivePolicy } from "@/lib/policy/effective"

export class PolicyGuardError extends Error {
  code: string
  status: number

  constructor(code: string, message: string, status = 403) {
    super(message)
    this.name = "PolicyGuardError"
    this.code = code
    this.status = status
  }
}

type ScopeType = "warehouse" | "zone" | "client"

export function requireFeature(policy: EffectivePolicy, featureKey: string) {
  const enabled = policy.features[featureKey]
  if (enabled === false) {
    throw new PolicyGuardError(
      "FEATURE_DISABLED",
      `${featureKey} is disabled for this tenant`
    )
  }
}

export function requirePolicyPermission(policy: EffectivePolicy, permissionKey: string) {
  if (policy.permissions.includes(permissionKey)) return
  throw new PolicyGuardError(
    "PERMISSION_DENIED",
    `Missing permission: ${permissionKey}`
  )
}

export function requireScope(
  policy: EffectivePolicy,
  scopeType: ScopeType,
  scopeId: string | number | null | undefined
) {
  if (scopeId == null) return

  const target = String(scopeId)
  const allowed =
    scopeType === "warehouse"
      ? policy.scopes.warehouseIds
      : scopeType === "zone"
        ? policy.scopes.zoneIds
        : policy.scopes.clientIds

  // Empty scope list means unrestricted for that scope dimension.
  if (!allowed.length) return
  if (allowed.includes(target)) return

  throw new PolicyGuardError(
    "SCOPE_DENIED",
    `No ${scopeType} scope access for ${target}`
  )
}

type WorkflowContext = {
  gateInId?: string | number | null
  qcApproved?: boolean | null
  paymentHold?: boolean | null
}

export function enforceWorkflow(
  policy: EffectivePolicy,
  operation: "grn.create" | "do.dispatch" | string,
  _payload: unknown,
  ctx: WorkflowContext
) {
  if (
    operation === "grn.create" &&
    policy.workflow.requireGateInBeforeGrn === true &&
    !ctx.gateInId
  ) {
    throw new PolicyGuardError(
      "WORKFLOW_BLOCKED",
      "Gate In is required before GRN creation"
    )
  }

  if (
    operation === "do.dispatch" &&
    policy.workflow.requireQc === true &&
    !ctx.qcApproved
  ) {
    throw new PolicyGuardError(
      "WORKFLOW_BLOCKED",
      "QC approval is required before dispatch"
    )
  }

  if (
    operation === "do.dispatch" &&
    policy.workflow.disallowDispatchIfPaymentHold === true &&
    ctx.paymentHold
  ) {
    throw new PolicyGuardError(
      "WORKFLOW_BLOCKED",
      "Dispatch blocked due to payment hold"
    )
  }
}

export function guardToFailResponse(error: unknown) {
  if (error instanceof PolicyGuardError) {
    return fail(error.code, error.message, error.status)
  }
  return null
}
