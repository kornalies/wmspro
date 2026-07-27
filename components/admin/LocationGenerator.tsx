"use client"

/**
 * Generate a whole zone's bins from rack geometry.
 *
 * The existing bulk dialog does one zone + one rack + a bin range, with the codes
 * built in the browser. A real aisle is racks x levels x bins, so onboarding a
 * 20-rack aisle meant twenty passes. This drives the server-side generator, which
 * owns the arithmetic and the collision checks.
 *
 * Preview is a separate, explicit step rather than a live-updating count: bins
 * are referenced by stock as soon as anyone puts something away, so a thousand
 * bins created under a wrong prefix are genuinely awkward to unpick. The operator
 * sees real generated codes before anything is written.
 */

import { useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import api from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ZONE_TYPES, ZONE_TYPE_LABELS, DEFAULT_ZONE_TYPE } from "@/lib/zone-layouts"

type Warehouse = { id: number; warehouse_name: string }

type Preview = {
  total: number
  summary: string
  preview: Array<{ rack_code: string; bin_code: string; bin_name: string }>
  preview_tail: string[]
}

const emptyForm = {
  warehouse_id: "",
  zone_code: "",
  zone_name: "",
  zone_type: DEFAULT_ZONE_TYPE as string,
  rack_prefix: "R",
  rack_from: "1",
  rack_to: "10",
  rack_pad: "2",
  use_levels: true,
  level_prefix: "L",
  level_from: "1",
  level_to: "4",
  level_pad: "1",
  bin_prefix: "B",
  bin_from: "1",
  bin_to: "10",
  bin_pad: "2",
  bin_separator: "",
  capacity_units: "",
}

export default function LocationGenerator({
  warehouses,
  onGenerated,
}: {
  warehouses: Warehouse[]
  onGenerated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState("")

  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const buildBody = (dryRun: boolean) => ({
    warehouse_id: Number(form.warehouse_id),
    zone_code: form.zone_code.trim().toUpperCase(),
    zone_name: form.zone_name.trim(),
    zone_type: form.zone_type,
    racks: {
      prefix: form.rack_prefix,
      from: Number(form.rack_from),
      to: Number(form.rack_to),
      pad: Number(form.rack_pad) || 0,
    },
    levels: form.use_levels
      ? {
          prefix: form.level_prefix,
          from: Number(form.level_from),
          to: Number(form.level_to),
          pad: Number(form.level_pad) || 0,
        }
      : null,
    bins: {
      prefix: form.bin_prefix,
      from: Number(form.bin_from),
      to: Number(form.bin_to),
      pad: Number(form.bin_pad) || 0,
    },
    bin_separator: form.bin_separator || undefined,
    capacity_units: form.capacity_units ? Number(form.capacity_units) : undefined,
    dry_run: dryRun,
  })

  const incomplete = !form.warehouse_id || !form.zone_code.trim() || !form.zone_name.trim()

  const run = async (dryRun: boolean) => {
    if (incomplete) {
      toast.error("Choose a warehouse and name the zone first")
      return
    }
    setBusy(dryRun ? "preview" : "generate")
    try {
      const res = (await api.post("/zone-layouts/generate", buildBody(dryRun))) as {
        data: Preview & { created?: number; skipped?: number }
        message?: string
      }
      if (dryRun) {
        setPreview(res.data)
      } else {
        toast.success(res.message || "Locations generated")
        setPreview(null)
        setOpen(false)
        setForm(emptyForm)
        onGenerated()
      }
    } catch (error: unknown) {
      // Generator errors are specific and actionable (inverted range, padding too
      // narrow, colliding codes) — surface them verbatim rather than a generic
      // failure, since the message names the fix.
      toast.error(error instanceof Error ? error.message : "Generation failed")
    } finally {
      setBusy("")
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Sparkles className="mr-2 h-4 w-4" />
        Generate locations
      </Button>
    )
  }

  const axis = (
    label: string,
    prefixKey: keyof typeof form,
    fromKey: keyof typeof form,
    toKey: keyof typeof form,
    padKey: keyof typeof form
  ) => (
    <div className="grid grid-cols-4 gap-2">
      <div>
        <Label className="text-xs">{label} prefix</Label>
        <Input
          value={String(form[prefixKey])}
          onChange={(e) => set(prefixKey, e.target.value.toUpperCase())}
          className="mt-1 uppercase"
        />
      </div>
      <div>
        <Label className="text-xs">From</Label>
        <Input value={String(form[fromKey])} onChange={(e) => set(fromKey, e.target.value)} inputMode="numeric" className="mt-1" />
      </div>
      <div>
        <Label className="text-xs">To</Label>
        <Input value={String(form[toKey])} onChange={(e) => set(toKey, e.target.value)} inputMode="numeric" className="mt-1" />
      </div>
      <div>
        <Label className="text-xs">Pad</Label>
        <Input value={String(form[padKey])} onChange={(e) => set(padKey, e.target.value)} inputMode="numeric" className="mt-1" />
      </div>
    </div>
  )

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4 text-slate-500" />
          Generate locations from rack geometry
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label className="text-xs">Warehouse</Label>
            <select
              value={form.warehouse_id}
              onChange={(e) => set("warehouse_id", e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="">Select…</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.warehouse_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Zone code</Label>
            <Input
              value={form.zone_code}
              onChange={(e) => set("zone_code", e.target.value.toUpperCase())}
              placeholder="A"
              className="mt-1 uppercase"
            />
          </div>
          <div>
            <Label className="text-xs">Zone name</Label>
            <Input value={form.zone_name} onChange={(e) => set("zone_name", e.target.value)} placeholder="Aisle A" className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">Zone type</Label>
            <select
              value={form.zone_type}
              onChange={(e) => set("zone_type", e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {ZONE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ZONE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-3 rounded border p-3">
          {axis("Rack", "rack_prefix", "rack_from", "rack_to", "rack_pad")}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.use_levels} onChange={(e) => set("use_levels", e.target.checked)} />
            Racks have levels
          </label>
          {form.use_levels ? axis("Level", "level_prefix", "level_from", "level_to", "level_pad") : null}
          {axis("Bin", "bin_prefix", "bin_from", "bin_to", "bin_pad")}
          <div className="grid grid-cols-4 gap-2">
            <div>
              <Label className="text-xs">Bin separator</Label>
              <Input
                value={form.bin_separator}
                onChange={(e) => set("bin_separator", e.target.value)}
                placeholder="none"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Capacity / bin</Label>
              <Input
                value={form.capacity_units}
                onChange={(e) => set("capacity_units", e.target.value)}
                inputMode="numeric"
                placeholder="optional"
                className="mt-1"
              />
            </div>
          </div>
        </div>

        {preview ? (
          <div className="rounded border bg-slate-50 p-3 text-sm">
            <p className="font-medium">{preview.summary}</p>
            <p className="mt-2 font-mono text-xs">
              {preview.preview.map((b) => `${b.rack_code}/${b.bin_code}`).join("  ")}
              {preview.preview_tail.length ? `  …  ${preview.preview_tail.join("  ")}` : ""}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Nothing has been written yet. Generating is idempotent — bins that already exist are
              skipped, not duplicated.
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={incomplete || busy !== ""} onClick={() => run(true)}>
            {busy === "preview" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Preview
          </Button>
          <Button disabled={incomplete || busy !== "" || !preview} onClick={() => run(false)}>
            {busy === "generate" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Generate {preview ? `${preview.total} bin(s)` : ""}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false)
              setPreview(null)
            }}
          >
            Cancel
          </Button>
        </div>
        {!preview ? (
          <p className="text-xs text-slate-500">Preview first — generating is disabled until you have seen the codes.</p>
        ) : null}
      </CardContent>
    </Card>
  )
}