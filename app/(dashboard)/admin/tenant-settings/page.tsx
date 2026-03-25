"use client"

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"

type TenantSettingsPayload = {
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
]

export default function TenantSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [row, setRow] = useState<TenantSettingsPayload | null>(null)
  const [features, setFeatures] = useState<Record<string, boolean>>({})
  const [requireGateInBeforeGrn, setRequireGateInBeforeGrn] = useState(false)
  const [requireQc, setRequireQc] = useState(false)
  const [disallowDispatchIfPaymentHold, setDisallowDispatchIfPaymentHold] = useState(false)
  const [mfaRequired, setMfaRequired] = useState(false)
  const [sessionTimeoutMins, setSessionTimeoutMins] = useState("60")
  const [offlineEnabled, setOfflineEnabled] = useState(true)
  const [scanMode, setScanMode] = useState<"serial_only" | "batch">("serial_only")
  const [logoUrl, setLogoUrl] = useState("")
  const [primaryColor, setPrimaryColor] = useState("#2563eb")
  const [labelsText, setLabelsText] = useState("{}")

  const featureKeys = useMemo(() => {
    const keys = Object.keys(features || {})
    if (!keys.length) return defaultFeatures
    return Array.from(new Set([...defaultFeatures, ...keys]))
  }, [features])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const res = await fetch("/api/admin/tenant-settings", { cache: "no-store" })
      const json = await res.json()
      if (!res.ok) {
        toast.error(json?.error?.message || "Failed to load settings")
        setLoading(false)
        return
      }

      const data = json?.data as TenantSettingsPayload
      setRow(data)
      setFeatures(data.feature_flags || {})
      setRequireGateInBeforeGrn(Boolean(data.workflow_policies?.requireGateInBeforeGrn ?? false))
      setRequireQc(Boolean(data.workflow_policies?.requireQc ?? false))
      setDisallowDispatchIfPaymentHold(Boolean(data.workflow_policies?.disallowDispatchIfPaymentHold ?? false))
      setMfaRequired(Boolean(data.security_policies?.mfaRequired ?? false))
      setSessionTimeoutMins(String(data.security_policies?.sessionTimeoutMins ?? 60))
      setOfflineEnabled(Boolean(data.mobile_policies?.offlineEnabled ?? true))
      setScanMode((data.mobile_policies?.scanMode as "serial_only" | "batch") || "serial_only")
      setLogoUrl(data.ui_branding?.logoUrl || "")
      setPrimaryColor(data.ui_branding?.primaryColor || "#2563eb")
      setLabelsText(JSON.stringify(data.ui_branding?.labels || {}, null, 2))
      setLoading(false)
    })()
  }, [])

  async function onSave() {
    let labels: Record<string, string>
    try {
      labels = JSON.parse(labelsText || "{}")
    } catch {
      toast.error("Branding labels must be valid JSON")
      return
    }
    const parsedSessionTimeout = Number(sessionTimeoutMins)
    if (!Number.isFinite(parsedSessionTimeout) || parsedSessionTimeout < 5 || parsedSessionTimeout > 1440) {
      toast.error("Session timeout must be between 5 and 1440 minutes")
      return
    }

    setSaving(true)
    const res = await fetch("/api/admin/tenant-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feature_flags: features,
        workflow_policies: {
          requireGateInBeforeGrn,
          requireQc,
          disallowDispatchIfPaymentHold,
        },
        security_policies: {
          mfaRequired,
          sessionTimeoutMins: parsedSessionTimeout,
        },
        mobile_policies: { offlineEnabled, scanMode },
        ui_branding: { logoUrl, primaryColor, labels },
      }),
    })
    const json = await res.json()
    setSaving(false)
    if (!res.ok) {
      toast.error(json?.error?.message || "Failed to save settings")
      return
    }

    const updated = json?.data as TenantSettingsPayload
    setRow(updated)
    toast.success(`Saved. Config version ${updated.config_version}`)
  }

  if (loading) {
    return <div className="p-4 text-sm text-gray-500">Loading tenant settings...</div>
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Tenant Settings</CardTitle>
          <p className="text-sm text-gray-500">
            Config version: <span className="font-medium">{row?.config_version || 1}</span>
          </p>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Feature Flags</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {featureKeys.map((key) => (
            <label key={key} className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type="checkbox"
                checked={features[key] !== false}
                onChange={(e) => setFeatures((prev) => ({ ...prev, [key]: e.target.checked }))}
              />
              <span>{key}</span>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workflow Policies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireGateInBeforeGrn}
              onChange={(e) => setRequireGateInBeforeGrn(e.target.checked)}
            />
            Require Gate In Before GRN
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={requireQc}
              onChange={(e) => setRequireQc(e.target.checked)}
            />
            Require QC Before Dispatch
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={disallowDispatchIfPaymentHold}
              onChange={(e) => setDisallowDispatchIfPaymentHold(e.target.checked)}
            />
            Block Dispatch If Payment Hold
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Security Policies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mfaRequired}
              onChange={(e) => setMfaRequired(e.target.checked)}
            />
            MFA Required
          </label>
          <div className="space-y-2">
            <Label>Session Timeout (Minutes)</Label>
            <Input
              type="number"
              min={5}
              max={1440}
              value={sessionTimeoutMins}
              onChange={(e) => setSessionTimeoutMins(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Mobile Policies</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={offlineEnabled}
              onChange={(e) => setOfflineEnabled(e.target.checked)}
            />
            Offline Enabled
          </label>
          <div className="space-y-2">
            <Label>Scan Mode</Label>
            <select
              className="w-full rounded border px-3 py-2 text-sm"
              value={scanMode}
              onChange={(e) => setScanMode(e.target.value as "serial_only" | "batch")}
            >
              <option value="serial_only">serial_only</option>
              <option value="batch">batch</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Branding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Logo URL</Label>
            <Input value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Primary Color</Label>
            <Input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Labels (JSON)</Label>
            <textarea
              className="min-h-32 w-full rounded border px-3 py-2 font-mono text-xs"
              value={labelsText}
              onChange={(e) => setLabelsText(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving}>
          {saving ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  )
}
