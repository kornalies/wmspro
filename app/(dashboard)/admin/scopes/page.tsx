"use client"

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"

type UserRow = {
  id: number
  username: string
  full_name: string
  role: string
  is_active: boolean
}

type ScopeRow = {
  user_id: number
  scope_type: "warehouse" | "zone" | "client"
  scope_id: number
}

type Option = {
  id: number
  label: string
}

export default function AdminScopesPage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [users, setUsers] = useState<UserRow[]>([])
  const [scopes, setScopes] = useState<ScopeRow[]>([])
  const [warehouseOptions, setWarehouseOptions] = useState<Option[]>([])
  const [zoneOptions, setZoneOptions] = useState<Option[]>([])
  const [clientOptions, setClientOptions] = useState<Option[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number>(0)
  const [selectedWarehouseIds, setSelectedWarehouseIds] = useState<number[]>([])
  const [selectedZoneIds, setSelectedZoneIds] = useState<number[]>([])
  const [selectedClientIds, setSelectedClientIds] = useState<number[]>([])

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId) || null,
    [users, selectedUserId]
  )

  function applyUserScopes(userId: number, scopeRows: ScopeRow[]) {
    const own = scopeRows.filter((scope) => scope.user_id === userId)
    setSelectedWarehouseIds(own.filter((x) => x.scope_type === "warehouse").map((x) => x.scope_id))
    setSelectedZoneIds(own.filter((x) => x.scope_type === "zone").map((x) => x.scope_id))
    setSelectedClientIds(own.filter((x) => x.scope_type === "client").map((x) => x.scope_id))
  }

  useEffect(() => {
    void (async () => {
      setLoading(true)
      const [scopeRes, whRes, zoneRes, clientRes] = await Promise.all([
        fetch("/api/admin/scopes", { cache: "no-store" }),
        fetch("/api/warehouses?is_active=true", { cache: "no-store" }),
        fetch("/api/zone-layouts?is_active=true", { cache: "no-store" }),
        fetch("/api/clients?is_active=true", { cache: "no-store" }),
      ])

      const [scopeJson, whJson, zoneJson, clientJson] = await Promise.all([
        scopeRes.json(),
        whRes.json(),
        zoneRes.json(),
        clientRes.json(),
      ])

      if (!scopeRes.ok) {
        toast.error(scopeJson?.error?.message || "Failed to load scopes")
        setLoading(false)
        return
      }

      const loadedUsers = (scopeJson?.data?.users || []) as UserRow[]
      const loadedScopes = (scopeJson?.data?.scopes || []) as ScopeRow[]
      setUsers(loadedUsers)
      setScopes(loadedScopes)
      const firstUserId = loadedUsers[0]?.id || 0
      setSelectedUserId(firstUserId)
      applyUserScopes(firstUserId, loadedScopes)

      setWarehouseOptions(
        ((whJson?.data || []) as Array<{ id: number; warehouse_name: string; warehouse_code: string }>).map(
          (row) => ({
            id: row.id,
            label: `${row.warehouse_name} (${row.warehouse_code})`,
          })
        )
      )
      setZoneOptions(
        ((zoneJson?.data || []) as Array<{ id: number; warehouse_name: string; zone_code: string; rack_code: string; bin_code: string }>).map(
          (row) => ({
            id: row.id,
            label: `${row.warehouse_name}: ${row.zone_code}/${row.rack_code}/${row.bin_code}`,
          })
        )
      )
      setClientOptions(
        ((clientJson?.data || []) as Array<{ id: number; client_name: string; client_code: string }>).map(
          (row) => ({
            id: row.id,
            label: `${row.client_name} (${row.client_code})`,
          })
        )
      )
      setLoading(false)
    })()
  }, [])

  function toggle(ids: number[], id: number, setter: (next: number[]) => void) {
    if (ids.includes(id)) setter(ids.filter((x) => x !== id))
    else setter([...ids, id])
  }

  async function onSave() {
    if (!selectedUserId) return
    setSaving(true)
    const res = await fetch("/api/admin/scopes", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: selectedUserId,
        warehouse_ids: selectedWarehouseIds,
        zone_ids: selectedZoneIds,
        client_ids: selectedClientIds,
      }),
    })
    const json = await res.json()
    setSaving(false)
    if (!res.ok) {
      toast.error(json?.error?.message || "Failed to save scopes")
      return
    }

    const updatedScopes = (json?.data?.scopes || []) as ScopeRow[]
    setScopes((prev) => [
      ...prev.filter((row) => row.user_id !== selectedUserId),
      ...updatedScopes.map((row) => ({ ...row, user_id: selectedUserId })),
    ])
    toast.success("Scopes updated")
  }

  if (loading) return <div className="p-4 text-sm text-gray-500">Loading scopes...</div>

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>User Scopes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="text-sm">
            User
            <select
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
              value={selectedUserId}
              onChange={(e) => {
                const next = Number(e.target.value)
                setSelectedUserId(next)
                applyUserScopes(next, scopes)
              }}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.full_name} ({user.username}) - {user.role}
                </option>
              ))}
            </select>
          </label>
          {selectedUser ? (
            <p className="text-xs text-gray-500">
              Assign access boundaries for {selectedUser.full_name} ({selectedUser.role}).
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Warehouses</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {warehouseOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type="checkbox"
                checked={selectedWarehouseIds.includes(option.id)}
                onChange={() =>
                  toggle(selectedWarehouseIds, option.id, setSelectedWarehouseIds)
                }
              />
              {option.label}
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Zones</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {zoneOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type="checkbox"
                checked={selectedZoneIds.includes(option.id)}
                onChange={() => toggle(selectedZoneIds, option.id, setSelectedZoneIds)}
              />
              {option.label}
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clients</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2">
          {clientOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 rounded border p-2 text-sm">
              <input
                type="checkbox"
                checked={selectedClientIds.includes(option.id)}
                onChange={() => toggle(selectedClientIds, option.id, setSelectedClientIds)}
              />
              {option.label}
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={saving || !selectedUserId}>
          {saving ? "Saving..." : "Save Scope Assignments"}
        </Button>
      </div>
    </div>
  )
}
