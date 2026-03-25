"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery } from "@tanstack/react-query"
import { Loader2, Plus, Save, Trash2 } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { useCreateDO } from "@/hooks/use-do"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const formSchema = z
  .object({
    client_id: z.string().min(1, "Client is required"),
    warehouse_id: z.string().min(1, "Warehouse is required"),
    delivery_address: z.string().min(5, "Delivery address is required"),
    customer_name: z.string().min(2, "Customer name is required"),
    customer_phone: z.string().optional(),

    dispatch_date: z.string().optional(),
    supplier_name: z.string().optional(),
    invoice_no: z.string().optional(),
    invoice_date: z.string().optional(),
    model_no: z.string().optional(),
    serial_no: z.string().optional(),
    material_description: z.string().optional(),
    date_of_manufacturing: z.string().optional(),
    basic_price: z.string().optional(),
    invoice_qty: z.string().optional(),
    dispatched_qty: z.string().optional(),
    no_of_cases: z.string().optional(),
    no_of_pallets: z.string().optional(),
    weight_kg: z.string().optional(),
    handling_type: z.enum(["MACHINE", "MANUAL", ""]).optional(),
    machine_type: z.string().optional(),
    machine_from_time: z.string().optional(),
    machine_to_time: z.string().optional(),
    outward_remarks: z.string().optional(),

    lineItems: z
      .array(
        z.object({
          item_id: z.string().min(1, "Item is required"),
          quantity_requested: z.number().min(1, "Quantity must be at least 1"),
        })
      )
      .min(1, "At least one line item required"),
  })
  .superRefine((value, ctx) => {
    if (value.handling_type === "MACHINE") {
      if (!value.machine_type?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Machine type is required for machine handling",
          path: ["machine_type"],
        })
      }
      if (!value.machine_from_time) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Machine from time is required for machine handling",
          path: ["machine_from_time"],
        })
      }
      if (!value.machine_to_time) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Machine to time is required for machine handling",
          path: ["machine_to_time"],
        })
      }
    }
  })

type FormValues = z.infer<typeof formSchema>

type OptionEntity = {
  id: number
  client_name?: string
  warehouse_name?: string
  item_name?: string
  item_code?: string
  is_active?: boolean
  available_qty?: number
}

type InventoryAvailabilityRow = {
  item_id: number
  item_name?: string
  item_code?: string
  available_qty: number
}

function toNumber(value?: string) {
  if (!value || value.trim() === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export function DOForm() {
  const router = useRouter()
  const createMutation = useCreateDO()
  const [clientSearch, setClientSearch] = useState("")
  const [showClientDropdown, setShowClientDropdown] = useState(false)

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

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      client_id: "",
      warehouse_id: "",
      delivery_address: "",
      customer_name: "",
      customer_phone: "",

      dispatch_date: new Date().toISOString().slice(0, 10),
      supplier_name: "",
      invoice_no: "",
      invoice_date: "",
      model_no: "",
      serial_no: "",
      material_description: "",
      date_of_manufacturing: "",
      basic_price: "",
      invoice_qty: "",
      dispatched_qty: "",
      no_of_cases: "",
      no_of_pallets: "",
      weight_kg: "",
      handling_type: "MANUAL",
      machine_type: "",
      machine_from_time: "",
      machine_to_time: "",
      outward_remarks: "",

      lineItems: [{ item_id: "", quantity_requested: 1 }],
    },
  })

  const {
    register,
    handleSubmit,
    control,
    setValue,
    setError,
    formState: { errors },
  } = form

  const selectedClientId = useWatch({ control, name: "client_id" })
  const selectedWarehouseId = useWatch({ control, name: "warehouse_id" })
  const lineItems = useWatch({ control, name: "lineItems" }) || []
  const handlingType = useWatch({ control, name: "handling_type" }) || "MANUAL"
  const invoiceQty = useWatch({ control, name: "invoice_qty" }) || ""
  const dispatchedQty = useWatch({ control, name: "dispatched_qty" }) || ""
  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" })

  const difference = (Number(invoiceQty || 0) || 0) - (Number(dispatchedQty || 0) || 0)
  const clients = clientsQuery.data ?? []
  const availableItemsQuery = useQuery({
    queryKey: ["do", "available-items", selectedWarehouseId || "", selectedClientId || ""],
    enabled: Boolean(selectedWarehouseId && selectedClientId),
    queryFn: async () => {
      const q = new URLSearchParams({
        warehouse_id: String(selectedWarehouseId),
        client_id: String(selectedClientId),
      })
      const res = await apiClient.get<OptionEntity[]>(`/do/available-items?${q.toString()}`)
      return res.data ?? []
    },
  })
  const selectedItemIds = useMemo(() => {
    const ids = lineItems
      .map((line) => Number(line?.item_id || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
    return Array.from(new Set(ids))
  }, [lineItems])
  const inventoryAvailabilityQuery = useQuery({
    queryKey: ["do", "inventory-availability", selectedWarehouseId || "", selectedClientId || "", selectedItemIds],
    enabled: Boolean(selectedWarehouseId && selectedClientId && selectedItemIds.length > 0),
    queryFn: async () => {
      const q = new URLSearchParams({
        warehouse_id: String(selectedWarehouseId),
        client_id: String(selectedClientId),
        item_ids: selectedItemIds.join(","),
      })
      const res = await apiClient.get<InventoryAvailabilityRow[]>(`/do/inventory-availability?${q.toString()}`)
      return res.data ?? []
    },
  })
  const availabilityByItem = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of inventoryAvailabilityQuery.data ?? []) {
      map.set(Number(row.item_id), Number(row.available_qty || 0))
    }
    return map
  }, [inventoryAvailabilityQuery.data])
  const hasInsufficientStock = useMemo(
    () =>
      lineItems.some((line) => {
        const itemId = Number(line?.item_id || 0)
        const requested = Number(line?.quantity_requested || 0)
        if (!itemId || requested <= 0) return false
        const available = availabilityByItem.get(itemId)
        if (available == null) return false
        return requested > available
      }),
    [lineItems, availabilityByItem]
  )
  const stockSummary = useMemo(() => {
    const totals = lineItems.reduce(
      (acc, line) => {
        const itemId = Number(line?.item_id || 0)
        const requested = Number(line?.quantity_requested || 0)
        if (!itemId || requested <= 0) return acc
        const available = Number(availabilityByItem.get(itemId) ?? 0)
        return {
          requested: acc.requested + requested,
          available: acc.available + available,
        }
      },
      { requested: 0, available: 0 }
    )
    return {
      ...totals,
      enough: totals.requested <= totals.available,
    }
  }, [lineItems, availabilityByItem])

  const selectableItems = useMemo(() => {
    if (selectedWarehouseId && selectedClientId) {
      return availableItemsQuery.data ?? []
    }
    return itemsQuery.data ?? []
  }, [selectedWarehouseId, selectedClientId, availableItemsQuery.data, itemsQuery.data])
  const filteredClients = useMemo(() => {
    const term = clientSearch.trim().toLowerCase()
    if (!term) return clients
    return clients.filter((client) => (client.client_name ?? "").toLowerCase().includes(term))
  }, [clients, clientSearch])




  const onSubmit = async (data: FormValues) => {
    try {
      if (!selectedClientId || !selectedWarehouseId) {
        return
      }
      for (let i = 0; i < data.lineItems.length; i++) {
        const line = data.lineItems[i]
        const itemId = Number(line.item_id || 0)
        if (!itemId) continue
        const available = Number(availabilityByItem.get(itemId) ?? 0)
        if (Number(line.quantity_requested || 0) > available) {
          setError(`lineItems.${i}.quantity_requested`, {
            type: "manual",
            message: `Only ${available} in stock for selected client/warehouse`,
          })
          return
        }
      }

      const parsedInvoiceQty = toNumber(data.invoice_qty)
      const parsedDispatchedQty = toNumber(data.dispatched_qty)

      await createMutation.mutateAsync({
        header: {
          client_id: Number(data.client_id),
          warehouse_id: Number(data.warehouse_id),
          delivery_address: data.delivery_address,
          customer_name: data.customer_name,
          customer_phone: data.customer_phone,

          dispatch_date: data.dispatch_date || undefined,
          supplier_name: data.supplier_name?.trim() || undefined,
          invoice_no: data.invoice_no?.trim() || undefined,
          invoice_date: data.invoice_date || undefined,
          model_no: data.model_no?.trim() || undefined,
          serial_no: data.serial_no?.trim() || undefined,
          material_description: data.material_description?.trim() || undefined,
          date_of_manufacturing: data.date_of_manufacturing || undefined,
          basic_price: toNumber(data.basic_price),
          invoice_qty: parsedInvoiceQty,
          dispatched_qty: parsedDispatchedQty,
          quantity_difference:
            parsedInvoiceQty !== undefined && parsedDispatchedQty !== undefined
              ? parsedInvoiceQty - parsedDispatchedQty
              : undefined,
          no_of_cases: toNumber(data.no_of_cases),
          no_of_pallets: toNumber(data.no_of_pallets),
          weight_kg: toNumber(data.weight_kg),
          handling_type: data.handling_type || undefined,
          machine_type: data.handling_type === "MACHINE" ? data.machine_type?.trim() || undefined : undefined,
          machine_from_time:
            data.handling_type === "MACHINE" && data.machine_from_time
              ? new Date(data.machine_from_time).toISOString()
              : undefined,
          machine_to_time:
            data.handling_type === "MACHINE" && data.machine_to_time
              ? new Date(data.machine_to_time).toISOString()
              : undefined,
          outward_remarks: data.outward_remarks?.trim() || undefined,

          total_items: data.lineItems.length,
          total_quantity_requested: data.lineItems.reduce((sum, item) => sum + item.quantity_requested, 0),
        },
        lineItems: data.lineItems.map((item) => ({
          item_id: Number(item.item_id),
          quantity_requested: item.quantity_requested,
        })),
      })
      router.push("/do")
    } catch (error) {
      handleError(error, "Failed to create DO")
    }
  }

  if (clientsQuery.isLoading || warehousesQuery.isLoading || itemsQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Delivery Order Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Client *</Label>
            <div className="relative">
              <Input
                value={clientSearch}
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
                          setValue("client_id", String(client.id), {
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
            <Label>Warehouse *</Label>
            <Select value={selectedWarehouseId} onValueChange={(value) => setValue("warehouse_id", value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {(warehousesQuery.data ?? []).map((warehouse) => (
                  <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                    {warehouse.warehouse_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.warehouse_id && <p className="text-sm text-red-600">{errors.warehouse_id.message}</p>}
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>Delivery Address *</Label>
            <Textarea {...register("delivery_address")} rows={3} />
            {errors.delivery_address && <p className="text-sm text-red-600">{errors.delivery_address.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Customer Name *</Label>
            <Input {...register("customer_name")} />
            {errors.customer_name && <p className="text-sm text-red-600">{errors.customer_name.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Customer Phone</Label>
            <Input {...register("customer_phone")} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dispatch/Capture Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Dispatch Date</Label>
            <Input type="date" {...register("dispatch_date")} />
          </div>
          <div className="space-y-2">
            <Label>Supplier Name</Label>
            <Input {...register("supplier_name")} />
          </div>
          <div className="space-y-2">
            <Label>Invoice Number</Label>
            <Input {...register("invoice_no")} />
          </div>
          <div className="space-y-2">
            <Label>Invoice Date</Label>
            <Input type="date" {...register("invoice_date")} />
          </div>
          <div className="space-y-2">
            <Label>Model No.</Label>
            <Input {...register("model_no")} />
          </div>
          <div className="space-y-2">
            <Label>Serial No.</Label>
            <Input {...register("serial_no")} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label>Material Description</Label>
            <Textarea rows={2} {...register("material_description")} />
          </div>
          <div className="space-y-2">
            <Label>Date of Manufacturing</Label>
            <Input type="date" {...register("date_of_manufacturing")} />
          </div>
          <div className="space-y-2">
            <Label>Basic Price</Label>
            <Input type="number" step="0.01" inputMode="decimal" {...register("basic_price")} />
          </div>
          <div className="space-y-2">
            <Label>Invoice Qty</Label>
            <Input type="number" inputMode="numeric" {...register("invoice_qty")} />
          </div>
          <div className="space-y-2">
            <Label>Dispatched Qty</Label>
            <Input type="number" inputMode="numeric" {...register("dispatched_qty")} />
          </div>
          <div className="space-y-2">
            <Label>Difference</Label>
            <Input readOnly disabled value={String(difference)} />
          </div>
          <div className="space-y-2">
            <Label>No. of Cases</Label>
            <Input type="number" inputMode="numeric" {...register("no_of_cases")} />
          </div>
          <div className="space-y-2">
            <Label>No. of Pallets</Label>
            <Input type="number" inputMode="numeric" {...register("no_of_pallets")} />
          </div>
          <div className="space-y-2">
            <Label>Weight (KG)</Label>
            <Input type="number" step="0.001" inputMode="decimal" {...register("weight_kg")} />
          </div>

          <div className="space-y-2">
            <Label>Handling Type</Label>
            <Select value={handlingType} onValueChange={(value) => setValue("handling_type", value as "MACHINE" | "MANUAL" | "")}> 
              <SelectTrigger>
                <SelectValue placeholder="Select handling type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="MANUAL">Manual Handling</SelectItem>
                <SelectItem value="MACHINE">Machine Handling</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Machine Type</Label>
            <Input {...register("machine_type")} disabled={handlingType !== "MACHINE"} />
            {errors.machine_type && <p className="text-sm text-red-600">{errors.machine_type.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Machine From Time</Label>
            <Input type="datetime-local" {...register("machine_from_time")} disabled={handlingType !== "MACHINE"} />
            {errors.machine_from_time && <p className="text-sm text-red-600">{errors.machine_from_time.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Machine To Time</Label>
            <Input type="datetime-local" {...register("machine_to_time")} disabled={handlingType !== "MACHINE"} />
            {errors.machine_to_time && <p className="text-sm text-red-600">{errors.machine_to_time.message}</p>}
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>Outward Remarks</Label>
            <Textarea rows={2} {...register("outward_remarks")} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Items to Deliver</CardTitle>
            <Button type="button" onClick={() => append({ item_id: "", quantity_requested: 1 })} variant="outline" size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Item
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`rounded-md border px-3 py-2 text-sm ${
              stockSummary.enough ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            <span className="font-medium">Stock Summary:</span>{" "}
            Requested {stockSummary.requested} | Available {stockSummary.available}
          </div>
          {fields.map((field, index) => (
            <div key={field.id} className="space-y-4 rounded-lg border bg-gray-50 p-4">
              <div className="flex items-center justify-between">
                <h4 className="font-medium">Item #{index + 1}</h4>
                {fields.length > 1 && (
                  <Button type="button" onClick={() => remove(index)} variant="ghost" size="sm" className="text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Item *</Label>
                  <Select value={lineItems[index]?.item_id ?? ""} onValueChange={(value) => setValue(`lineItems.${index}.item_id`, value)}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={
                          selectedWarehouseId && selectedClientId
                            ? availableItemsQuery.isFetching
                              ? "Loading stocked items..."
                              : "Select in-stock item"
                            : "Select client and warehouse first"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {selectableItems.map((item) => (
                        <SelectItem key={item.id} value={String(item.id)}>
                          {item.item_name} ({item.item_code})
                          {selectedWarehouseId && selectedClientId ? ` - In Stock: ${Number(item.available_qty || 0)}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedWarehouseId && selectedClientId && !availableItemsQuery.isFetching && selectableItems.length === 0 ? (
                    <p className="text-xs text-amber-700">No in-stock items found for selected client and warehouse.</p>
                  ) : null}
                  {lineItems[index]?.item_id ? (
                    <p className="text-xs text-gray-500">
                      Available: {availabilityByItem.get(Number(lineItems[index]?.item_id || 0)) ?? 0}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>Quantity Requested *</Label>
                  <Input
                    type="number"
                    min="1"
                    {...register(`lineItems.${index}.quantity_requested`, { valueAsNumber: true })}
                  />
                  {errors.lineItems?.[index]?.quantity_requested && (
                    <p className="text-sm text-red-600">
                      {String(errors.lineItems[index]?.quantity_requested?.message || "")}
                    </p>
                  )}
                  {!errors.lineItems?.[index]?.quantity_requested &&
                  Number(lineItems[index]?.item_id || 0) > 0 &&
                  Number(lineItems[index]?.quantity_requested || 0) >
                    Number(availabilityByItem.get(Number(lineItems[index]?.item_id || 0)) ?? 0) ? (
                    <p className="text-sm text-red-600">
                      Insufficient stock for this item in selected client/warehouse.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
          {hasInsufficientStock && (
            <p className="text-sm font-medium text-red-600">
              Cannot create DO: one or more items have insufficient stock.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-blue-200 bg-blue-50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 gap-4 text-center">
            <div>
              <p className="text-sm text-gray-600">Total Items</p>
              <p className="text-2xl font-bold">{fields.length}</p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Total Quantity</p>
              <p className="text-2xl font-bold text-blue-600">
                {lineItems.reduce((sum, item) => sum + (Number(item?.quantity_requested) || 0), 0)}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-4">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={createMutation.isPending || hasInsufficientStock || inventoryAvailabilityQuery.isFetching}
          className="bg-blue-600"
        >
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Creating DO...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Create Delivery Order
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
