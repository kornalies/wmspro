"use client"

import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/hooks/use-auth"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

type TenantSettingsPayload = {
  company_id?: number
  config_version: number
  feature_flags: Record<string, boolean>
  workflow_policies: {
    requireGateInBeforeGrn?: boolean
    requireQc?: boolean
    disallowDispatchIfPaymentHold?: boolean
    [key: string]: unknown
  }
  security_policies: {
    mfaRequired?: boolean
    sessionTimeoutMins?: number
    [key: string]: unknown
  }
  mobile_policies: {
    offlineEnabled?: boolean
    scanMode?: "serial_only" | "batch"
    [key: string]: unknown
  }
  ui_branding: {
    logoUrl?: string
    primaryColor?: string
    labels?: Record<string, string>
    [key: string]: unknown
  }
  updated_by: number | null
  updated_at: string
}

type DraftSettings = {
  feature_flags: Record<string, boolean>
  workflow_policies: Required<Pick<TenantSettingsPayload["workflow_policies"], "requireGateInBeforeGrn" | "requireQc" | "disallowDispatchIfPaymentHold">>
  security_policies: Required<Pick<TenantSettingsPayload["security_policies"], "mfaRequired" | "sessionTimeoutMins">>
  mobile_policies: Required<Pick<TenantSettingsPayload["mobile_policies"], "offlineEnabled" | "scanMode">>
  ui_branding: {
    logoUrl: string
    primaryColor: string
    labelsText: string
  }
}

type AuditRow = {
  id: number
  actor_user_id?: number | null
  action: string
  entity_type: string
  created_at: string
}

type PendingToggle = {
  key: string
  checked: boolean
  title: string
  description: string
} | null

const defaultFeatures = [
  "dashboard",
  "grn",
  "do",
  "gate",
  "stock",
  "reports",
  "billing",
  "finance",
  "portal",
  "mobile",
  "admin",
  "wes",
  "labor",
  "integrations",
]

const featureMeta: Record<string, { label: string; description: string; group: "Core WMS" | "Commercial" | "Platform"; risky?: boolean; dependencies?: string[] }> = {
  dashboard: { label: "Dashboard", description: "Executive and operational control center.", group: "Core WMS" },
  grn: { label: "Goods Receipt", description: "Inbound receiving, OCR/manual GRN, and stock posting.", group: "Core WMS", risky: true, dependencies: ["stock", "reports", "billing"] },
  do: { label: "Delivery Orders", description: "Outbound picking, staging, dispatch, and reversals.", group: "Core WMS", risky: true, dependencies: ["stock", "gate", "billing"] },
  gate: { label: "Gate Operations", description: "Inbound/outbound vehicle and document control.", group: "Core WMS", dependencies: ["grn", "do"] },
  stock: { label: "Inventory & Stock", description: "Stock ledger, serials, transfers, and availability.", group: "Core WMS", risky: true, dependencies: ["grn", "do", "reports", "billing"] },
  reports: { label: "Reports & Analytics", description: "Operational reports, exports, and analytics.", group: "Core WMS" },
  billing: { label: "Billing", description: "Charge calculation, invoices, credits, and recoveries.", group: "Commercial", risky: true, dependencies: ["finance", "reports"] },
  finance: { label: "Finance Controls", description: "Rate cards, contracts, reconciliation, and journals.", group: "Commercial", risky: true, dependencies: ["billing"] },
  portal: { label: "Client Portal", description: "Customer access for inventory, orders, ASN, and billing.", group: "Commercial" },
  mobile: { label: "Mobile Operations", description: "Mobile GRN approval and scanner-driven workflows.", group: "Platform", dependencies: ["grn"] },
  admin: { label: "Administration", description: "Tenant, users, scopes, companies, and security setup.", group: "Platform", risky: true },
  wes: { label: "Warehouse Execution", description: "Automation equipment, events, incidents, and commands.", group: "Platform", dependencies: ["stock"] },
  labor: { label: "Labor Management", description: "Productivity, shifts, standards, and exceptions.", group: "Platform" },
  integrations: { label: "Integrations", description: "External connectors, event dispatch, and data mappings.", group: "Platform", risky: true },
}

const workflowPolicies = [
  {
    key: "requireGateInBeforeGrn" as const,
    label: "Require Gate In Before GRN",
    description: "Blocks receipt creation unless a matching gate-in process exists.",
  },
  {
    key: "requireQc" as const,
    label: "Require QC Before Dispatch",
    description: "Prevents dispatch until required quality checks are completed.",
  },
  {
    key: "disallowDispatchIfPaymentHold" as const,
    label: "Block Dispatch If Payment Hold",
    description: "Stops outbound dispatch for clients with payment or credit holds.",
  },
]

function buildDraft(data: TenantSettingsPayload): DraftSettings {
  return {
    feature_flags: data.feature_flags || {},
    workflow_policies: {
      requireGateInBeforeGrn: Boolean(data.workflow_policies?.requireGateInBeforeGrn ?? false),
      requireQc: Boolean(data.workflow_policies?.requireQc ?? false),
      disallowDispatchIfPaymentHold: Boolean(data.workflow_policies?.disallowDispatchIfPaymentHold ?? false),
    },
    security_policies: {
      mfaRequired: Boolean(data.security_policies?.mfaRequired ?? false),
      sessionTimeoutMins: Number(data.security_policies?.sessionTimeoutMins ?? 60),
    },
    mobile_policies: {
      offlineEnabled: Boolean(data.mobile_policies?.offlineEnabled ?? true),
      scanMode: (data.mobile_policies?.scanMode as "serial_only" | "batch") || "serial_only",
    },
    ui_branding: {
      logoUrl: data.ui_branding?.logoUrl || "",
      primaryColor: data.ui_branding?.primaryColor || "#2563eb",
      labelsText: JSON.stringify(data.ui_branding?.labels || {}, null, 2),
    },
  }
}

function formatDateTime(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })
}

function enabledValue(flags: Record<string, boolean>, key: string) {
  return flags[key] !== false
}

export default function TenantSettingsPage() {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [row, setRow] = useState<TenantSettingsPayload | null>(null)
  const [draft, setDraft] = useState<DraftSettings | null>(null)
  const [baseline, setBaseline] = useState("")
  const [query, setQuery] = useState("")
  const [section, setSection] = useState("all")
  const [pendingToggle, setPendingToggle] = useState<PendingToggle>(null)
  const [auditRows, setAuditRows] = useState<AuditRow[]>([])
  const [auditAvailable, setAuditAvailable] = useState(true)

  const featureKeys = useMemo(() => {
    const keys = Object.keys(draft?.feature_flags || {})
    return Array.from(new Set([...defaultFeatures, ...keys]))
  }, [draft?.feature_flags])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleFeatureKeys = featureKeys.filter((key) => {
    const meta = featureMeta[key]
    const groupMatches = section === "all" || meta?.group === section
    const searchText = `${key} ${meta?.label || ""} ${meta?.description || ""}`.toLowerCase()
    return groupMatches && (!normalizedQuery || searchText.includes(normalizedQuery))
  })

  const dirty = draft ? JSON.stringify(draft) !== baseline : false
  const enabledCount = featureKeys.filter((key) => enabledValue(draft?.feature_flags || {}, key)).length
  const disabledRisky = featureKeys.filter((key) => featureMeta[key]?.risky && !enabledValue(draft?.feature_flags || {}, key))
  const dependencyWarnings = featureKeys.flatMap((key) => {
    if (enabledValue(draft?.feature_flags || {}, key)) return []
    const dependents = featureMeta[key]?.dependencies || []
    const impacted = dependents.filter((dep) => enabledValue(draft?.feature_flags || {}, dep))
    return impacted.length ? [`${featureMeta[key]?.label || key} is off while ${impacted.map((dep) => featureMeta[dep]?.label || dep).join(", ")} remains enabled.`] : []
  })
  const workflowStrictness = draft ? workflowPolicies.filter((policy) => draft.workflow_policies[policy.key]).length : 0
  const riskFlags = [
    ...disabledRisky.map((key) => `${featureMeta[key]?.label || key} disabled`),
    ...dependencyWarnings,
    ...(draft && !draft.security_policies.mfaRequired ? ["MFA is not required"] : []),
    ...(draft && draft.security_policies.sessionTimeoutMins > 480 ? ["Long session timeout"] : []),
  ]

  async function loadSettings() {
    setLoading(true)
    const res = await fetch("/api/admin/tenant-settings", { cache: "no-store" })
    const json = await res.json()
    if (!res.ok) {
      toast.error(json?.error?.message || "Failed to load settings")
      setLoading(false)
      return
    }
    const data = json?.data as TenantSettingsPayload
    const nextDraft = buildDraft(data)
    setRow(data)
    setDraft(nextDraft)
    setBaseline(JSON.stringify(nextDraft))
    setLoading(false)
  }

  async function loadAuditRows() {
    const res = await fetch("/api/admin/audit?action=settings.update&entity_type=tenant_settings&limit=5", { cache: "no-store" })
    const json = await res.json()
    if (!res.ok) {
      setAuditAvailable(false)
      return
    }
    setAuditAvailable(true)
    setAuditRows((json?.data?.rows || []) as AuditRow[])
  }

  useEffect(() => {
    void Promise.resolve().then(loadSettings)
    void Promise.resolve().then(loadAuditRows)
  }, [])

  function updateFeature(key: string, checked: boolean, confirmed = false) {
    if (!draft) return
    const meta = featureMeta[key]
    const turningOff = !checked && enabledValue(draft.feature_flags, key)
    if (turningOff && meta?.risky && !confirmed) {
      setPendingToggle({
        key,
        checked,
        title: `Disable ${meta.label}?`,
        description: `${meta.description} Related workflows may stop immediately for this tenant.`,
      })
      return
    }
    setDraft({
      ...draft,
      feature_flags: { ...draft.feature_flags, [key]: checked },
    })
  }

  function discardChanges() {
    if (!row) return
    const nextDraft = buildDraft(row)
    setDraft(nextDraft)
    setBaseline(JSON.stringify(nextDraft))
    toast.info("Unsaved tenant settings discarded")
  }

  async function onSave() {
    if (!draft) return
    let labels: Record<string, string>
    try {
      labels = JSON.parse(draft.ui_branding.labelsText || "{}")
    } catch {
      toast.error("Branding labels must be valid JSON")
      return
    }
    if (!Number.isFinite(draft.security_policies.sessionTimeoutMins) || draft.security_policies.sessionTimeoutMins < 5 || draft.security_policies.sessionTimeoutMins > 1440) {
      toast.error("Session timeout must be between 5 and 1440 minutes")
      return
    }

    setSaving(true)
    const res = await fetch("/api/admin/tenant-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feature_flags: draft.feature_flags,
        workflow_policies: draft.workflow_policies,
        security_policies: draft.security_policies,
        mobile_policies: draft.mobile_policies,
        ui_branding: {
          logoUrl: draft.ui_branding.logoUrl,
          primaryColor: draft.ui_branding.primaryColor,
          labels,
        },
      }),
    })
    const json = await res.json()
    setSaving(false)
    if (!res.ok) {
      toast.error(json?.error?.message || "Failed to save settings")
      return
    }

    const updated = json?.data as TenantSettingsPayload
    const nextDraft = buildDraft(updated)
    setRow(updated)
    setDraft(nextDraft)
    setBaseline(JSON.stringify(nextDraft))
    await loadAuditRows()
    toast.success(`Saved. Config version ${updated.config_version}`)
  }

  if (loading || !draft) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-5 pb-24">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Tenant Settings</h1>
          <p className="mt-1 text-slate-600">Production controls for products, workflow enforcement, security, mobile, and branding.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <Badge variant="outline">Config v{row?.config_version || 1}</Badge>
            <Badge variant="outline">{user?.company_name || user?.company_code || `Company ${row?.company_id || ""}`}</Badge>
            <Badge variant="outline">Environment: Production</Badge>
            <span>Updated {formatDateTime(row?.updated_at)} by {row?.updated_by ? `User ${row.updated_by}` : "system"}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => { void loadSettings(); void loadAuditRows() }}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button variant="outline" onClick={discardChanges} disabled={!dirty}>
            <RotateCcw className="h-4 w-4" />
            Discard
          </Button>
          <Button onClick={onSave} disabled={saving || !dirty} className="bg-blue-600 hover:bg-blue-700">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save Changes
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <CardTitle>Product Access</CardTitle>
                <div className="grid gap-2 md:grid-cols-[1fr_180px]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="Search settings" />
                  </div>
                  <Select value={section} onValueChange={setSection}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Groups</SelectItem>
                      <SelectItem value="Core WMS">Core WMS</SelectItem>
                      <SelectItem value="Commercial">Commercial</SelectItem>
                      <SelectItem value="Platform">Platform</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visibleFeatureKeys.map((key) => {
                const meta = featureMeta[key] || { label: key, description: "Custom tenant feature flag.", group: "Platform" as const }
                const enabled = enabledValue(draft.feature_flags, key)
                return (
                  <div key={key} className="rounded-md border bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-slate-900">{meta.label}</h3>
                          {meta.risky ? <Badge className="border-amber-200 bg-amber-50 text-amber-700">High impact</Badge> : null}
                        </div>
                        <p className="mt-1 text-sm text-slate-500">{meta.description}</p>
                      </div>
                      <Switch checked={enabled} onChange={(checked) => updateFeature(key, checked)} label={`${meta.label} access`} />
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="outline">{meta.group}</Badge>
                      <Badge className={enabled ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}>{enabled ? "Enabled" : "Disabled"}</Badge>
                      {meta.dependencies?.length ? <Badge variant="outline">Impacts {meta.dependencies.length}</Badge> : null}
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Workflow Controls</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {workflowPolicies.map((policy) => (
                <PolicyTile
                  key={policy.key}
                  title={policy.label}
                  description={policy.description}
                  checked={Boolean(draft.workflow_policies[policy.key])}
                  onChange={(checked) => setDraft({
                    ...draft,
                    workflow_policies: { ...draft.workflow_policies, [policy.key]: checked },
                  })}
                />
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Security Policies</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <PolicyTile
                  title="MFA Required"
                  description="Requires multi-factor authentication for all tenant users."
                  checked={draft.security_policies.mfaRequired}
                  onChange={(checked) => setDraft({
                    ...draft,
                    security_policies: { ...draft.security_policies, mfaRequired: checked },
                  })}
                />
                <div className="space-y-2">
                  <Label>Session Timeout (Minutes)</Label>
                  <Input
                    type="number"
                    min={5}
                    max={1440}
                    value={draft.security_policies.sessionTimeoutMins}
                    onChange={(event) => setDraft({
                      ...draft,
                      security_policies: { ...draft.security_policies, sessionTimeoutMins: Number(event.target.value) },
                    })}
                  />
                  <p className="text-xs text-slate-500">Recommended production range is 30 to 240 minutes.</p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Mobile & Scanner Policies</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <PolicyTile
                  title="Offline Mobile Mode"
                  description="Allows mobile operations to queue work during network interruptions."
                  checked={draft.mobile_policies.offlineEnabled}
                  onChange={(checked) => setDraft({
                    ...draft,
                    mobile_policies: { ...draft.mobile_policies, offlineEnabled: checked },
                  })}
                />
                <div className="space-y-2">
                  <Label>Scan Mode</Label>
                  <Select
                    value={draft.mobile_policies.scanMode}
                    onValueChange={(value) => setDraft({
                      ...draft,
                      mobile_policies: { ...draft.mobile_policies, scanMode: value as "serial_only" | "batch" },
                    })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="serial_only">Serial Only</SelectItem>
                      <SelectItem value="batch">Batch</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Branding & Labels</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-2">
                <Label>Logo URL</Label>
                <Input value={draft.ui_branding.logoUrl} onChange={(event) => setDraft({ ...draft, ui_branding: { ...draft.ui_branding, logoUrl: event.target.value } })} />
              </div>
              <div className="space-y-2">
                <Label>Primary Color</Label>
                <div className="flex gap-2">
                  <Input value={draft.ui_branding.primaryColor} onChange={(event) => setDraft({ ...draft, ui_branding: { ...draft.ui_branding, primaryColor: event.target.value } })} />
                  <div className="h-10 w-12 rounded-md border" style={{ backgroundColor: draft.ui_branding.primaryColor }} />
                </div>
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label>Labels JSON</Label>
                <Textarea
                  className="min-h-32 font-mono text-xs"
                  value={draft.ui_branding.labelsText}
                  onChange={(event) => setDraft({ ...draft, ui_branding: { ...draft.ui_branding, labelsText: event.target.value } })}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><SlidersHorizontal className="h-5 w-5" /> Effective Policy Preview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <SummaryRow label="Enabled Products" value={`${enabledCount}/${featureKeys.length}`} tone="text-blue-700" />
              <SummaryRow label="Workflow Strictness" value={`${workflowStrictness}/${workflowPolicies.length}`} tone={workflowStrictness ? "text-emerald-700" : "text-amber-700"} />
              <SummaryRow label="Security Posture" value={draft.security_policies.mfaRequired ? "MFA required" : "MFA optional"} tone={draft.security_policies.mfaRequired ? "text-emerald-700" : "text-amber-700"} />
              <SummaryRow label="Session Timeout" value={`${draft.security_policies.sessionTimeoutMins} mins`} tone={draft.security_policies.sessionTimeoutMins <= 240 ? "text-emerald-700" : "text-amber-700"} />
              <div className="rounded-md border bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-900">Risk Flags</p>
                <div className="mt-2 space-y-2">
                  {riskFlags.length ? riskFlags.slice(0, 5).map((flag) => (
                    <div key={flag} className="flex gap-2 text-sm text-amber-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{flag}</span>
                    </div>
                  )) : (
                    <div className="flex gap-2 text-sm text-emerald-700">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>No major risks detected.</span>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><History className="h-5 w-5" /> Recent Config Changes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!auditAvailable ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                  Audit history is unavailable for your current permissions.
                </div>
              ) : auditRows.length ? auditRows.map((item) => (
                <div key={item.id} className="rounded-md border p-3 text-sm">
                  <p className="font-medium text-slate-900">{item.action}</p>
                  <p className="text-slate-500">{formatDateTime(item.created_at)} by {item.actor_user_id ? `User ${item.actor_user_id}` : "system"}</p>
                </div>
              )) : (
                <p className="text-sm text-slate-500">No recent tenant setting changes found.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" /> Production Guardrails</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-slate-600">
              <p>High-impact product toggles require confirmation before they can be disabled.</p>
              <p>Dependency warnings are shown when a disabled module can affect active workflows.</p>
              <p>All saved changes increment config version and write an audit event.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {dirty ? (
        <div className="fixed bottom-4 left-[304px] right-6 z-40 rounded-lg border bg-white p-3 shadow-lg">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-semibold text-slate-900">Unsaved tenant setting changes</p>
              <p className="text-sm text-slate-500">Review dependency warnings before applying changes to production workflows.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={discardChanges}>Discard</Button>
              <Button onClick={onSave} disabled={saving} className="bg-blue-600 hover:bg-blue-700">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog open={Boolean(pendingToggle)} onOpenChange={(open) => !open && setPendingToggle(null)}>
        <DialogContent>
          <DialogHeader>
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-red-50 text-red-600">
              <Lock className="h-5 w-5" />
            </div>
            <DialogTitle>{pendingToggle?.title}</DialogTitle>
            <DialogDescription>{pendingToggle?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingToggle(null)}>Keep Enabled</Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!pendingToggle) return
                updateFeature(pendingToggle.key, pendingToggle.checked, true)
                setPendingToggle(null)
              }}
            >
              Disable Feature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition ${checked ? "bg-blue-600" : "bg-slate-300"}`}
    >
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${checked ? "left-6" : "left-1"}`} />
    </button>
  )
}

function PolicyTile({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="rounded-md border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{description}</p>
        </div>
        <Switch checked={checked} onChange={onChange} label={title} />
      </div>
      <Badge className={`mt-3 ${checked ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-600"}`}>
        {checked ? "Enforced" : "Not enforced"}
      </Badge>
    </div>
  )
}

function SummaryRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex items-center justify-between border-b pb-3 last:border-b-0 last:pb-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm font-semibold ${tone}`}>{value}</span>
    </div>
  )
}
