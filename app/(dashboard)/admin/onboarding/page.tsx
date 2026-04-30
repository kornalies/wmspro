"use client"

import Link from "next/link"
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Circle,
  Clock3,
  Download,
  FileSpreadsheet,
  History,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Upload,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

type StepStatus = "pending" | "done" | "blocked" | "review"
type CheckStatus = "passed" | "warning" | "blocked"

type OnboardingSummary = {
  completion_pct: number
  done_steps: number
  total_steps: number
  remaining_mins: number
  readiness_status: "Blocked" | "Needs Review" | "Ready" | "Live"
  environment_status: "Sandbox" | "Pilot" | "Production"
  blocked_steps: number
  review_steps: number
  tenant: {
    id: number
    company_code: string
    company_name: string
    domain?: string | null
    storage_bucket?: string | null
    subscription_plan?: string | null
    billing_status?: string | null
    is_active: boolean
    products: string[]
    owner_name?: string | null
    owner_email?: string | null
    created_at?: string | null
    updated_at?: string | null
  } | null
  counts: {
    warehouses: number
    clients: number
    items: number
    users: number
    contracts: number
    billing_profiles: number
    portal_mappings: number
    opening_stock: number
  }
  steps: Array<{
    id: string
    title: string
    eta_mins: number
    status: StepStatus
    detail: string
    href: string
    phase: "Tenant Setup" | "Master Data" | "Billing" | "Portal" | "Validation" | "Go Live"
    owner: string
    dependency?: string
    evidence?: string
  }>
  validation_checks: Array<{
    id: string
    title: string
    status: CheckStatus
    detail: string
    href?: string
  }>
  import_history: Array<{
    action: string
    type: string
    file_name: string
    total_rows: number
    inserted: number
    updated: number
    errors: number
    created_at: string
  }>
  activity: Array<{
    action: string
    entity_type?: string | null
    entity_id?: string | null
    created_at: string
    after?: Record<string, unknown> | null
  }>
}

type ImportError = {
  row: number
  message: string
}

type ImportMeta = {
  summary: string
  errors: ImportError[]
  fileName?: string
  totalRows?: number
  inserted?: number
  updated?: number
}

type ImportPreview = {
  fileName: string
  rows: number
  columns: number
  duplicateRows: number
  missingRequired: number
  valid: boolean
}

const templates = [
  {
    key: "clients",
    label: "Clients",
    href: "/templates/clients_template.csv",
    required: ["client_code", "client_name"],
    version: "v1.0",
  },
  {
    key: "items",
    label: "Items",
    href: "/templates/items_template.csv",
    required: ["item_code", "item_name", "uom"],
    version: "v1.0",
  },
  {
    key: "users",
    label: "Users",
    href: "/templates/users_template.csv",
    required: ["username", "full_name", "email", "role"],
    version: "v1.0",
  },
  {
    key: "opening-stock",
    label: "Opening Stock",
    href: "/templates/opening_stock_template.csv",
    required: ["warehouse_code", "client_code", "item_code", "serial_number"],
    version: "v1.0",
  },
  {
    key: "rate-cards",
    label: "Rate Cards",
    href: "/templates/rate_cards_template.csv",
    required: ["client_code", "rate_card_code", "rate_card_name", "effective_from", "charge_type", "unit_rate"],
    version: "v1.0",
  },
]

const phases = ["Tenant Setup", "Master Data", "Billing", "Portal", "Validation", "Go Live"] as const

function formatDateTime(value?: string | null) {
  if (!value) return "Not available"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Not available"
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

function statusBadge(status: StepStatus | CheckStatus | string) {
  if (status === "done" || status === "passed" || status === "Ready" || status === "Live") {
    return "bg-emerald-100 text-emerald-800"
  }
  if (status === "review" || status === "warning" || status === "Needs Review") {
    return "bg-amber-100 text-amber-800"
  }
  if (status === "blocked" || status === "Blocked") return "bg-red-100 text-red-800"
  return "bg-slate-100 text-slate-800"
}

function StatusIcon({ status }: { status: StepStatus | CheckStatus }) {
  if (status === "done" || status === "passed") return <CheckCircle2 className="h-5 w-5 text-emerald-600" />
  if (status === "blocked") return <XCircle className="h-5 w-5 text-red-600" />
  if (status === "review" || status === "warning") return <AlertTriangle className="h-5 w-5 text-amber-600" />
  return <Circle className="h-5 w-5 text-gray-400" />
}

function parseCsvPreview(text: string, required: string[], fileName: string): ImportPreview {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  const headers = (lines[0] || "").split(",").map((h) => h.trim())
  const dataRows = lines.slice(1)
  const seen = new Set<string>()
  let duplicateRows = 0
  let missingRequired = 0

  for (const row of dataRows) {
    const normalized = row.trim().toLowerCase()
    if (seen.has(normalized)) duplicateRows++
    seen.add(normalized)
    const cells = row.split(",").map((cell) => cell.trim())
    const rowMap = new Map(headers.map((header, index) => [header, cells[index] || ""]))
    if (required.some((field) => !rowMap.get(field))) missingRequired++
  }

  const missingHeaders = required.filter((field) => !headers.includes(field)).length
  return {
    fileName,
    rows: dataRows.length,
    columns: headers.length,
    duplicateRows,
    missingRequired: missingRequired + missingHeaders,
    valid: dataRows.length > 0 && missingHeaders === 0 && missingRequired === 0,
  }
}

export default function OnboardingPage() {
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [previews, setPreviews] = useState<Record<string, ImportPreview>>({})
  const [uploadingKey, setUploadingKey] = useState<string>("")
  const [importResults, setImportResults] = useState<Record<string, ImportMeta>>({})
  const [activeTab, setActiveTab] = useState("overview")

  const summaryQuery = useQuery({
    queryKey: ["onboarding", "summary"],
    queryFn: async () => {
      const res = await apiClient.get<OnboardingSummary>("/onboarding/summary")
      return res.data as OnboardingSummary
    },
  })

  const autoSeedMutation = useMutation({
    mutationFn: async () =>
      apiClient.post<{
        admin_seeded: number
        client_seeded: number
        total_active_mappings: number
      }>("/portal/mappings/auto-seed"),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["onboarding", "summary"] })
      toast.success(
        `Portal mapping complete. Added admin: ${res.data?.admin_seeded ?? 0}, client: ${res.data?.client_seeded ?? 0}`
      )
    },
    onError: (error) => handleError(error, "Failed to auto-seed portal mappings"),
  })

  const data = summaryQuery.data
  const nextAction = useMemo(() => {
    return data?.steps.find((step) => step.status === "blocked") || data?.steps.find((step) => step.status !== "done")
  }, [data?.steps])

  const phaseProgress = useMemo(() => {
    return phases.map((phase) => {
      const steps = data?.steps.filter((step) => step.phase === phase) ?? []
      const done = steps.filter((step) => step.status === "done").length
      return {
        phase,
        done,
        total: steps.length,
        blocked: steps.some((step) => step.status === "blocked"),
      }
    })
  }, [data?.steps])

  function downloadErrorsCsv(type: string, errors: ImportError[]) {
    if (!errors.length) return
    const lines = ["row,message", ...errors.map((e) => `${e.row},"${String(e.message).replace(/"/g, '""')}"`)]
    const csv = `${lines.join("\n")}\n`
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${type}_import_errors.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  async function selectFile(type: string, file: File | null) {
    setFiles((prev) => ({ ...prev, [type]: file }))
    if (!file) return
    const template = templates.find((item) => item.key === type)
    const text = await file.text()
    setPreviews((prev) => ({
      ...prev,
      [type]: parseCsvPreview(text, template?.required ?? [], file.name),
    }))
  }

  async function handleImport(type: string) {
    const file = files[type]
    const preview = previews[type]
    if (!file) {
      toast.error("Select a CSV file first")
      return
    }
    if (preview && !preview.valid) {
      toast.error("Fix CSV validation issues before import")
      return
    }
    setUploadingKey(type)
    try {
      const formData = new FormData()
      formData.append("file", file)
      const res = await fetch(`/api/onboarding/import/${type}`, {
        method: "POST",
        body: formData,
        credentials: "include",
      })
      const json = await res.json()
      if (!res.ok || json?.success === false) {
        throw new Error(json?.error?.message || "Import failed")
      }
      const d = json?.data || {}
      const errors = (Array.isArray(d.errors) ? d.errors : []) as ImportError[]
      const summary = `Rows: ${d.total_rows || 0}, inserted: ${d.inserted || 0}, updated: ${d.updated || 0}, errors: ${errors.length}`
      setImportResults((prev) => ({
        ...prev,
        [type]: {
          summary,
          errors,
          fileName: d.file_name,
          totalRows: d.total_rows,
          inserted: d.inserted,
          updated: d.updated,
        },
      }))
      toast.success(`${type} import completed`)
      queryClient.invalidateQueries({ queryKey: ["onboarding", "summary"] })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Import failed"
      setImportResults((prev) => ({
        ...prev,
        [type]: { summary: `Failed: ${message}`, errors: [] },
      }))
      toast.error(message)
    } finally {
      setUploadingKey("")
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold">Tenant Onboarding</h1>
            <Badge className="bg-blue-100 text-blue-800">90-minute mode</Badge>
            <Badge className={statusBadge(data?.readiness_status || "Blocked")}>
              {data?.readiness_status || "Loading"}
            </Badge>
            <Badge className="bg-slate-100 text-slate-800">{data?.environment_status || "Sandbox"}</Badge>
          </div>
          <p className="mt-1 text-gray-500">Controlled tenant launch workspace for setup, imports, validation, and go-live.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => summaryQuery.refetch()} disabled={summaryQuery.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${summaryQuery.isFetching ? "animate-spin" : ""}`} />
            Refresh Status
          </Button>
          <Button disabled={data?.readiness_status !== "Ready"} className="bg-emerald-600 hover:bg-emerald-700">
            <Rocket className="mr-2 h-4 w-4" />
            Go Live
          </Button>
        </div>
      </div>

      {summaryQuery.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Unable to load onboarding state</AlertTitle>
          <AlertDescription>Refresh the page before running imports or go-live checks.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
        <Card>
          <CardContent className="space-y-5 pt-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm text-gray-500">Selected tenant</p>
                <h2 className="text-xl font-semibold">{data?.tenant?.company_name || "Tenant context unavailable"}</h2>
                <p className="font-mono text-xs text-gray-500">{data?.tenant?.company_code || "No company code"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge className="bg-sky-100 text-sky-800">{data?.tenant?.subscription_plan || "BASIC"}</Badge>
                <Badge className="bg-slate-100 text-slate-800">{data?.tenant?.billing_status || "TRIAL"}</Badge>
                {(data?.tenant?.products?.length ? data.tenant.products : ["WMS"]).map((product) => (
                  <Badge key={product} className="bg-indigo-100 text-indigo-800">{product}</Badge>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-sm">
                <p className="font-medium">Evidence-based completion</p>
                <p className="text-gray-600">{data?.done_steps ?? 0}/{data?.total_steps ?? 0} verified tasks</p>
              </div>
              <div className="h-3 w-full rounded-full bg-gray-200">
                <div
                  className={`h-3 rounded-full transition-all ${
                    data?.readiness_status === "Blocked" ? "bg-red-500" : data?.readiness_status === "Needs Review" ? "bg-amber-500" : "bg-emerald-600"
                  }`}
                  style={{ width: `${data?.completion_pct ?? 0}%` }}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
                <p>{data?.completion_pct ?? 0}% completed</p>
                <p>Remaining work: {data?.remaining_mins ?? 0} mins</p>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {[
                ["Imports", `${data?.import_history?.length ?? 0}`, FileSpreadsheet],
                ["Validation Issues", `${(data?.validation_checks ?? []).filter((check) => check.status !== "passed").length}`, AlertTriangle],
                ["Blocked Tasks", `${data?.blocked_steps ?? 0}`, XCircle],
                ["Last Activity", data?.activity?.[0] ? formatDateTime(data.activity[0].created_at) : "None", History],
              ].map(([label, value, Icon]) => (
                <div key={String(label)} className="rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm text-gray-500">{String(label)}</p>
                    <Icon className="h-4 w-4 text-blue-600" />
                  </div>
                  <p className="mt-2 text-lg font-semibold">{String(value)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Next Recommended Action</CardTitle>
            <CardDescription>Prioritized from blocked and incomplete launch tasks.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {nextAction ? (
              <>
                <div className="flex items-start gap-3 rounded-lg border p-3">
                  <StatusIcon status={nextAction.status} />
                  <div>
                    <p className="font-medium">{nextAction.title}</p>
                    <p className="mt-1 text-sm text-gray-600">{nextAction.detail}</p>
                    {nextAction.dependency && <p className="mt-1 text-xs text-gray-500">Depends on: {nextAction.dependency}</p>}
                  </div>
                </div>
                <Button asChild className="w-full bg-blue-600 hover:bg-blue-700">
                  <Link href={nextAction.href}>
                    Open Task <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </>
            ) : (
              <div className="rounded-lg border p-3 text-sm text-gray-600">All onboarding tasks are verified.</div>
            )}
            <div className="rounded-lg border bg-slate-50 p-3 text-sm">
              <p className="font-medium">Tenant owner</p>
              <p className="mt-1 text-gray-600">{data?.tenant?.owner_name || "Unassigned"}</p>
              <p className="text-xs text-gray-500">{data?.tenant?.owner_email || "No owner email configured"}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="imports">Imports</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="validation">Validation</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Launch Phases</CardTitle>
              <CardDescription>Phases move forward only when supporting evidence exists.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 lg:grid-cols-3">
                {phaseProgress.map((phase) => (
                  <div key={phase.phase} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{phase.phase}</p>
                      <Badge className={phase.blocked ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}>
                        {phase.done}/{phase.total || 0}
                      </Badge>
                    </div>
                    <div className="mt-3 h-2 rounded-full bg-slate-100">
                      <div
                        className={`h-2 rounded-full ${phase.blocked ? "bg-red-500" : "bg-emerald-600"}`}
                        style={{ width: `${phase.total ? (phase.done / phase.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="imports" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Data Imports</CardTitle>
              <CardDescription>Download the current template, validate locally, import, and review batch history.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {templates.map((template) => {
                const preview = previews[template.key]
                const result = importResults[template.key]
                return (
                  <div key={template.key} className="rounded-lg border p-4">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{template.label}</p>
                          <Badge className="bg-slate-100 text-slate-800">{template.version}</Badge>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          Required: {template.required.join(", ")}. Accepted: CSV, max practical size 5 MB.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" size="sm">
                          <a href={template.href} download>
                            <Download className="mr-2 h-4 w-4" />
                            Template
                          </a>
                        </Button>
                        <label className="inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm font-medium hover:bg-slate-50">
                          Choose CSV
                          <input
                            type="file"
                            accept=".csv,text/csv"
                            className="sr-only"
                            onChange={(e) => selectFile(template.key, e.target.files?.[0] || null)}
                          />
                        </label>
                        <Button
                          size="sm"
                          onClick={() => handleImport(template.key)}
                          disabled={uploadingKey === template.key || !files[template.key] || (preview ? !preview.valid : false)}
                        >
                          <Upload className="mr-2 h-4 w-4" />
                          Import
                        </Button>
                      </div>
                    </div>

                    {preview && (
                      <div className="mt-3 grid gap-2 md:grid-cols-5">
                        {[
                          ["File", preview.fileName],
                          ["Rows", preview.rows],
                          ["Columns", preview.columns],
                          ["Duplicates", preview.duplicateRows],
                          ["Missing Required", preview.missingRequired],
                        ].map(([label, value]) => (
                          <div key={String(label)} className="rounded-md bg-slate-50 p-2">
                            <p className="text-xs text-gray-500">{String(label)}</p>
                            <p className="text-sm font-medium">{String(value)}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {result && (
                      <div className="mt-3 rounded-md bg-slate-50 p-3">
                        <p className="text-sm">{result.summary}</p>
                        {result.errors.length > 0 && (
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto p-0 text-sm"
                            onClick={() => downloadErrorsCsv(template.key, result.errors)}
                          >
                            Download Errors CSV
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Import History</CardTitle>
              <CardDescription>Recorded from onboarding import audit events.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(data?.import_history ?? []).length ? (
                data!.import_history.map((item) => (
                  <div key={`${item.action}-${item.created_at}`} className="flex flex-col gap-2 rounded-lg border p-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="font-medium">{item.file_name}</p>
                      <p className="text-sm text-gray-500">{item.type} import at {formatDateTime(item.created_at)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Badge className="bg-slate-100 text-slate-800">Rows {item.total_rows}</Badge>
                      <Badge className="bg-emerald-100 text-emerald-800">Inserted {item.inserted}</Badge>
                      <Badge className="bg-blue-100 text-blue-800">Updated {item.updated}</Badge>
                      <Badge className={item.errors ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}>Errors {item.errors}</Badge>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">
                  No import batches recorded yet.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tasks" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <CardTitle className="text-base">Execution Tasks</CardTitle>
                  <CardDescription>Owners, dependencies, actions, and evidence for each launch task.</CardDescription>
                </div>
                <Button
                  onClick={() => autoSeedMutation.mutate()}
                  disabled={autoSeedMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700"
                >
                  Auto-Seed Portal Mapping
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {(data?.steps ?? []).map((step) => (
                <div key={step.id} className="rounded-lg border p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex items-start gap-3">
                      <StatusIcon status={step.status} />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{step.title}</p>
                          <Badge className={statusBadge(step.status)}>{step.status}</Badge>
                          <Badge className="bg-slate-100 text-slate-800">{step.phase}</Badge>
                        </div>
                        <p className="mt-1 text-sm text-gray-600">{step.detail}</p>
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                          <span>Owner: {step.owner}</span>
                          <span>ETA: {step.eta_mins}m</span>
                          {step.dependency && <span>Depends on: {step.dependency}</span>}
                        </div>
                        {step.evidence && <p className="mt-2 text-xs text-emerald-700">Evidence: {step.evidence}</p>}
                      </div>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <Link href={step.href}>Open</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="validation" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Go-Live Validation</CardTitle>
              <CardDescription>Production launch remains blocked until critical checks pass and review tasks are approved.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(data?.validation_checks ?? []).map((check) => (
                <div key={check.id} className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-start gap-3">
                    <StatusIcon status={check.status} />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{check.title}</p>
                        <Badge className={statusBadge(check.status)}>{check.status}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{check.detail}</p>
                    </div>
                  </div>
                  {check.href && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={check.href}>Resolve</Link>
                    </Button>
                  )}
                </div>
              ))}
              <Alert>
                <ShieldCheck />
                <AlertTitle>Approval Gate</AlertTitle>
                <AlertDescription>
                  The Go Live action is enabled only when required setup, billing, portal, product entitlement, and validation checks are clear.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Onboarding Activity</CardTitle>
              <CardDescription>Immutable audit events related to tenant setup and import jobs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(data?.activity ?? []).length ? (
                data!.activity.map((item) => (
                  <div key={`${item.action}-${item.created_at}`} className="flex items-start gap-3 rounded-lg border p-4">
                    <Clock3 className="mt-0.5 h-5 w-5 text-blue-600" />
                    <div>
                      <p className="font-medium">{item.action}</p>
                      <p className="text-sm text-gray-500">{formatDateTime(item.created_at)}</p>
                      {item.entity_type && <p className="text-xs text-gray-500">{item.entity_type} {item.entity_id || ""}</p>}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">
                  No onboarding activity recorded yet.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link href="/docs/implementation-playbook-90-min.md" className="inline-flex items-center font-medium text-blue-600 hover:underline">
          Open detailed playbook <ArrowRight className="ml-1 h-4 w-4" />
        </Link>
        <span className="text-gray-300">|</span>
        <span className="text-gray-500">Updated {data?.tenant?.updated_at ? formatDateTime(data.tenant.updated_at) : "Not available"}</span>
      </div>
    </div>
  )
}
