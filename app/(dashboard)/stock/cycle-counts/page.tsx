"use client"

/**
 * Cycle counting: raise a count plan, key in counts, decide variances.
 *
 * The approval queue is the point of the screen. Counting already happened on
 * handhelds, but a variance had nowhere to go — this is where a supervisor
 * turns one into a stock fact, so the consequences of each decision are spelled
 * out rather than hidden behind a button.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, ClipboardList, Loader2, RefreshCw } from "lucide-react"

import api from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Plan = {
  id: number
  plan_number: string
  strategy: string
  status: string
  blind_count: boolean
  zone_code: string | null
  total_tasks: number
  open_tasks: number
  warehouse_name: string
  client_name: string | null
  created_by_name: string | null
  created_at: string
}

type PendingApproval = {
  id: string
  bin_id: string
  sku: string
  expected_qty: number | null
  counted_qty: number | null
  discrepancy: number | null
  blind_count: boolean
  warehouse_name: string | null
  client_name: string | null
  counted_by_name: string | null
  created_at: string
}

type Accuracy = {
  counts: number
  exact: number
  total_variance: number
  accuracy_pct: number | null
}

type PlanTask = {
  id: string
  bin_id: string
  sku: string
  status: string
  blind_count: boolean
  expected_qty: number | null
  worker_name: string | null
  submission_id: string | null
  counted_qty: number | null
  discrepancy: number | null
  approval_status: string | null
}

type Warehouse = { id: number; warehouse_name: string }

export default function CycleCountsPage() {
  const [plans, setPlans] = useState<Plan[]>([])
  const [pending, setPending] = useState<PendingApproval[]>([])
  const [accuracy, setAccuracy] = useState<Accuracy | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [form, setForm] = useState({
    warehouse_id: "",
    strategy: "ZONE",
    zone_code: "",
    blind_count: true,
    limit: "50",
  })

  const [openPlanId, setOpenPlanId] = useState<number | null>(null)
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([])
  const [counts, setCounts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const [queue, whs] = await Promise.all([
        api.get("/stock/cycle-counts") as Promise<{
          data: { plans: Plan[]; pending_approvals: PendingApproval[]; accuracy: Accuracy }
        }>,
        api.get("/warehouses") as Promise<{ data: Warehouse[] }>,
      ])
      setPlans(queue.data.plans)
      setPending(queue.data.pending_approvals)
      setAccuracy(queue.data.accuracy)
      const list = Array.isArray(whs.data) ? whs.data : []
      setWarehouses(list)
      setForm((prev) =>
        prev.warehouse_id || list.length === 0
          ? prev
          : { ...prev, warehouse_id: String(list[0].id) }
      )
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load cycle counts")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openPlan = useCallback(async (planId: number) => {
    setOpenPlanId(planId)
    setPlanTasks([])
    try {
      const res = (await api.get(`/stock/cycle-counts/plans/${planId}`)) as {
        data: { tasks: PlanTask[] }
      }
      setPlanTasks(res.data.tasks)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load plan")
    }
  }, [])

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, message: string) => {
      setBusy(key)
      setError("")
      setNotice("")
      try {
        const result = (await action()) as { message?: string } | undefined
        setNotice(result?.message || message)
        await load()
        if (openPlanId) await openPlan(openPlanId)
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Action failed")
      } finally {
        setBusy("")
      }
    },
    [load, openPlan, openPlanId]
  )

  const pendingByBin = useMemo(
    () => pending.filter((p) => (p.discrepancy ?? 0) !== 0),
    [pending]
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="container mx-auto space-y-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">Cycle Counts</h1>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        {accuracy ? (
          <div className="ml-auto flex gap-4 text-sm">
            <span>
              <span className="text-slate-500">Accuracy (90d): </span>
              <span className="font-semibold">
                {accuracy.accuracy_pct === null ? "-" : `${accuracy.accuracy_pct}%`}
              </span>
            </span>
            <span>
              <span className="text-slate-500">Counts: </span>
              <span className="font-semibold">{accuracy.counts}</span>
            </span>
            <span>
              <span className="text-slate-500">Total variance: </span>
              <span className="font-semibold">{accuracy.total_variance}</span>
            </span>
          </div>
        ) : null}
      </div>

      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      ) : null}
      {notice ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">
          {notice}
        </p>
      ) : null}

      {/* -------- approval queue: the reason this screen exists -------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Variances awaiting approval
            {pendingByBin.length > 0 ? (
              <Badge variant="destructive">{pendingByBin.length}</Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pendingByBin.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing awaiting a decision.</p>
          ) : (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-left">
                  <th className="border px-2 py-1">Bin</th>
                  <th className="border px-2 py-1">SKU</th>
                  <th className="border px-2 py-1 text-right">Expected</th>
                  <th className="border px-2 py-1 text-right">Counted</th>
                  <th className="border px-2 py-1 text-right">Variance</th>
                  <th className="border px-2 py-1">Counted by</th>
                  <th className="border px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {pendingByBin.map((p) => {
                  const variance = p.discrepancy ?? 0
                  return (
                    <tr key={p.id}>
                      <td className="border px-2 py-1 font-mono text-xs">{p.bin_id}</td>
                      <td className="border px-2 py-1">{p.sku}</td>
                      <td className="border px-2 py-1 text-right">{p.expected_qty ?? "-"}</td>
                      <td className="border px-2 py-1 text-right">{p.counted_qty ?? "-"}</td>
                      <td
                        className={`border px-2 py-1 text-right font-semibold ${
                          variance < 0 ? "text-red-700" : "text-amber-700"
                        }`}
                      >
                        {variance > 0 ? `+${variance}` : variance}
                      </td>
                      <td className="border px-2 py-1">{p.counted_by_name || "-"}</td>
                      <td className="border px-2 py-1">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === `rej-${p.id}`}
                            onClick={() =>
                              run(
                                `rej-${p.id}`,
                                () =>
                                  api.post(`/stock/cycle-counts/submissions/${p.id}/approve`, {
                                    decision: "REJECTED",
                                  }),
                                "Variance rejected."
                              )
                            }
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant={variance < 0 ? "destructive" : "default"}
                            disabled={busy === `app-${p.id}`}
                            title={
                              variance < 0
                                ? `Approving writes off ${Math.abs(variance)} unit(s) of stock`
                                : "Approving records the overage; stock is not created"
                            }
                            onClick={() =>
                              run(
                                `app-${p.id}`,
                                () =>
                                  api.post(`/stock/cycle-counts/submissions/${p.id}/approve`, {
                                    decision: "APPROVED",
                                  }),
                                "Variance approved."
                              )
                            }
                          >
                            {variance < 0 ? `Write off ${Math.abs(variance)}` : "Approve"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Approving a shortage cancels the oldest matching serials in that bin and records a LOST
            movement for each. An overage is recorded but never creates stock — WMS cannot invent a
            serial number, so the extra units must arrive through a receipt.
          </p>
        </CardContent>
      </Card>

      {/* -------- raise a plan -------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4 text-slate-500" />
            Raise a count plan
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label htmlFor="wh">Warehouse</Label>
              <select
                id="wh"
                value={form.warehouse_id}
                onChange={(e) => setForm({ ...form, warehouse_id: e.target.value })}
                className="mt-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.warehouse_name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="strategy">Strategy</Label>
              <select
                id="strategy"
                value={form.strategy}
                onChange={(e) => setForm({ ...form, strategy: e.target.value })}
                className="mt-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="ZONE">Zone</option>
                <option value="ABC">ABC (most movement first)</option>
              </select>
            </div>
            {form.strategy === "ZONE" ? (
              <div>
                <Label htmlFor="zone">Zone code</Label>
                <Input
                  id="zone"
                  value={form.zone_code}
                  onChange={(e) => setForm({ ...form, zone_code: e.target.value })}
                  placeholder="e.g. CHE01"
                  className="mt-1 w-40"
                />
              </div>
            ) : null}
            <div>
              <Label htmlFor="limit">Max tasks</Label>
              <Input
                id="limit"
                value={form.limit}
                onChange={(e) => setForm({ ...form, limit: e.target.value })}
                inputMode="numeric"
                className="mt-1 w-24"
              />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.blind_count}
                onChange={(e) => setForm({ ...form, blind_count: e.target.checked })}
              />
              Blind count
            </label>
            <Button
              disabled={!form.warehouse_id || busy === "plan"}
              onClick={() =>
                run(
                  "plan",
                  () =>
                    api.post("/stock/cycle-counts", {
                      warehouse_id: Number(form.warehouse_id),
                      strategy: form.strategy,
                      ...(form.strategy === "ZONE" ? { zone_code: form.zone_code } : {}),
                      blind_count: form.blind_count,
                      limit: Number(form.limit) || 50,
                    }),
                  "Plan raised."
                )
              }
            >
              {busy === "plan" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Raise plan
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            A blind count withholds the expected quantity from the counter, which is what makes the
            result evidence rather than confirmation.
          </p>
        </CardContent>
      </Card>

      {/* -------- plans -------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plans</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {plans.length === 0 ? (
            <p className="text-sm text-slate-500">No cycle count plans yet.</p>
          ) : (
            plans.map((plan) => (
              <div key={plan.id} className="rounded border">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-3 p-2 text-left hover:bg-slate-50"
                  onClick={() => (openPlanId === plan.id ? setOpenPlanId(null) : void openPlan(plan.id))}
                >
                  <span className="font-mono text-xs">{plan.plan_number}</span>
                  <Badge variant={plan.status === "CLOSED" ? "secondary" : "default"}>
                    {plan.status}
                  </Badge>
                  {plan.blind_count ? <Badge variant="outline">Blind</Badge> : null}
                  <span className="text-xs text-slate-500">
                    {plan.strategy}
                    {plan.zone_code ? ` · ${plan.zone_code}` : ""} · {plan.warehouse_name} ·{" "}
                    {plan.open_tasks}/{plan.total_tasks} open
                  </span>
                  {plan.status !== "CLOSED" ? (
                    <span
                      role="button"
                      tabIndex={0}
                      className="ml-auto rounded border px-2 py-1 text-xs hover:bg-slate-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        void run(
                          `close-${plan.id}`,
                          () => api.post(`/stock/cycle-counts/plans/${plan.id}`, {}),
                          "Plan closed."
                        )
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.click()
                      }}
                    >
                      Close plan
                    </span>
                  ) : null}
                </button>

                {openPlanId === plan.id ? (
                  <div className="border-t p-2">
                    {planTasks.length === 0 ? (
                      <p className="text-sm text-slate-500">Loading tasks…</p>
                    ) : (
                      <table className="w-full border-collapse text-sm">
                        <thead>
                          <tr className="bg-slate-50 text-left">
                            <th className="border px-2 py-1">Bin</th>
                            <th className="border px-2 py-1">SKU</th>
                            <th className="border px-2 py-1 text-right">Expected</th>
                            <th className="border px-2 py-1">Status</th>
                            <th className="border px-2 py-1 text-right">Counted</th>
                            <th className="border px-2 py-1">Record count</th>
                          </tr>
                        </thead>
                        <tbody>
                          {planTasks.map((task) => (
                            <tr key={task.id}>
                              <td className="border px-2 py-1 font-mono text-xs">{task.bin_id}</td>
                              <td className="border px-2 py-1">{task.sku}</td>
                              <td className="border px-2 py-1 text-right">
                                {task.blind_count ? (
                                  <span className="text-slate-400">hidden</span>
                                ) : (
                                  task.expected_qty ?? "-"
                                )}
                              </td>
                              <td className="border px-2 py-1">
                                {task.status}
                                {task.approval_status === "PENDING" ? (
                                  <Badge variant="destructive" className="ml-2">
                                    variance
                                  </Badge>
                                ) : null}
                              </td>
                              <td className="border px-2 py-1 text-right">
                                {task.counted_qty ?? "-"}
                              </td>
                              <td className="border px-2 py-1">
                                {task.status === "COMPLETED" ? (
                                  <span className="text-xs text-slate-400">done</span>
                                ) : (
                                  <div className="flex gap-2">
                                    <Input
                                      value={counts[task.id] ?? ""}
                                      onChange={(e) =>
                                        setCounts({ ...counts, [task.id]: e.target.value })
                                      }
                                      inputMode="numeric"
                                      placeholder="qty"
                                      className="h-8 w-20"
                                    />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={
                                        counts[task.id] === undefined ||
                                        counts[task.id] === "" ||
                                        busy === `count-${task.id}`
                                      }
                                      onClick={() =>
                                        run(
                                          `count-${task.id}`,
                                          () =>
                                            api.post(
                                              `/stock/cycle-counts/tasks/${task.id}/count`,
                                              { counted_qty: Number(counts[task.id]) }
                                            ),
                                          "Count recorded."
                                        )
                                      }
                                    >
                                      Submit
                                    </Button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}