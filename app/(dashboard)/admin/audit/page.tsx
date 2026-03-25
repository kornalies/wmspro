"use client"

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"

type AuditRow = {
  id: string
  actor_user_id: number | null
  actor_type: string
  action: string
  entity_type: string | null
  entity_id: string | null
  ip: string | null
  created_at: string
}

export default function AuditLogsPage() {
  const pageSize = 50
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<AuditRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [action, setAction] = useState("")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")

  async function load(targetPage = page) {
    setLoading(true)
    const params = new URLSearchParams()
    if (action.trim()) params.set("action", action.trim())
    if (fromDate) params.set("from", fromDate)
    if (toDate) params.set("to", toDate)
    params.set("limit", String(pageSize))
    params.set("offset", String((targetPage - 1) * pageSize))

    const res = await fetch(`/api/admin/audit?${params.toString()}`, { cache: "no-store" })
    const json = await res.json()
    setLoading(false)
    if (!res.ok) {
      toast.error(json?.error?.message || "Failed to fetch audit logs")
      return
    }
    setRows((json?.data?.rows || []) as AuditRow[])
    setTotal(Number(json?.data?.paging?.total || 0))
    setPage(targetPage)
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void load(1)
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Audit Logs</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Action</Label>
            <Input value={action} onChange={(e) => setAction(e.target.value)} placeholder="settings.update" />
          </div>
          <div className="space-y-2">
            <Label>From</Label>
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>To</Label>
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button onClick={() => void load(1)} disabled={loading} className="w-full">
              {loading ? "Loading..." : "Apply Filters"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-center justify-between text-sm text-gray-600">
            <p>
              Showing {(rows.length && total > 0) ? (page - 1) * pageSize + 1 : 0}-
              {(page - 1) * pageSize + rows.length} of {total}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(page - 1)}
                disabled={loading || !canPrev}
              >
                Previous
              </Button>
              <span className="text-xs">
                Page {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void load(page + 1)}
                disabled={loading || !canNext}
              >
                Next
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Actor</th>
                  <th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Entity</th>
                  <th className="px-3 py-2 text-left">IP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t">
                    <td className="px-3 py-2">{new Date(row.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2">
                      {row.actor_type}
                      {row.actor_user_id ? `:${row.actor_user_id}` : ""}
                    </td>
                    <td className="px-3 py-2">{row.action}</td>
                    <td className="px-3 py-2">
                      {row.entity_type || "-"}
                      {row.entity_id ? ` #${row.entity_id}` : ""}
                    </td>
                    <td className="px-3 py-2">{row.ip || "-"}</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                      No audit logs found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
