"use client"

import Link from "next/link"
import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, CheckCircle2, Circle, Download, TimerReset, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"

type OnboardingSummary = {
  completion_pct: number
  done_steps: number
  total_steps: number
  remaining_mins: number
  counts: {
    warehouses: number
    clients: number
    items: number
    users: number
    contracts: number
    billing_profiles: number
    portal_mappings: number
  }
  steps: Array<{
    id: string
    title: string
    eta_mins: number
    status: "pending" | "done"
    detail: string
    href: string
  }>
}

type ImportError = {
  row: number
  message: string
}

type ImportMeta = {
  summary: string
  errors: ImportError[]
}

const templates = [
  { key: "clients", label: "Clients CSV Template", href: "/templates/clients_template.csv" },
  { key: "items", label: "Items CSV Template", href: "/templates/items_template.csv" },
  { key: "users", label: "Users CSV Template", href: "/templates/users_template.csv" },
  { key: "opening-stock", label: "Opening Stock CSV Template", href: "/templates/opening_stock_template.csv" },
  { key: "rate-cards", label: "Rate Card CSV Template", href: "/templates/rate_cards_template.csv" },
]

const timeline = [
  { title: "0-10 min: Company + Warehouse", detail: "Verify company profile and create warehouse." },
  { title: "10-25 min: Clients", detail: "Create clients and contact details." },
  { title: "25-40 min: Item Master Import", detail: "Import item master from template." },
  { title: "40-50 min: User Setup", detail: "Create operations/gate/finance users." },
  { title: "50-65 min: Contract Setup", detail: "Configure client contract and charge structures." },
  { title: "65-75 min: Billing Profiles", detail: "Set billing cycle for each client." },
  { title: "75-85 min: Portal Mapping", detail: "Auto-seed portal mappings and verify access." },
  { title: "85-90 min: Smoke Test", detail: "Create one Gate In + GRN + DO + portal sign-in check." },
]

export default function OnboardingPage() {
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [uploadingKey, setUploadingKey] = useState<string>("")
  const [importResults, setImportResults] = useState<Record<string, ImportMeta>>({})
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

  async function handleImport(type: string) {
    const file = files[type]
    if (!file) {
      toast.error("Select a CSV file first")
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
      setImportResults((prev) => ({ ...prev, [type]: { summary, errors } }))
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Tenant Onboarding (90-Minute Mode)</h1>
          <p className="mt-1 text-gray-500">
            Fast implementation checklist for new small/mid 3PL tenants using existing modules.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => summaryQuery.refetch()}
          disabled={summaryQuery.isFetching}
        >
          <TimerReset className="mr-2 h-4 w-4" />
          Refresh Status
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-2 flex items-center justify-between text-sm">
            <p className="font-medium">Completion</p>
            <p className="text-gray-600">
              {data?.done_steps ?? 0}/{data?.total_steps ?? 0} steps
            </p>
          </div>
          <div className="h-3 w-full rounded-full bg-gray-200">
            <div
              className="h-3 rounded-full bg-emerald-600 transition-all"
              style={{ width: `${data?.completion_pct ?? 0}%` }}
            />
          </div>
          <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
            <p>{data?.completion_pct ?? 0}% completed</p>
            <p>Estimated remaining: {data?.remaining_mins ?? 0} mins</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Data Import Templates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {templates.map((file) => (
              <div key={file.href} className="rounded-md border p-3">
                <a
                  href={file.href}
                  download
                  className="mb-2 flex items-center justify-between text-sm font-medium hover:text-blue-700"
                >
                  <span>{file.label}</span>
                  <Download className="h-4 w-4 text-gray-500" />
                </a>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    className="block w-full rounded-md border px-2 py-1 text-xs"
                    onChange={(e) =>
                      setFiles((prev) => ({ ...prev, [file.key]: e.target.files?.[0] || null }))
                    }
                  />
                  <Button size="sm" onClick={() => handleImport(file.key)} disabled={uploadingKey === file.key}>
                    <Upload className="mr-1 h-3.5 w-3.5" />
                    Import
                  </Button>
                </div>
                {importResults[file.key] ? (
                  <div className="mt-2">
                    <p className="text-xs text-gray-600">{importResults[file.key].summary}</p>
                    {importResults[file.key].errors.length > 0 ? (
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0 text-xs"
                        onClick={() => downloadErrorsCsv(file.key, importResults[file.key].errors)}
                      >
                        Download Errors CSV
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">90-Minute Implementation Playbook</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {timeline.map((item) => (
              <div key={item.title} className="rounded-md border px-3 py-2">
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="text-xs text-gray-600">{item.detail}</p>
              </div>
            ))}
            <Link href="/docs/implementation-playbook-90-min.md" className="inline-flex items-center text-sm font-medium text-blue-600 hover:underline">
              Open detailed playbook <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Execution Checklist</CardTitle>
            <Button
              onClick={() => autoSeedMutation.mutate()}
              disabled={autoSeedMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Auto-Seed Portal Mapping
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {(data?.steps ?? []).map((step) => (
            <div key={step.id} className="flex items-center justify-between rounded-md border p-3">
              <div className="flex items-start gap-3">
                {step.status === "done" ? (
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
                ) : (
                  <Circle className="mt-0.5 h-5 w-5 text-gray-400" />
                )}
                <div>
                  <p className="text-sm font-semibold">
                    {step.title} <span className="text-gray-500">({step.eta_mins}m)</span>
                  </p>
                  <p className="text-xs text-gray-600">{step.detail}</p>
                </div>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={step.href}>Open</Link>
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
