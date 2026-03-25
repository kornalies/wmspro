"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2, Plus, Save, Trash2, Wand2 } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCreateGRN, useUpdateGRN } from "@/hooks/use-grn"
import { handleError } from "@/lib/error-handler"
import { grnFormSchema, type GRNFormPayload, type GRNFormValues } from "@/lib/validations/grn"

type OptionEntity = {
  id: number
  client_name?: string
  warehouse_name?: string
  item_name?: string
  item_code?: string
}

type ZoneLayoutOption = {
  id: number
  warehouse_id: number
  zone_code: string
  zone_name: string
  rack_code: string
  rack_name: string
  bin_code: string
  bin_name: string
}

interface GRNFormProps {
  draftId?: number
  initialData?: {
    client_id?: number
    warehouse_id?: number
    invoiceNumber?: string
    invoiceDate?: string
    vendorName?: string
    vendorGST?: string
    gate_in_number?: string
    model_number?: string
    material_description?: string
    receipt_date?: string
    manufacturing_date?: string
    basic_price?: number
    invoice_quantity?: number
    received_quantity?: number
    damage_quantity?: number
    case_count?: number
    pallet_count?: number
    weight_kg?: number
    handling_type?: "MACHINE" | "MANUAL"
    lineItems?: Array<{
      item_id?: number
      zone_layout_id?: number
      quantity?: number
      rate?: number
      amount?: number
      serial_numbers?: string[]
    }>
  } | null
}

export function GRNForm({ draftId, initialData }: GRNFormProps) {
  const router = useRouter()
  const createMutation = useCreateGRN()
  const updateMutation = useUpdateGRN()
  const isMutating = createMutation.isPending || updateMutation.isPending
  const [clientSearch, setClientSearch] = useState("")
  const [showClientDropdown, setShowClientDropdown] = useState(false)
  const [itemSearch, setItemSearch] = useState("")

  const clientsQuery = useQuery({
    queryKey: ["clients", "active"],
    queryFn: async () => {
      const res = await apiClient.get<OptionEntity[]>("/clients?is_active=true")
      return res.data ?? []
    },
  })

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<OptionEntity[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })

  const itemsQuery = useQuery({
    queryKey: ["items", "active"],
    queryFn: async () => {
      const res = await apiClient.get<OptionEntity[]>("/items?is_active=true")
      return res.data ?? []
    },
  })

  const form = useForm<GRNFormValues>({
    resolver: zodResolver(grnFormSchema),
    defaultValues: {
      client_id: initialData?.client_id?.toString() || "",
      warehouse_id: initialData?.warehouse_id?.toString() || "",
      invoice_number: initialData?.invoiceNumber || "",
      invoice_date: initialData?.invoiceDate || new Date().toISOString().split("T")[0],
      supplier_name: initialData?.vendorName || "",
      supplier_gst: initialData?.vendorGST || "",
      gate_in_number: initialData?.gate_in_number || "",
      model_number: initialData?.model_number || "",
      material_description: initialData?.material_description || "",
      receipt_date: initialData?.receipt_date || new Date().toISOString().split("T")[0],
      manufacturing_date: initialData?.manufacturing_date || "",
      basic_price: initialData?.basic_price,
      invoice_quantity: initialData?.invoice_quantity,
      received_quantity: initialData?.received_quantity,
      damage_quantity: initialData?.damage_quantity,
      case_count: initialData?.case_count,
      pallet_count: initialData?.pallet_count,
      weight_kg: initialData?.weight_kg,
      handling_type: initialData?.handling_type,
      lineItems:
        initialData?.lineItems?.map((item) => ({
          item_id: item.item_id ? String(item.item_id) : "",
          zone_layout_id: item.zone_layout_id ? String(item.zone_layout_id) : "",
          quantity: item.quantity || 1,
          rate: item.rate || (item.amount && item.quantity ? item.amount / item.quantity : 0),
          serial_numbers: (item.serial_numbers || []).join("\n"),
        })) || [{ item_id: "", zone_layout_id: "", quantity: 1, rate: 0, serial_numbers: "" }],
    },
  })

  const {
    register,
    handleSubmit,
    control,
    setValue,
    getValues,
    formState: { errors },
  } = form

  const { fields, append, remove } = useFieldArray({
    control,
    name: "lineItems",
  })
  const selectedClientId = useWatch({ control, name: "client_id" })
  const selectedWarehouseId = useWatch({ control, name: "warehouse_id" })
  const selectedHandlingType = useWatch({ control, name: "handling_type" })
  const invoiceQuantity = useWatch({ control, name: "invoice_quantity" })
  const receivedQuantity = useWatch({ control, name: "received_quantity" })
  const watchedLineItems = useWatch({ control, name: "lineItems" }) || []

  const zoneLayoutsQuery = useQuery({
    queryKey: ["zone-layouts", selectedWarehouseId],
    enabled: !!selectedWarehouseId,
    queryFn: async () => {
      const res = await apiClient.get<ZoneLayoutOption[]>(
        `/zone-layouts?warehouse_id=${selectedWarehouseId}&is_active=true`
      )
      return res.data ?? []
    },
  })

  const loadingLookups =
    clientsQuery.isLoading ||
    warehousesQuery.isLoading ||
    itemsQuery.isLoading ||
    (!!selectedWarehouseId && zoneLayoutsQuery.isLoading)

  const clients = clientsQuery.data ?? []
  const warehouses = warehousesQuery.data ?? []
  const items = itemsQuery.data ?? []
  const zoneLayouts = zoneLayoutsQuery.data ?? []
  const filteredClients = useMemo(() => {
    const term = clientSearch.trim().toLowerCase()
    if (!term) return clients
    return clients.filter((client) => (client.client_name ?? "").toLowerCase().includes(term))
  }, [clients, clientSearch])
  const filteredItems = useMemo(() => {
    const term = itemSearch.trim().toLowerCase()
    if (!term) return items
    return items.filter((item) => {
      const haystack = `${item.item_name ?? ""} ${item.item_code ?? ""}`.toLowerCase()
      return haystack.includes(term)
    })
  }, [items, itemSearch])
  const selectedClientName = useMemo(() => {
    if (!selectedClientId) return ""
    return clients.find((client) => String(client.id) === String(selectedClientId))?.client_name ?? ""
  }, [clients, selectedClientId])
  const clientInputValue = clientSearch || selectedClientName

  const totalQuantity = watchedLineItems.reduce(
    (sum, lineItem) => sum + (Number(lineItem?.quantity) || 0),
    0
  )
  const serialQuantityMismatch = watchedLineItems.some((lineItem) => {
    const qty = Number(lineItem?.quantity) || 0
    const serialCount = (lineItem?.serial_numbers || "")
      .split("\n")
      .map((serial) => serial.trim())
      .filter(Boolean).length
    return qty !== serialCount
  })

  const totalValue = watchedLineItems.reduce((sum, lineItem) => {
    const qty = Number(lineItem?.quantity) || 0
    const rate = Number(lineItem?.rate) || 0
    return sum + qty * rate
  }, 0)

  const quantityDifference =
    typeof invoiceQuantity === "number" && typeof receivedQuantity === "number"
      ? invoiceQuantity - receivedQuantity
      : undefined
  const receivedQtyMismatch =
    typeof receivedQuantity === "number" ? receivedQuantity !== totalQuantity : false
  const receivedQtyGap =
    typeof receivedQuantity === "number" ? receivedQuantity - totalQuantity : 0

  const generateSerialNumbers = (index: number) => {
    const lineItem = watchedLineItems[index]
    const quantity = Number(lineItem?.quantity) || 0
    const itemId = lineItem?.item_id

    if (!quantity || !itemId) {
      toast.error("Please select item and enter quantity first")
      return
    }

    const selectedItem = items.find((item) => item.id.toString() === itemId)
    if (!selectedItem?.item_code) {
      toast.error("Selected item is missing item code")
      return
    }

    const timestamp = Date.now().toString().slice(-6)
    const serials = Array.from({ length: quantity }, (_, i) => {
      return `${selectedItem.item_code}-${timestamp}-${String(i + 1).padStart(3, "0")}`
    })

    setValue(`lineItems.${index}.serial_numbers`, serials.join("\n"))
  }

  const onSubmit = async (data: GRNFormValues, status: "DRAFT" | "CONFIRMED") => {
    const processedLineItems = data.lineItems.map((item) => ({
      item_id: parseInt(item.item_id, 10),
      zone_layout_id: item.zone_layout_id ? parseInt(item.zone_layout_id, 10) : undefined,
      quantity: item.quantity,
      rate: item.rate || 0,
      serial_numbers: item.serial_numbers
        .split("\n")
        .map((serial) => serial.trim())
        .filter(Boolean),
    }))

    if (status === "CONFIRMED") {
      const serialMismatchLine = processedLineItems.find(
        (item) => item.serial_numbers.length !== item.quantity
      )
      if (serialMismatchLine) {
        toast.error(
          `Serial count must match quantity for item ${serialMismatchLine.item_id} (qty: ${serialMismatchLine.quantity}, serials: ${serialMismatchLine.serial_numbers.length})`
        )
        return
      }
    }

    const payload: GRNFormPayload = {
      header: {
        client_id: parseInt(data.client_id, 10),
        warehouse_id: parseInt(data.warehouse_id, 10),
        invoice_number: data.invoice_number,
        invoice_date: data.invoice_date,
        supplier_name: data.supplier_name || "",
        supplier_gst: data.supplier_gst || "",
        gate_in_number: data.gate_in_number || undefined,
        model_number: data.model_number || undefined,
        material_description: data.material_description || undefined,
        receipt_date: data.receipt_date || undefined,
        manufacturing_date: data.manufacturing_date || undefined,
        basic_price: data.basic_price,
        invoice_quantity: data.invoice_quantity,
        received_quantity: data.received_quantity,
        quantity_difference: quantityDifference,
        damage_quantity: data.damage_quantity,
        case_count: data.case_count,
        pallet_count: data.pallet_count,
        weight_kg: data.weight_kg,
        handling_type: data.handling_type,
        source_channel: "WEB_MANUAL",
        status,
        total_items: processedLineItems.length,
        total_quantity: processedLineItems.reduce((sum, item) => sum + item.quantity, 0),
        total_value: processedLineItems.reduce((sum, item) => sum + item.quantity * item.rate, 0),
      },
      lineItems: processedLineItems,
    }

    try {
      if (draftId) {
        await updateMutation.mutateAsync({ id: draftId, payload })
      } else {
        await createMutation.mutateAsync(payload)
      }
      router.push("/grn")
    } catch (error) {
      handleError(error, draftId ? "Failed to update GRN" : "Failed to create GRN")
    }
  }

  const submitDraft = handleSubmit((data) => onSubmit(data, "DRAFT"))
  const submitConfirm = handleSubmit((data) => onSubmit(data, "CONFIRMED"))

  if (loadingLookups) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <form onSubmit={submitConfirm} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>GRN Header Information</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="client_id">Client *</Label>
            <div className="relative">
              <Input
                id="client_id"
                value={clientInputValue}
                onFocus={() => setShowClientDropdown(true)}
                onBlur={() => setTimeout(() => setShowClientDropdown(false), 120)}
                onChange={(e) => {
                  setClientSearch(e.target.value)
                  setShowClientDropdown(true)
                  setValue("client_id", "", { shouldDirty: true, shouldValidate: true })
                }}
                placeholder="Type client name"
                autoComplete="off"
              />
              {showClientDropdown && (
                <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white p-1 shadow-lg">
                  {filteredClients.length > 0 ? (
                    filteredClients.slice(0, 50).map((client) => (
                      <button
                        key={client.id}
                        type="button"
                        className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-gray-100"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setValue("client_id", client.id.toString(), {
                            shouldDirty: true,
                            shouldValidate: true,
                          })
                          setClientSearch(client.client_name ?? "")
                          setShowClientDropdown(false)
                        }}
                      >
                        {client.client_name}
                      </button>
                    ))
                  ) : (
                    <p className="px-2 py-1.5 text-sm text-gray-500">No client found</p>
                  )}
                </div>
              )}
            </div>
            {errors.client_id && <p className="text-sm text-red-600">{errors.client_id.message}</p>}
          </div>

          <div className="space-y-2">
            <Label htmlFor="warehouse_id">Warehouse *</Label>
            <Select
              value={selectedWarehouseId}
              onValueChange={(value) => {
                setValue("warehouse_id", value)
                const currentLineItems = getValues("lineItems")
                currentLineItems.forEach((_, idx) => {
                  setValue(`lineItems.${idx}.zone_layout_id`, "")
                })
              }}
            >
              <SelectTrigger id="warehouse_id">
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={warehouse.id.toString()}>
                    {warehouse.warehouse_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.warehouse_id && (
              <p className="text-sm text-red-600">{errors.warehouse_id.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="invoice_number">Invoice Number *</Label>
            <Input {...register("invoice_number")} className="font-mono" />
            {errors.invoice_number && (
              <p className="text-sm text-red-600">{errors.invoice_number.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="invoice_date">Invoice Date *</Label>
            <Input type="date" {...register("invoice_date")} />
            {errors.invoice_date && (
              <p className="text-sm text-red-600">{errors.invoice_date.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="supplier_name">Supplier Name</Label>
            <Input {...register("supplier_name")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="supplier_gst">Supplier GST Number</Label>
            <Input {...register("supplier_gst")} className="font-mono uppercase" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="gate_in_number">Gate In Number</Label>
            <Input {...register("gate_in_number")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="model_number">Model Number</Label>
            <Input {...register("model_number")} />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="material_description">Material Description</Label>
            <Input {...register("material_description")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="receipt_date">Receipt Date</Label>
            <Input type="date" {...register("receipt_date")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="manufacturing_date">Date of Manufacturing</Label>
            <Input type="date" {...register("manufacturing_date")} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="basic_price">Basic Price</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              {...register("basic_price", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="invoice_quantity">Invoice Qty</Label>
            <Input
              type="number"
              min="0"
              {...register("invoice_quantity", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="received_quantity">Received Qty</Label>
            <Input
              type="number"
              min="0"
              className={receivedQtyMismatch ? "border-amber-500 focus-visible:ring-amber-500/20" : ""}
              {...register("received_quantity", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
            {receivedQtyMismatch && (
              <p className="text-sm text-amber-700">
                Qty mismatch: line total is {totalQuantity}. {Math.abs(receivedQtyGap)}{" "}
                {receivedQtyGap > 0 ? "missing" : "excess"}.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Difference</Label>
            <Input value={quantityDifference ?? ""} readOnly />
          </div>

          <div className="space-y-2">
            <Label htmlFor="damage_quantity">Damage Qty</Label>
            <Input
              type="number"
              min="0"
              {...register("damage_quantity", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="case_count">No. of Cases</Label>
            <Input
              type="number"
              min="0"
              {...register("case_count", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pallet_count">No. of Pallets</Label>
            <Input
              type="number"
              min="0"
              {...register("pallet_count", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="weight_kg">Weight (kg)</Label>
            <Input
              type="number"
              min="0"
              step="0.001"
              {...register("weight_kg", {
                setValueAs: (value) => (value === "" ? undefined : Number(value)),
              })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="handling_type">Handling Type</Label>
            <Select
              value={selectedHandlingType || ""}
              onValueChange={(value: "MACHINE" | "MANUAL") => setValue("handling_type", value)}
            >
              <SelectTrigger id="handling_type">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MACHINE">Machine</SelectItem>
                <SelectItem value="MANUAL">Manual</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Line Items</CardTitle>
            <Button
              type="button"
              onClick={() =>
                append({ item_id: "", zone_layout_id: "", quantity: 1, rate: 0, serial_numbers: "" })
              }
              variant="outline"
              size="sm"
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Item
            </Button>
          </div>
          <div className="pt-2">
            <TypeaheadInput
              value={itemSearch}
              onValueChange={setItemSearch}
              suggestions={items.map((item) => `${item.item_name ?? ""} ${item.item_code ?? ""}`)}
              placeholder="Search item name or code"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {fields.map((field, index) => (
            <div key={field.id} className="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <h4 className="font-medium text-gray-900">Item #{index + 1}</h4>
                {fields.length > 1 && (
                  <Button
                    type="button"
                    onClick={() => remove(index)}
                    variant="ghost"
                    size="sm"
                    className="text-red-600 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <div className="space-y-2">
                  <Label>Item *</Label>
                  <Select
                    value={watchedLineItems[index]?.item_id ?? ""}
                    onValueChange={(value) => setValue(`lineItems.${index}.item_id`, value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select item" />
                    </SelectTrigger>
                    <SelectContent>
                      {filteredItems.map((item) => (
                        <SelectItem key={item.id} value={item.id.toString()}>
                          {item.item_name} ({item.item_code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Quantity *</Label>
                  <Input
                    type="number"
                    min="1"
                    {...register(`lineItems.${index}.quantity`, { valueAsNumber: true })}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Rate</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    {...register(`lineItems.${index}.rate`, { valueAsNumber: true })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Put Away Bin *</Label>
                <Select
                  value={watchedLineItems[index]?.zone_layout_id ?? ""}
                  onValueChange={(value) => setValue(`lineItems.${index}.zone_layout_id`, value)}
                  disabled={!selectedWarehouseId}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        selectedWarehouseId ? "Select zone/rack/bin" : "Select warehouse first"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {zoneLayouts.map((layout) => (
                      <SelectItem key={layout.id} value={layout.id.toString()}>
                        {layout.zone_code}/{layout.rack_code}/{layout.bin_code} - {layout.zone_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {errors.lineItems?.[index]?.zone_layout_id && (
                  <p className="text-sm text-red-600">
                    {errors.lineItems[index]?.zone_layout_id?.message}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Serial Numbers * (one per line)</Label>
                  <Button
                    type="button"
                    onClick={() => generateSerialNumbers(index)}
                    variant="outline"
                    size="sm"
                  >
                    <Wand2 className="mr-2 h-4 w-4" />
                    Auto Generate
                  </Button>
                </div>
                <textarea
                  {...register(`lineItems.${index}.serial_numbers`)}
                  className="min-h-[120px] w-full rounded-md border p-3 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
                {errors.lineItems?.[index]?.serial_numbers && (
                  <p className="text-sm text-red-600">
                    {errors.lineItems[index]?.serial_numbers?.message}
                  </p>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-sm text-gray-600">Total Items</p>
              <p className="text-2xl font-bold text-gray-900">{fields.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Quantity</p>
              <p className="text-2xl font-bold text-gray-900">{totalQuantity}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Value</p>
              <p className="text-2xl font-bold text-blue-600">{totalValue.toFixed(2)}</p>
            </div>
          </div>
          {(receivedQtyMismatch || serialQuantityMismatch) && (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {receivedQtyMismatch && (
                <p>
                  Qty mismatch: line total is {totalQuantity}. Current gap: {Math.abs(receivedQtyGap)}{" "}
                  ({receivedQtyGap > 0 ? "missing" : "excess"}). Received Qty is optional.
                </p>
              )}
              {serialQuantityMismatch && (
                <p>Each line item&apos;s serial count must exactly match its quantity.</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end gap-4">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={isMutating}>
          Cancel
        </Button>
        <Button type="button" variant="secondary" onClick={submitDraft} disabled={isMutating}>
          {isMutating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving Draft...
            </>
          ) : (
            "Save Draft"
          )}
        </Button>
        <Button
          type="submit"
          disabled={isMutating || serialQuantityMismatch}
          className="bg-blue-600 hover:bg-blue-700"
        >
          {isMutating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating GRN...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {draftId ? "Confirm GRN" : "Create GRN"}
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
