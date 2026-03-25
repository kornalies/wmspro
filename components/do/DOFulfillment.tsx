"use client"

import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"

import { useDO, useDispatchDO, useUpdateDOStatus } from "@/hooks/use-do"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { getDOStatusLabel, normalizeDOStatus } from "@/lib/do-status"

type DOItem = {
  id: number
  item_id: number
  item_name: string
  item_code: string
  quantity_requested: number
  quantity_dispatched: number
  quantity_remaining: number
  quantity_reserved?: number
  available_inventory?: number
  unit: string
}

type DODetail = {
  id: number
  do_number: string
  status: string
  dispatch_date?: string | null
  supplier_name?: string | null
  invoice_no?: string | null
  invoice_date?: string | null
  model_no?: string | null
  serial_no?: string | null
  material_description?: string | null
  date_of_manufacturing?: string | null
  basic_price?: number | null
  invoice_qty?: number | null
  dispatched_qty?: number | null
  no_of_cases?: number | null
  no_of_pallets?: number | null
  weight_kg?: number | null
  handling_type?: string | null
  machine_type?: string | null
  machine_from_time?: string | null
  machine_to_time?: string | null
  outward_remarks?: string | null
  mobile_capture_payload?: Record<string, unknown> | null
  items: DOItem[]
}

function toDateInput(value: unknown) {
  if (!value) return ""
  const text = String(value)
  return text.includes("T") ? text.slice(0, 10) : text
}

function toDateTimeLocalInput(value: unknown) {
  if (!value) return ""
  const text = String(value)
  if (text.includes("T")) return text.slice(0, 16)
  if (text.length >= 16) return text.slice(0, 16)
  return ""
}

function toNumberInput(value: unknown) {
  if (value == null || value === "") return ""
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : ""
}

function toText(value: unknown) {
  if (value == null) return ""
  return String(value)
}

function getCapturedString(payload: Record<string, unknown> | null | undefined, ...keys: string[]) {
  if (!payload) return ""
  for (const key of keys) {
    const value = payload[key]
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ""
}

function getStatusStyles(status: string) {
  switch (status) {
    case "COMPLETED":
      return {
        panel: "border-emerald-300 bg-emerald-50",
        badge: "bg-emerald-600 text-white",
        tone: "text-emerald-700",
      }
    case "PARTIALLY_FULFILLED":
      return {
        panel: "border-amber-300 bg-amber-50",
        badge: "bg-amber-600 text-white",
        tone: "text-amber-700",
      }
    case "STAGED":
      return {
        panel: "border-violet-300 bg-violet-50",
        badge: "bg-violet-600 text-white",
        tone: "text-violet-700",
      }
    case "PICKED":
      return {
        panel: "border-indigo-300 bg-indigo-50",
        badge: "bg-indigo-600 text-white",
        tone: "text-indigo-700",
      }
    case "CANCELLED":
      return {
        panel: "border-rose-300 bg-rose-50",
        badge: "bg-rose-600 text-white",
        tone: "text-rose-700",
      }
    case "PENDING":
    case "DRAFT":
      return {
        panel: "border-sky-300 bg-sky-50",
        badge: "bg-sky-600 text-white",
        tone: "text-sky-700",
      }
    default:
      return {
        panel: "border-slate-300 bg-slate-50",
        badge: "bg-slate-700 text-white",
        tone: "text-slate-700",
      }
  }
}

export default function DOFulfillment({ doId }: { doId: number | string }) {
  const detailQuery = useDO(doId)
  const dispatchMutation = useDispatchDO(doId)
  const workflowMutation = useUpdateDOStatus(doId)

  const [dispatchDate, setDispatchDate] = useState(new Date().toISOString().split("T")[0] || "")
  const [vehicleNumber, setVehicleNumber] = useState("")
  const [driverName, setDriverName] = useState("")
  const [driverPhone, setDriverPhone] = useState("")
  const [supplierName, setSupplierName] = useState("")
  const [invoiceNo, setInvoiceNo] = useState("")
  const [invoiceDate, setInvoiceDate] = useState("")
  const [modelNo, setModelNo] = useState("")
  const [serialNo, setSerialNo] = useState("")
  const [materialDescription, setMaterialDescription] = useState("")
  const [dateOfManufacturing, setDateOfManufacturing] = useState("")
  const [basicPrice, setBasicPrice] = useState("")
  const [invoiceQty, setInvoiceQty] = useState("")
  const [dispatchedQty, setDispatchedQty] = useState("")
  const [noOfCases, setNoOfCases] = useState("")
  const [noOfPallets, setNoOfPallets] = useState("")
  const [weight, setWeight] = useState("")
  const [handlingType, setHandlingType] = useState<"MANUAL" | "MACHINE">("MANUAL")
  const [machineType, setMachineType] = useState("")
  const [machineFromTime, setMachineFromTime] = useState("")
  const [machineToTime, setMachineToTime] = useState("")
  const [outwardRemarks, setOutwardRemarks] = useState("")
  const [itemInputs, setItemInputs] = useState<Record<number, string>>({})
  const [didPrefill, setDidPrefill] = useState(false)

  const details = (detailQuery.data?.data as DODetail | undefined) ?? null
  const items = useMemo(() => details?.items ?? [], [details])
  const normalizedStatus = normalizeDOStatus(details?.status)
  const statusDisplay = normalizedStatus ?? String(details?.status || "UNKNOWN").toUpperCase()
  const canMarkPicked = normalizedStatus === "PENDING" || normalizedStatus === "DRAFT"
  const isLocked = normalizedStatus === "COMPLETED" || normalizedStatus === "CANCELLED"
  const isCompleted = normalizedStatus === "COMPLETED"
  const statusStyles = getStatusStyles(statusDisplay)

  useEffect(() => {
    queueMicrotask(() => setDidPrefill(false))
  }, [doId])

  useEffect(() => {
    if (!details || didPrefill) return
    const capture = details.mobile_capture_payload

    queueMicrotask(() => {
      setDispatchDate(toDateInput(details.dispatch_date) || new Date().toISOString().split("T")[0] || "")
      setVehicleNumber(getCapturedString(capture, "vehicle_number", "vehicleNumber"))
      setDriverName(getCapturedString(capture, "driver_name", "driverName"))
      setDriverPhone(getCapturedString(capture, "driver_phone", "driverPhone"))
      setSupplierName(toText(details.supplier_name))
      setInvoiceNo(toText(details.invoice_no))
      setInvoiceDate(toDateInput(details.invoice_date))
      setModelNo(toText(details.model_no))
      setSerialNo(toText(details.serial_no))
      setMaterialDescription(toText(details.material_description))
      setDateOfManufacturing(toDateInput(details.date_of_manufacturing))
      setBasicPrice(toNumberInput(details.basic_price))
      setInvoiceQty(toNumberInput(details.invoice_qty))
      setDispatchedQty(toNumberInput(details.dispatched_qty))
      setNoOfCases(toNumberInput(details.no_of_cases))
      setNoOfPallets(toNumberInput(details.no_of_pallets))
      setWeight(toNumberInput(details.weight_kg))
      setHandlingType(String(details.handling_type || "").toUpperCase() === "MACHINE" ? "MACHINE" : "MANUAL")
      setMachineType(toText(details.machine_type))
      setMachineFromTime(toDateTimeLocalInput(details.machine_from_time))
      setMachineToTime(toDateTimeLocalInput(details.machine_to_time))
      setOutwardRemarks(toText(details.outward_remarks))
      setDidPrefill(true)
    })
  }, [details, didPrefill])

  const totalDispatchQty = useMemo(
    () =>
      items.reduce((sum, item) => {
        const value = Number(itemInputs[item.id] || 0)
        return sum + (Number.isFinite(value) ? Math.max(0, value) : 0)
      }, 0),
    [items, itemInputs]
  )

  const hasOverDispatch = items.some((item) => {
    const value = Number(itemInputs[item.id] || 0)
    return value > item.quantity_remaining
  })
  const hasInsufficientInventory = items.some((item) => {
    const value = Number(itemInputs[item.id] || 0)
    const available = Number(item.available_inventory ?? item.quantity_remaining)
    return value > available
  })

  const isFormValid =
    vehicleNumber.trim().length >= 3 &&
    driverName.trim().length >= 2 &&
    driverPhone.trim().length >= 3 &&
    totalDispatchQty > 0 &&
    !hasOverDispatch &&
    !hasInsufficientInventory
  const isDispatchStageOk = normalizedStatus === "STAGED" || normalizedStatus === "PARTIALLY_FULFILLED"

  const handleQtyChange = (lineItemId: number, raw: string) => {
    if (isLocked) return
    if (raw === "") {
      setItemInputs((prev) => ({ ...prev, [lineItemId]: "" }))
      return
    }

    const normalized = raw.replace(/[^\d]/g, "")
    setItemInputs((prev) => ({ ...prev, [lineItemId]: normalized }))
  }

  const handleSubmit = async () => {
    if (!isFormValid || !details || isLocked) return

    const parsedInvoiceQty = Number(invoiceQty || 0)
    const parsedDispatchedQty = Number(dispatchedQty || totalDispatchQty)
    const parsedBasicPrice = Number(basicPrice || 0)
    const parsedCases = Number(noOfCases || 0)
    const parsedPallets = Number(noOfPallets || 0)
    const parsedWeight = Number(weight || 0)

    await dispatchMutation.mutateAsync({
      vehicle_number: vehicleNumber.trim(),
      driver_name: driverName.trim(),
      driver_phone: driverPhone.trim(),
      dispatch_date: dispatchDate || undefined,
      supplierName: supplierName.trim() || undefined,
      invoiceNo: invoiceNo.trim() || undefined,
      invoiceDate: invoiceDate || undefined,
      modelNo: modelNo.trim() || undefined,
      serialNo: serialNo.trim() || undefined,
      materialDescription: materialDescription.trim() || undefined,
      dateOfManufacturing: dateOfManufacturing || undefined,
      basicPrice: Number.isFinite(parsedBasicPrice) ? parsedBasicPrice : undefined,
      invoiceQty: Number.isFinite(parsedInvoiceQty) ? parsedInvoiceQty : undefined,
      dispatchedQty: Number.isFinite(parsedDispatchedQty) ? parsedDispatchedQty : undefined,
      difference:
        Number.isFinite(parsedInvoiceQty) && Number.isFinite(parsedDispatchedQty)
          ? parsedInvoiceQty - parsedDispatchedQty
          : undefined,
      noOfCases: Number.isFinite(parsedCases) ? parsedCases : undefined,
      noOfPallets: Number.isFinite(parsedPallets) ? parsedPallets : undefined,
      weight: Number.isFinite(parsedWeight) ? parsedWeight : undefined,
      handlingType,
      machineType: handlingType === "MACHINE" ? machineType.trim() || undefined : undefined,
      machineFromTime: handlingType === "MACHINE" ? machineFromTime || undefined : undefined,
      machineToTime: handlingType === "MACHINE" ? machineToTime || undefined : undefined,
      outwardRemarks: outwardRemarks.trim() || undefined,
      doNo: details.do_number,
      items: items.map((item) => {
        const entered = Number(itemInputs[item.id] || 0)
        const qty = Math.max(0, Math.min(item.quantity_remaining, Number.isFinite(entered) ? entered : 0))
        return { item_id: item.item_id, quantity: qty }
      }),
    })

    await detailQuery.refetch()
    setItemInputs((prev) => {
      const reset: Record<number, string> = {}
      for (const key of Object.keys(prev)) reset[Number(key)] = ""
      return reset
    })
  }

  const markPicked = async () => {
    if (!details) return
    await workflowMutation.mutateAsync({ status: "PICKED" })
    await detailQuery.refetch()
  }

  const markStaged = async () => {
    if (!details) return
    await workflowMutation.mutateAsync({ status: "STAGED" })
    await detailQuery.refetch()
  }

  if (detailQuery.isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (detailQuery.isError || !details) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DO Fulfillment</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-600">Unable to load delivery order details.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>DO Fulfillment ({details.do_number})</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div
            className={`flex flex-wrap items-center gap-2 rounded-md border p-3 ${statusStyles.panel}`}
          >
            <p className="text-sm">
              Current Status:{" "}
              <span className={`rounded px-2 py-1 font-semibold ${statusStyles.badge}`}>
                {getDOStatusLabel(statusDisplay)}
              </span>
            </p>
            {isCompleted && <p className={`text-sm font-semibold ${statusStyles.tone}`}>DO is completed successfully.</p>}
            <Button
              type="button"
              variant="outline"
              onClick={markPicked}
              disabled={workflowMutation.isPending || !canMarkPicked}
            >
              Mark Picked
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={markStaged}
              disabled={workflowMutation.isPending || normalizedStatus !== "PICKED"}
            >
              Mark Staged
            </Button>
            {!isDispatchStageOk && (
              <p className="text-xs text-amber-700">Dispatch is enabled only in STAGED or PARTIALLY_FULFILLED.</p>
            )}
            {isLocked && (
              <p className="text-xs text-amber-700">This DO is locked. Fulfillment fields are read-only.</p>
            )}
          </div>

          <fieldset disabled={isLocked} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Dispatch Date</Label>
              <Input type="date" value={dispatchDate} onChange={(e) => setDispatchDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Supplier Name</Label>
              <Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Invoice Number</Label>
              <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Invoice Date</Label>
              <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Model No.</Label>
              <Input value={modelNo} onChange={(e) => setModelNo(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Serial No.</Label>
              <Input value={serialNo} onChange={(e) => setSerialNo(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2 md:col-span-2">
              <Label>Material Description</Label>
              <Textarea rows={2} value={materialDescription} onChange={(e) => setMaterialDescription(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Date of Manufacturing</Label>
              <Input
                type="date"
                value={dateOfManufacturing}
                onChange={(e) => setDateOfManufacturing(e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Basic Price</Label>
              <Input
                type="number"
                inputMode="decimal"
                value={basicPrice}
                onChange={(e) => setBasicPrice(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Invoice Qty</Label>
              <Input type="number" inputMode="numeric" value={invoiceQty} onChange={(e) => setInvoiceQty(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Dispatched Qty</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={dispatchedQty}
                onChange={(e) => setDispatchedQty(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Difference</Label>
              <Input
                value={`${(Number(invoiceQty || 0) || 0) - (Number(dispatchedQty || totalDispatchQty) || 0)}`}
                disabled
                readOnly
              />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>No. of Cases</Label>
              <Input type="number" inputMode="numeric" value={noOfCases} onChange={(e) => setNoOfCases(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>No. of Pallets</Label>
              <Input
                type="number"
                inputMode="numeric"
                value={noOfPallets}
                onChange={(e) => setNoOfPallets(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Weight (KG)</Label>
              <Input type="number" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="space-y-2">
              <Label>Handling Type</Label>
              <select
                className="w-full rounded-md border px-3 py-2 text-sm"
                value={handlingType}
                onChange={(e) => setHandlingType((e.target.value as "MANUAL" | "MACHINE") || "MANUAL")}
              >
                <option value="MANUAL">Manual Handling</option>
                <option value="MACHINE">Machine Handling</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Machine Type</Label>
              <Input
                value={machineType}
                onChange={(e) => setMachineType(e.target.value)}
                disabled={handlingType !== "MACHINE"}
              />
            </div>
            <div className="space-y-2">
              <Label>Machine From Time</Label>
              <Input
                type="datetime-local"
                value={machineFromTime}
                onChange={(e) => setMachineFromTime(e.target.value)}
                disabled={handlingType !== "MACHINE"}
              />
            </div>
            <div className="space-y-2">
              <Label>Machine To Time</Label>
              <Input
                type="datetime-local"
                value={machineToTime}
                onChange={(e) => setMachineToTime(e.target.value)}
                disabled={handlingType !== "MACHINE"}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Outward Remarks</Label>
            <Textarea rows={2} value={outwardRemarks} onChange={(e) => setOutwardRemarks(e.target.value)} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Vehicle Number</Label>
              <Input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Driver Name</Label>
              <Input value={driverName} onChange={(e) => setDriverName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Driver Phone</Label>
              <Input value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} />
            </div>
          </div>

          <div className="space-y-3">
            {items.length > 10 && (
              <p className="text-xs text-gray-500">Showing 10 items at a time. Scroll for more.</p>
            )}
            <div className="max-h-[43rem] space-y-3 overflow-y-auto pr-1">
              {items.map((item) => (
                <div key={item.id} className="flex min-h-[4rem] items-center gap-4 rounded-lg border p-4">
                  <div className="flex-1">
                    <p className="font-medium">{item.item_name}</p>
                    <p className="text-sm text-gray-500">{item.item_code}</p>
                    <p className="text-xs text-gray-500">
                      Remaining: {item.quantity_remaining} {item.unit}
                    </p>
                    <p className="text-xs text-gray-500">
                      Allocated+Available: {Number(item.available_inventory ?? 0)} {item.unit}
                    </p>
                  </div>
                  <div className="w-36">
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={itemInputs[item.id] ?? ""}
                      onChange={(e) => handleQtyChange(item.id, e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div className="w-28 text-right text-sm font-medium">
                    {(itemInputs[item.id] || "0")}/{item.quantity_remaining}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {hasOverDispatch && (
            <p className="text-sm text-red-600">One or more quantities exceed remaining balance.</p>
          )}
          {hasInsufficientInventory && (
            <p className="text-sm text-red-600">Insufficient inventory for one or more items.</p>
          )}

          <Button
            onClick={handleSubmit}
            className="w-full"
            disabled={!isFormValid || !isDispatchStageOk || dispatchMutation.isPending || isLocked}
          >
            {dispatchMutation.isPending ? "Submitting..." : "Complete Fulfillment"}
          </Button>
          </fieldset>
        </div>
      </CardContent>
    </Card>
  )
}
