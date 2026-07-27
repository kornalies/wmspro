"use client"

/**
 * The operator's view of the outbound tail: pack -> goods issue -> load ->
 * delivery note.
 *
 * Track A shipped this workflow as API only, so until now the only way to run it
 * was curl. The screen is deliberately one page rather than four: each step's
 * availability depends on the state of the previous one, and an operator on a
 * loading bay needs to see where the order actually is without navigating.
 *
 * Step gating mirrors the server's rules rather than inventing its own. When the
 * API refuses something the error is surfaced verbatim — the server stays the
 * only authority on what is legal.
 */

import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Boxes,
  CheckCircle2,
  FileText,
  Loader2,
  PackageCheck,
  Truck,
} from "lucide-react"

import api from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type PackUnit = {
  id: number
  pack_code: string
  pack_type: string
  status: string
  total_quantity: number
  gross_weight_kg: number | null
  volume_cbm: number | null
  closed_at: string | null
  is_issued: boolean
  is_loaded: boolean
}

type GoodsIssue = {
  id: number
  gi_number: string
  status: string
  total_pack_units: number
  total_quantity: number
  issued_at: string | null
  issued_by_name: string | null
}

type OutboundLoad = {
  id: number
  load_number: string
  status: string
  vehicle_number: string | null
  driver_name: string | null
  transport_company: string | null
  loaded_at: string | null
  pack_unit_count: number
  total_quantity: number
}

type DeliveryNote = {
  id: number
  delivery_note_number: string
  status: string
  total_pack_units: number
  total_quantity: number
  finalized_at: string | null
  finalized_by_name: string | null
}

type PackableSerial = {
  id: number
  serial_number: string
  status: string
  bin_location: string | null
  do_line_item_id: number
  line_number: number
  item_code: string
  item_name: string
}

type TailState = {
  do_id: number
  do_number: string
  do_status: string
  pack_units: PackUnit[]
  goods_issues: GoodsIssue[]
  loads: OutboundLoad[]
  delivery_notes: DeliveryNote[]
  packable_serials: PackableSerial[]
}

function fmtDateTime(value: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
}

function StepHeading({
  icon: Icon,
  step,
  title,
  done,
}: {
  icon: typeof Boxes
  step: number
  title: string
  done: boolean
}) {
  return (
    <CardTitle className="flex items-center gap-2 text-base">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
          done ? "bg-green-600 text-white" : "bg-slate-200 text-slate-700"
        }`}
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : step}
      </span>
      <Icon className="h-4 w-4 text-slate-500" />
      {title}
    </CardTitle>
  )
}

function DocLink({ type, id, label }: { type: string; id: number; label: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/documents/${type}/${id}?back=${encodeURIComponent(window.location.pathname)}`}>
        <FileText className="mr-2 h-4 w-4" />
        {label}
      </Link>
    </Button>
  )
}

export default function OutboundTail({ doRef }: { doRef: string }) {
  const [state, setState] = useState<TailState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const [selectedSerials, setSelectedSerials] = useState<number[]>([])
  const [packType, setPackType] = useState("PALLET")
  const [grossWeight, setGrossWeight] = useState("")
  const [selectedPackUnits, setSelectedPackUnits] = useState<number[]>([])
  const [vehicle, setVehicle] = useState({
    vehicle_number: "",
    driver_name: "",
    driver_phone: "",
    transport_company: "",
    container_number: "",
    seal_number: "",
    loading_bay: "",
  })

  const load = useCallback(async () => {
    try {
      const response = (await api.get(`/do/${encodeURIComponent(doRef)}/tail`)) as {
        data: TailState
      }
      setState(response.data)
      setError("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load outbound state")
    } finally {
      setLoading(false)
    }
  }, [doRef])

  useEffect(() => {
    void load()
  }, [load])

  /** Every mutation goes through here so refresh and error handling stay uniform. */
  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, successMessage: string) => {
      setBusy(key)
      setError("")
      setNotice("")
      try {
        await action()
        setNotice(successMessage)
        await load()
        return true
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Action failed")
        return false
      } finally {
        setBusy("")
      }
    },
    [load]
  )

  const serialsByLine = useMemo(() => {
    const groups = new Map<number, { line: PackableSerial; serials: PackableSerial[] }>()
    for (const serial of state?.packable_serials || []) {
      const existing = groups.get(serial.do_line_item_id)
      if (existing) existing.serials.push(serial)
      else groups.set(serial.do_line_item_id, { line: serial, serials: [serial] })
    }
    return [...groups.values()]
  }, [state])

  const closedUnissued = useMemo(
    () => (state?.pack_units || []).filter((u) => u.status === "CLOSED" && !u.is_issued),
    [state]
  )
  const issuedUnloaded = useMemo(
    () => (state?.pack_units || []).filter((u) => u.is_issued && !u.is_loaded),
    [state]
  )
  const openLoad = useMemo(
    () => (state?.loads || []).find((l) => l.status === "OPEN") || null,
    [state]
  )
  const pendingNote = useMemo(
    () => (state?.delivery_notes || []).find((d) => d.status === "PENDING") || null,
    [state]
  )

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!state) {
    return <p className="text-sm text-red-600">{error || "Unable to load this delivery order."}</p>
  }

  const toggle = (list: number[], id: number) =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  const createPackUnit = () => {
    // Serials are selected across lines, but the API groups them per DO line.
    const byLine = new Map<number, number[]>()
    for (const serial of state.packable_serials) {
      if (!selectedSerials.includes(serial.id)) continue
      const bucket = byLine.get(serial.do_line_item_id) || []
      bucket.push(serial.id)
      byLine.set(serial.do_line_item_id, bucket)
    }
    const lines = [...byLine.entries()].map(([do_line_item_id, serial_ids]) => ({
      do_line_item_id,
      serial_ids,
    }))

    return run(
      "pack",
      async () => {
        await api.post(`/do/${encodeURIComponent(doRef)}/pack-units`, {
          pack_type: packType,
          close: true,
          ...(grossWeight ? { gross_weight_kg: Number(grossWeight) } : {}),
          lines,
        })
        setSelectedSerials([])
        setGrossWeight("")
      },
      "Pack unit built and closed."
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">Outbound Tail</h2>
        <Badge variant="secondary">{state.do_status}</Badge>
        <span className="text-sm text-slate-500">{state.do_number}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <DocLink type="packing-list" id={state.do_id} label="Packing List" />
          <DocLink type="job-card" id={state.do_id} label="Job Card" />
        </div>
      </div>

      {error ? (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700">
          {notice}
        </p>
      ) : null}

      {/* ---------------- Step 1: pack ---------------- */}
      <Card>
        <CardHeader>
          <StepHeading icon={Boxes} step={1} title="Pack" done={state.pack_units.length > 0} />
        </CardHeader>
        <CardContent className="space-y-4">
          {serialsByLine.length === 0 ? (
            <p className="text-sm text-slate-500">
              No packable stock. Every eligible serial for this order is already in a pack unit.
            </p>
          ) : (
            <div className="space-y-3">
              {serialsByLine.map(({ line, serials }) => (
                <div key={line.do_line_item_id} className="rounded border p-3">
                  <p className="mb-2 text-sm font-medium">
                    Line {line.line_number} — {line.item_code} {line.item_name}
                    <span className="ml-2 text-xs text-slate-500">{serials.length} available</span>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {serials.map((serial) => {
                      const checked = selectedSerials.includes(serial.id)
                      return (
                        <button
                          key={serial.id}
                          type="button"
                          onClick={() => setSelectedSerials((prev) => toggle(prev, serial.id))}
                          className={`rounded border px-2 py-1 text-xs ${
                            checked
                              ? "border-blue-600 bg-blue-50 text-blue-800"
                              : "border-slate-300 text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          {serial.serial_number}
                          {serial.bin_location ? (
                            <span className="ml-1 text-slate-400">{serial.bin_location}</span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}

              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="pack-type">Pack type</Label>
                  <select
                    id="pack-type"
                    value={packType}
                    onChange={(e) => setPackType(e.target.value)}
                    className="mt-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                  >
                    <option value="PALLET">Pallet</option>
                    <option value="CARTON">Carton</option>
                    <option value="BULK">Bulk</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="gross-weight">Gross weight (kg)</Label>
                  <Input
                    id="gross-weight"
                    value={grossWeight}
                    onChange={(e) => setGrossWeight(e.target.value)}
                    inputMode="decimal"
                    placeholder="optional"
                    className="mt-1 w-40"
                  />
                </div>
                <Button
                  onClick={createPackUnit}
                  disabled={selectedSerials.length === 0 || busy === "pack"}
                >
                  {busy === "pack" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Build pack unit ({selectedSerials.length})
                </Button>
              </div>
            </div>
          )}

          {state.pack_units.length > 0 ? (
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 text-left">
                  <th className="border px-2 py-1">Pack Unit</th>
                  <th className="border px-2 py-1">Type</th>
                  <th className="border px-2 py-1 text-right">Qty</th>
                  <th className="border px-2 py-1">Status</th>
                  <th className="border px-2 py-1">Stage</th>
                  <th className="border px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {state.pack_units.map((unit) => (
                  <tr key={unit.id}>
                    <td className="border px-2 py-1 font-mono text-xs">{unit.pack_code}</td>
                    <td className="border px-2 py-1">{unit.pack_type}</td>
                    <td className="border px-2 py-1 text-right">{unit.total_quantity}</td>
                    <td className="border px-2 py-1">{unit.status}</td>
                    <td className="border px-2 py-1">
                      {unit.is_loaded ? "Loaded" : unit.is_issued ? "Issued" : "In warehouse"}
                    </td>
                    <td className="border px-2 py-1 text-right">
                      {unit.status === "OPEN" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === `close-${unit.id}`}
                          onClick={() =>
                            run(
                              `close-${unit.id}`,
                              () => api.post(`/do/pack-units/${unit.id}/close`, {}),
                              `Pack unit ${unit.pack_code} closed.`
                            )
                          }
                        >
                          Close
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- Step 2: goods issue ---------------- */}
      <Card>
        <CardHeader>
          <StepHeading
            icon={PackageCheck}
            step={2}
            title="Goods Issue"
            done={state.goods_issues.length > 0}
          />
        </CardHeader>
        <CardContent className="space-y-3">
          {state.goods_issues.length === 0 ? (
            <p className="text-sm text-slate-500">
              {closedUnissued.length === 0
                ? "Close at least one pack unit before issuing."
                : `${closedUnissued.length} closed pack unit(s) ready to issue.`}
            </p>
          ) : (
            <div className="space-y-2">
              {state.goods_issues.map((gi) => (
                <div key={gi.id} className="flex flex-wrap items-center gap-3 rounded border p-2">
                  <span className="font-mono text-xs">{gi.gi_number}</span>
                  <Badge variant={gi.status === "CANCELLED" ? "destructive" : "secondary"}>
                    {gi.status}
                  </Badge>
                  <span className="text-xs text-slate-500">
                    {gi.total_pack_units} unit(s), qty {gi.total_quantity} · {fmtDateTime(gi.issued_at)}
                  </span>
                  <div className="ml-auto">
                    <DocLink type="goods-issue-note" id={gi.id} label="Goods Issue Note" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {closedUnissued.length > 0 ? (
            <Button
              disabled={busy === "gi"}
              onClick={() =>
                run(
                  "gi",
                  () => api.post(`/do/${encodeURIComponent(doRef)}/goods-issue`, {}),
                  "Goods issue generated."
                )
              }
            >
              {busy === "gi" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Generate goods issue ({closedUnissued.length})
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- Step 3: load ---------------- */}
      <Card>
        <CardHeader>
          <StepHeading icon={Truck} step={3} title="Load" done={state.loads.length > 0} />
        </CardHeader>
        <CardContent className="space-y-3">
          {state.loads.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-3 rounded border p-2">
              <span className="font-mono text-xs">{l.load_number}</span>
              <Badge variant={l.status === "LOADED" ? "default" : "secondary"}>{l.status}</Badge>
              <span className="text-xs text-slate-500">
                {l.vehicle_number || "no vehicle"} · {l.pack_unit_count} unit(s) ·{" "}
                {fmtDateTime(l.loaded_at)}
              </span>
              <div className="ml-auto flex gap-2">
                <DocLink type="consignment-note" id={l.id} label="Consignment Note" />
                {l.status === "OPEN" ? (
                  <Button
                    size="sm"
                    disabled={busy === `complete-${l.id}`}
                    onClick={() =>
                      run(
                        `complete-${l.id}`,
                        () => api.post(`/do/loads/${l.id}/complete`, {}),
                        "Load completed. Delivery note raised."
                      )
                    }
                  >
                    Complete load
                  </Button>
                ) : null}
              </div>
            </div>
          ))}

          {issuedUnloaded.length > 0 && !openLoad ? (
            <div className="space-y-3 rounded border p-3">
              <p className="text-sm font-medium">Build a load from issued pack units</p>
              <div className="flex flex-wrap gap-2">
                {issuedUnloaded.map((unit) => {
                  const checked = selectedPackUnits.includes(unit.id)
                  return (
                    <button
                      key={unit.id}
                      type="button"
                      onClick={() => setSelectedPackUnits((prev) => toggle(prev, unit.id))}
                      className={`rounded border px-2 py-1 text-xs ${
                        checked
                          ? "border-blue-600 bg-blue-50 text-blue-800"
                          : "border-slate-300 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {unit.pack_code} ({unit.total_quantity})
                    </button>
                  )
                })}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ["vehicle_number", "Vehicle number"],
                    ["driver_name", "Driver name"],
                    ["driver_phone", "Driver phone"],
                    ["transport_company", "Transporter"],
                    ["container_number", "Container no."],
                    ["seal_number", "Seal no."],
                    ["loading_bay", "Loading bay"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label htmlFor={key}>{label}</Label>
                    <Input
                      id={key}
                      value={vehicle[key]}
                      onChange={(e) => setVehicle((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                ))}
              </div>

              <Button
                disabled={selectedPackUnits.length === 0 || busy === "load"}
                onClick={() =>
                  run(
                    "load",
                    async () => {
                      // Empty optional strings are omitted so the server stores
                      // NULL rather than "" and the consignment note prints "-".
                      const details = Object.fromEntries(
                        Object.entries(vehicle).filter(([, value]) => value.trim() !== "")
                      )
                      await api.post(`/do/${encodeURIComponent(doRef)}/loads`, {
                        ...details,
                        pack_unit_ids: selectedPackUnits,
                      })
                      setSelectedPackUnits([])
                    },
                    "Load created."
                  )
                }
              >
                {busy === "load" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create load ({selectedPackUnits.length})
              </Button>
            </div>
          ) : null}

          {state.loads.length === 0 && issuedUnloaded.length === 0 ? (
            <p className="text-sm text-slate-500">Issue pack units before building a load.</p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------------- Step 4: delivery note ---------------- */}
      <Card>
        <CardHeader>
          <StepHeading
            icon={FileText}
            step={4}
            title="Delivery Note"
            done={state.delivery_notes.some((d) => d.status === "COMPLETED")}
          />
        </CardHeader>
        <CardContent className="space-y-3">
          {state.delivery_notes.length === 0 ? (
            <p className="text-sm text-slate-500">
              A delivery note is raised automatically when a load is completed.
            </p>
          ) : (
            state.delivery_notes.map((dn) => (
              <div key={dn.id} className="flex flex-wrap items-center gap-3 rounded border p-2">
                <span className="font-mono text-xs">{dn.delivery_note_number}</span>
                <Badge variant={dn.status === "COMPLETED" ? "default" : "secondary"}>
                  {dn.status}
                </Badge>
                <span className="text-xs text-slate-500">
                  {dn.total_pack_units} unit(s), qty {dn.total_quantity} ·{" "}
                  {fmtDateTime(dn.finalized_at)}
                </span>
                <div className="ml-auto flex gap-2">
                  <DocLink type="delivery-note" id={dn.id} label="Delivery Note" />
                  {dn.status === "PENDING" ? (
                    <Button
                      size="sm"
                      disabled={busy === `finalize-${dn.id}`}
                      onClick={() =>
                        run(
                          `finalize-${dn.id}`,
                          () => api.post(`/do/delivery-notes/${dn.id}/finalize`, {}),
                          "Delivery note finalized. Stock committed out."
                        )
                      }
                    >
                      Finalize
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
          {pendingNote ? (
            <p className="text-xs text-amber-700">
              Finalizing commits stock out of the building. This is the only step in the tail that
              moves inventory.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}