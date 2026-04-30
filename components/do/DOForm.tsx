"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  FileText,
  Loader2,
  PackageCheck,
  Plus,
  Save,
  Send,
  Trash2,
  Truck,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { useCreateDO } from "@/hooks/use-do"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

const DRAFT_KEY = "wmspro.do.new.draft"

const formSchema = z
  .object({
    client_id: z.string().min(1, "Client is required"),
    warehouse_id: z.string().min(1, "Warehouse is required"),
    address_line1: z.string().min(3, "Address line 1 is required"),
    address_line2: z.string().optional(),
    city: z.string().min(2, "City is required"),
    state: z.string().min(2, "State is required"),
    postal_code: z.string().min(3, "Postal code is required"),
    country: z.string().min(2, "Country is required"),
    customer_name: z.string().min(2, "Customer name is required"),
    customer_phone: z.string().regex(/^[0-9+\-\s()]{7,20}$/, "Enter a valid phone number").optional().or(z.literal("")),
    delivery_type: z.enum(["CUSTOMER_DELIVERY", "TRANSFER", "RETURN", "REPLACEMENT"]),
    priority: z.enum(["NORMAL", "URGENT", "EXPRESS", "HOLD"]),
    carrier_name: z.string().optional(),
    vehicle_no: z.string().optional(),
    dispatch_slot: z.string().optional(),

    dispatch_date: z.string().min(1, "Dispatch date is required"),
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
    handling_type: z.enum(["MACHINE", "MANUAL", ""]),
    machine_type: z.string().optional(),
    machine_from_time: z.string().optional(),
    machine_to_time: z.string().optional(),
    outward_remarks: z.string().optional(),
    allocation_rule: z.enum(["FIFO", "FEFO", "BATCH", "SERIAL", "LOCATION"]),
    attachment_names: z.array(z.string()).optional(),

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
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const dispatchDate = value.dispatch_date ? new Date(value.dispatch_date) : null
    dispatchDate?.setHours(0, 0, 0, 0)
    if (dispatchDate && dispatchDate < today) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dispatch date cannot be in the past", path: ["dispatch_date"] })
    }
    if (value.invoice_date && dispatchDate && new Date(value.invoice_date) > dispatchDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invoice date cannot be after dispatch date", path: ["invoice_date"] })
    }
    if (value.handling_type === "MACHINE") {
      if (!value.machine_type?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Machine type is required", path: ["machine_type"] })
      if (!value.machine_from_time) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Machine from time is required", path: ["machine_from_time"] })
      if (!value.machine_to_time) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Machine to time is required", path: ["machine_to_time"] })
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

type DeliveryOrderRow = {
  id: number
  client_name?: string
  invoice_no?: string
  dispatch_date?: string
}

type InventoryAvailabilityRow = {
  item_id: number
  item_name?: string
  item_code?: string
  available_qty: number
}

type StepId = "customer" | "dispatch" | "items" | "review"
type SubmitIntent = "create" | "approval"

function toNumber(value?: string) {
  if (!value || value.trim() === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function defaultValues(): FormValues {
  return {
    client_id: "",
    warehouse_id: "",
    address_line1: "",
    address_line2: "",
    city: "",
    state: "",
    postal_code: "",
    country: "India",
    customer_name: "",
    customer_phone: "",
    delivery_type: "CUSTOMER_DELIVERY",
    priority: "NORMAL",
    carrier_name: "",
    vehicle_no: "",
    dispatch_slot: "",
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
    allocation_rule: "FIFO",
    attachment_names: [],
    lineItems: [{ item_id: "", quantity_requested: 1 }],
  }
}

function loadInitialValues() {
  if (typeof window === "undefined") {
    return { values: defaultValues(), restored: false }
  }
  const draft = window.localStorage.getItem(DRAFT_KEY)
  if (!draft) return { values: defaultValues(), restored: false }
  try {
    return { values: { ...defaultValues(), ...(JSON.parse(draft) as FormValues) }, restored: true }
  } catch {
    window.localStorage.removeItem(DRAFT_KEY)
    return { values: defaultValues(), restored: false }
  }
}

function fieldError(message?: string) {
  return message ? <p className="text-sm text-red-600">{message}</p> : null
}

export function DOForm() {
  const router = useRouter()
  const createMutation = useCreateDO()
  const [initialDraft] = useState(loadInitialValues)
  const [clientSearch, setClientSearch] = useState("")
  const [showClientDropdown, setShowClientDropdown] = useState(false)
  const [activeStep, setActiveStep] = useState<StepId>("customer")
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(initialDraft.restored ? "Restored draft" : null)
  const [submitIntent, setSubmitIntent] = useState<SubmitIntent>("create")

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
    defaultValues: initialDraft.values,
    mode: "onBlur",
  })

  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    setError,
    trigger,
    formState: { errors, dirtyFields },
  } = form

  const selectedClientId = useWatch({ control, name: "client_id" })
  const selectedWarehouseId = useWatch({ control, name: "warehouse_id" })
  const watchedLineItems = useWatch({ control, name: "lineItems" })
  const lineItems = useMemo(() => watchedLineItems || [], [watchedLineItems])
  const handlingType = useWatch({ control, name: "handling_type" }) || "MANUAL"
  const invoiceQty = useWatch({ control, name: "invoice_qty" }) || ""
  const dispatchedQty = useWatch({ control, name: "dispatched_qty" }) || ""
  const invoiceNo = useWatch({ control, name: "invoice_no" }) || ""
  const dispatchDate = useWatch({ control, name: "dispatch_date" }) || ""
  const attachmentNames = useWatch({ control, name: "attachment_names" }) || []
  const { fields, append, remove } = useFieldArray({ control, name: "lineItems" })

  const clients = useMemo(() => clientsQuery.data ?? [], [clientsQuery.data])
  const warehouses = useMemo(() => warehousesQuery.data ?? [], [warehousesQuery.data])
  const selectedClient = clients.find((client) => String(client.id) === selectedClientId)
  const selectedWarehouse = warehouses.find((warehouse) => String(warehouse.id) === selectedWarehouseId)
  const clientInputValue = clientSearch || selectedClient?.client_name || ""

  const availableItemsQuery = useQuery({
    queryKey: ["do", "available-items", selectedWarehouseId || "", selectedClientId || ""],
    enabled: Boolean(selectedWarehouseId && selectedClientId),
    queryFn: async () => {
      const q = new URLSearchParams({ warehouse_id: String(selectedWarehouseId), client_id: String(selectedClientId) })
      const res = await apiClient.get<OptionEntity[]>(`/do/available-items?${q.toString()}`)
      return res.data ?? []
    },
  })

  const selectedItemIds = useMemo(() => {
    const ids = lineItems.map((line) => Number(line?.item_id || 0)).filter((id) => Number.isInteger(id) && id > 0)
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

  const duplicateQuery = useQuery({
    queryKey: ["do", "duplicate-check", selectedClientId || "", invoiceNo.trim()],
    enabled: Boolean(selectedClientId && invoiceNo.trim().length >= 3),
    queryFn: async () => {
      const res = await apiClient.get<{ data?: DeliveryOrderRow[] } | DeliveryOrderRow[]>(`/do?limit=100`)
      const rows = Array.isArray(res.data) ? res.data : res.data?.data ?? []
      return rows.filter((row) => row.invoice_no?.trim().toLowerCase() === invoiceNo.trim().toLowerCase())
    },
  })

  const availabilityByItem = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of inventoryAvailabilityQuery.data ?? []) {
      map.set(Number(row.item_id), Number(row.available_qty || 0))
    }
    return map
  }, [inventoryAvailabilityQuery.data])

  const selectableItems = useMemo(() => {
    if (selectedWarehouseId && selectedClientId) return availableItemsQuery.data ?? []
    return itemsQuery.data ?? []
  }, [selectedWarehouseId, selectedClientId, availableItemsQuery.data, itemsQuery.data])

  const filteredClients = useMemo(() => {
    const term = clientSearch.trim().toLowerCase()
    if (!term) return clients
    return clients.filter((client) => (client.client_name ?? "").toLowerCase().includes(term))
  }, [clients, clientSearch])

  const totals = useMemo(() => {
    let requested = 0
    let available = 0
    let short = 0
    let completedLines = 0
    for (const line of lineItems) {
      const itemId = Number(line?.item_id || 0)
      const qty = Number(line?.quantity_requested || 0)
      if (itemId && qty > 0) completedLines += 1
      requested += qty > 0 ? qty : 0
      const lineAvailable = itemId ? Number(availabilityByItem.get(itemId) ?? 0) : 0
      available += lineAvailable
      short += Math.max(0, qty - lineAvailable)
    }
    return {
      requested,
      available,
      short,
      completedLines,
      enough: short === 0,
      totalLines: lineItems.length,
    }
  }, [lineItems, availabilityByItem])

  const difference = (Number(invoiceQty || 0) || 0) - (Number(dispatchedQty || 0) || 0)
  const requiredComplete = [
    selectedClientId,
    selectedWarehouseId,
    getValues("address_line1"),
    getValues("city"),
    getValues("state"),
    getValues("postal_code"),
    getValues("customer_name"),
    dispatchDate,
    totals.completedLines === totals.totalLines && totals.totalLines > 0 ? "items" : "",
  ].filter(Boolean).length
  const progress = Math.round((requiredComplete / 9) * 100)
  const hasInsufficientStock = !totals.enough
  const duplicateWarning = (duplicateQuery.data?.length ?? 0) > 0

  const steps: Array<{ id: StepId; label: string; icon: typeof UserRound }> = [
    { id: "customer", label: "Customer & Delivery", icon: UserRound },
    { id: "dispatch", label: "Dispatch", icon: Truck },
    { id: "items", label: "Items & Allocation", icon: PackageCheck },
    { id: "review", label: "Review", icon: ClipboardCheck },
  ]

  const saveDraft = () => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(getValues()))
    const savedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    setLastSavedAt(`Saved ${savedAt}`)
    toast.success("Draft saved")
  }

  const validateCurrent = async () => {
    const valid = await trigger()
    if (valid && !hasInsufficientStock) toast.success("Delivery order is ready to create")
    if (!valid || hasInsufficientStock) toast.error("Review highlighted fields before creating the DO")
  }

  const onSubmit = async (data: FormValues) => {
    try {
      for (let i = 0; i < data.lineItems.length; i++) {
        const line = data.lineItems[i]
        const available = Number(availabilityByItem.get(Number(line.item_id || 0)) ?? 0)
        if (Number(line.quantity_requested || 0) > available) {
          setError(`lineItems.${i}.quantity_requested`, {
            type: "manual",
            message: `Only ${available} in stock for selected client/warehouse`,
          })
          setActiveStep("items")
          return
        }
      }

      const deliveryAddress = [
        data.address_line1,
        data.address_line2,
        data.city,
        data.state,
        data.postal_code,
        data.country,
      ]
        .filter(Boolean)
        .join(", ")
      const operationalNotes = [
        data.delivery_type !== "CUSTOMER_DELIVERY" ? `Delivery type: ${data.delivery_type}` : "",
        data.priority !== "NORMAL" ? `Priority: ${data.priority}` : "",
        data.allocation_rule !== "FIFO" ? `Allocation rule: ${data.allocation_rule}` : "",
        data.carrier_name ? `Carrier: ${data.carrier_name}` : "",
        data.vehicle_no ? `Vehicle: ${data.vehicle_no}` : "",
        data.dispatch_slot ? `Slot: ${data.dispatch_slot}` : "",
        attachmentNames.length ? `Attachments: ${attachmentNames.join(", ")}` : "",
        data.outward_remarks?.trim() || "",
        submitIntent === "approval" ? "Submission intent: approval requested" : "",
      ].filter(Boolean)

      const parsedInvoiceQty = toNumber(data.invoice_qty)
      const parsedDispatchedQty = toNumber(data.dispatched_qty)

      await createMutation.mutateAsync({
        header: {
          client_id: Number(data.client_id),
          warehouse_id: Number(data.warehouse_id),
          delivery_address: deliveryAddress,
          customer_name: data.customer_name,
          customer_phone: data.customer_phone || undefined,
          dispatch_date: data.dispatch_date,
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
            parsedInvoiceQty !== undefined && parsedDispatchedQty !== undefined ? parsedInvoiceQty - parsedDispatchedQty : undefined,
          no_of_cases: toNumber(data.no_of_cases),
          no_of_pallets: toNumber(data.no_of_pallets),
          weight_kg: toNumber(data.weight_kg),
          handling_type: data.handling_type || undefined,
          machine_type: data.handling_type === "MACHINE" ? data.machine_type?.trim() || undefined : undefined,
          machine_from_time: data.handling_type === "MACHINE" && data.machine_from_time ? new Date(data.machine_from_time).toISOString() : undefined,
          machine_to_time: data.handling_type === "MACHINE" && data.machine_to_time ? new Date(data.machine_to_time).toISOString() : undefined,
          outward_remarks: operationalNotes.join(" | ") || undefined,
          total_items: data.lineItems.length,
          total_quantity_requested: data.lineItems.reduce((sum, item) => sum + item.quantity_requested, 0),
        },
        lineItems: data.lineItems.map((item) => ({
          item_id: Number(item.item_id),
          quantity_requested: item.quantity_requested,
        })),
      })
      window.localStorage.removeItem(DRAFT_KEY)
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
    <form onSubmit={handleSubmit(onSubmit)} className="pb-24">
      <div className="mb-5 flex flex-wrap justify-end gap-2">
        <Badge variant="outline">{progress}% complete</Badge>
        <Badge className={totals.enough ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}>
          {totals.enough ? "Allocation ready" : `${totals.short} short`}
        </Badge>
        {lastSavedAt ? <Badge variant="secondary">{lastSavedAt}</Badge> : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="grid gap-2 md:grid-cols-4">
            {steps.map((step, index) => {
              const Icon = step.icon
              const active = activeStep === step.id
              return (
                <button
                  key={step.id}
                  type="button"
                  onClick={() => setActiveStep(step.id)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${
                    active ? "border-blue-600 bg-blue-50 text-blue-700" : "bg-white hover:bg-gray-50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="font-medium">{index + 1}. {step.label}</span>
                </button>
              )
            })}
          </div>

          {duplicateWarning ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4" />
              A delivery order with this invoice number already exists. Confirm this is intentional before creating another one.
            </div>
          ) : null}

          {activeStep === "customer" ? (
            <Card>
              <CardHeader>
                <CardTitle>Customer & Delivery</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Client *</Label>
                  <div className="relative">
                    <Input
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
                    {showClientDropdown ? (
                      <div className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-white p-1 shadow-lg">
                        {filteredClients.slice(0, 50).map((client) => (
                          <button
                            key={client.id}
                            type="button"
                            className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-gray-100"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setValue("client_id", String(client.id), { shouldDirty: true, shouldValidate: true })
                              setClientSearch(client.client_name ?? "")
                              setShowClientDropdown(false)
                            }}
                          >
                            {client.client_name}
                          </button>
                        ))}
                        {filteredClients.length === 0 ? <p className="px-2 py-1.5 text-sm text-gray-500">No client found</p> : null}
                      </div>
                    ) : null}
                  </div>
                  {fieldError(errors.client_id?.message)}
                </div>

                <div className="space-y-2">
                  <Label>Warehouse *</Label>
                  <Select value={selectedWarehouseId} onValueChange={(value) => setValue("warehouse_id", value, { shouldDirty: true, shouldValidate: true })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select warehouse" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((warehouse) => (
                        <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                          {warehouse.warehouse_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {fieldError(errors.warehouse_id?.message)}
                </div>

                <div className="space-y-2">
                  <Label>Customer Name *</Label>
                  <Input {...register("customer_name")} placeholder="Customer or consignee name" />
                  {fieldError(errors.customer_name?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Customer Phone</Label>
                  <Input {...register("customer_phone")} placeholder="+91 98765 43210" />
                  {fieldError(errors.customer_phone?.message)}
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Address Line 1 *</Label>
                  <Input {...register("address_line1")} placeholder="Building, street, landmark" />
                  {fieldError(errors.address_line1?.message)}
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Address Line 2</Label>
                  <Input {...register("address_line2")} placeholder="Area, floor, dock, or special instruction" />
                </div>
                <div className="space-y-2">
                  <Label>City *</Label>
                  <Input {...register("city")} />
                  {fieldError(errors.city?.message)}
                </div>
                <div className="space-y-2">
                  <Label>State *</Label>
                  <Input {...register("state")} />
                  {fieldError(errors.state?.message)}
                </div>
                <div className="space-y-2">
                  <Label>PIN / Postal Code *</Label>
                  <Input {...register("postal_code")} />
                  {fieldError(errors.postal_code?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Country *</Label>
                  <Input {...register("country")} />
                  {fieldError(errors.country?.message)}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {activeStep === "dispatch" ? (
            <Card>
              <CardHeader>
                <CardTitle>Dispatch & Capture</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Delivery Type</Label>
                  <Select value={getValues("delivery_type")} onValueChange={(value) => setValue("delivery_type", value as FormValues["delivery_type"], { shouldDirty: true })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CUSTOMER_DELIVERY">Customer Delivery</SelectItem>
                      <SelectItem value="TRANSFER">Transfer</SelectItem>
                      <SelectItem value="RETURN">Return</SelectItem>
                      <SelectItem value="REPLACEMENT">Replacement</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select value={getValues("priority")} onValueChange={(value) => setValue("priority", value as FormValues["priority"], { shouldDirty: true })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="NORMAL">Normal</SelectItem>
                      <SelectItem value="URGENT">Urgent</SelectItem>
                      <SelectItem value="EXPRESS">Express</SelectItem>
                      <SelectItem value="HOLD">Hold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Dispatch Date *</Label>
                  <Input type="date" {...register("dispatch_date")} />
                  {fieldError(errors.dispatch_date?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Dispatch Slot</Label>
                  <Input {...register("dispatch_slot")} placeholder="10:00-14:00" />
                </div>
                <div className="space-y-2">
                  <Label>Carrier</Label>
                  <Input {...register("carrier_name")} placeholder="Carrier or transporter" />
                </div>
                <div className="space-y-2">
                  <Label>Vehicle No.</Label>
                  <Input {...register("vehicle_no")} placeholder="TN 01 AB 1234" />
                </div>
                <div className="space-y-2">
                  <Label>Invoice Number</Label>
                  <Input {...register("invoice_no")} placeholder="INV-2026-0012" />
                </div>
                <div className="space-y-2">
                  <Label>Invoice Date</Label>
                  <Input type="date" {...register("invoice_date")} />
                  {fieldError(errors.invoice_date?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Supplier Name</Label>
                  <Input {...register("supplier_name")} />
                </div>
                <div className="space-y-2">
                  <Label>Model No.</Label>
                  <Input {...register("model_no")} />
                </div>
                <div className="space-y-2">
                  <Label>Serial No.</Label>
                  <Input {...register("serial_no")} />
                </div>
                <div className="space-y-2">
                  <Label>Date of Manufacturing</Label>
                  <Input type="date" {...register("date_of_manufacturing")} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label>Material Description</Label>
                  <Textarea rows={2} {...register("material_description")} />
                </div>
                <div className="space-y-2">
                  <Label>Basic Price</Label>
                  <Input type="number" step="0.01" inputMode="decimal" {...register("basic_price")} />
                </div>
                <div className="space-y-2">
                  <Label>Weight (KG)</Label>
                  <Input type="number" step="0.001" inputMode="decimal" {...register("weight_kg")} />
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
                  <Label>Handling Type</Label>
                  <Select value={handlingType} onValueChange={(value) => setValue("handling_type", value as "MACHINE" | "MANUAL" | "", { shouldDirty: true, shouldValidate: true })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MANUAL">Manual Handling</SelectItem>
                      <SelectItem value="MACHINE">Machine Handling</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Machine Type</Label>
                  <Input {...register("machine_type")} disabled={handlingType !== "MACHINE"} />
                  {fieldError(errors.machine_type?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Machine From Time</Label>
                  <Input type="datetime-local" {...register("machine_from_time")} disabled={handlingType !== "MACHINE"} />
                  {fieldError(errors.machine_from_time?.message)}
                </div>
                <div className="space-y-2">
                  <Label>Machine To Time</Label>
                  <Input type="datetime-local" {...register("machine_to_time")} disabled={handlingType !== "MACHINE"} />
                  {fieldError(errors.machine_to_time?.message)}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {activeStep === "items" ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>Items & Allocation</CardTitle>
                  <Button type="button" onClick={() => append({ item_id: "", quantity_requested: 1 })} variant="outline" size="sm">
                    <Plus className="h-4 w-4" />
                    Add Item
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="rounded-md border bg-gray-50 p-3">
                    <p className="text-xs text-gray-500">Rule</p>
                    <Select value={getValues("allocation_rule")} onValueChange={(value) => setValue("allocation_rule", value as FormValues["allocation_rule"], { shouldDirty: true })}>
                      <SelectTrigger className="mt-2"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="FIFO">FIFO</SelectItem>
                        <SelectItem value="FEFO">FEFO</SelectItem>
                        <SelectItem value="BATCH">Batch</SelectItem>
                        <SelectItem value="SERIAL">Serial</SelectItem>
                        <SelectItem value="LOCATION">Location Priority</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Metric label="Requested" value={totals.requested} />
                  <Metric label="Available" value={totals.available} />
                  <Metric label="Short" value={totals.short} tone={totals.short ? "text-red-700" : "text-emerald-700"} />
                </div>

                {fields.map((field, index) => {
                  const itemId = Number(lineItems[index]?.item_id || 0)
                  const requested = Number(lineItems[index]?.quantity_requested || 0)
                  const available = Number(availabilityByItem.get(itemId) ?? 0)
                  const short = Math.max(0, requested - available)
                  return (
                    <div key={field.id} className="rounded-md border bg-gray-50 p-4">
                      <div className="mb-3 flex items-center justify-between">
                        <h4 className="font-medium">Item #{index + 1}</h4>
                        {fields.length > 1 ? (
                          <Button type="button" onClick={() => remove(index)} variant="ghost" size="icon-sm" className="text-red-600">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        ) : null}
                      </div>
                      <div className="grid gap-4 md:grid-cols-[1fr_160px_220px]">
                        <div className="space-y-2">
                          <Label>Item *</Label>
                          <Select value={lineItems[index]?.item_id ?? ""} onValueChange={(value) => setValue(`lineItems.${index}.item_id`, value, { shouldDirty: true, shouldValidate: true })}>
                            <SelectTrigger>
                              <SelectValue placeholder={selectedWarehouseId && selectedClientId ? "Select in-stock item" : "Select client and warehouse first"} />
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
                        </div>
                        <div className="space-y-2">
                          <Label>Qty *</Label>
                          <Input type="number" min="1" {...register(`lineItems.${index}.quantity_requested`, { valueAsNumber: true })} />
                          {fieldError(errors.lineItems?.[index]?.quantity_requested?.message)}
                        </div>
                        <div className="rounded-md border bg-white p-3 text-sm">
                          <div className="flex justify-between"><span>Available</span><strong>{available}</strong></div>
                          <div className="mt-1 flex justify-between"><span>Reserved</span><strong>{short ? available : requested}</strong></div>
                          <div className={`mt-1 flex justify-between ${short ? "text-red-700" : "text-emerald-700"}`}>
                            <span>Short</span><strong>{short}</strong>
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {hasInsufficientStock ? (
                  <p className="text-sm font-medium text-red-600">Cannot create DO: one or more items have insufficient stock.</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {activeStep === "review" ? (
            <Card>
              <CardHeader>
                <CardTitle>Review & Controls</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <ReviewTile label="Client" value={selectedClient?.client_name || "Not selected"} />
                  <ReviewTile label="Warehouse" value={selectedWarehouse?.warehouse_name || "Not selected"} />
                  <ReviewTile label="Dispatch" value={dispatchDate || "Not set"} />
                  <ReviewTile label="Items" value={`${totals.totalLines} lines`} />
                  <ReviewTile label="Quantity" value={`${totals.requested} requested`} />
                  <ReviewTile label="Allocation" value={totals.enough ? "Fully allocatable" : `${totals.short} short`} tone={totals.enough ? "text-emerald-700" : "text-red-700"} />
                </div>
                <div className="space-y-2">
                  <Label>Attachments</Label>
                  <Input
                    type="file"
                    multiple
                    onChange={(event) => {
                      const names = Array.from(event.target.files ?? []).map((file) => file.name)
                      setValue("attachment_names", names, { shouldDirty: true })
                    }}
                  />
                  <p className="text-xs text-gray-500">Invoice, PO, packing list, and authorization files are tracked in the draft notes until document storage is connected.</p>
                  {attachmentNames.length ? <p className="text-sm text-gray-700">{attachmentNames.join(", ")}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label>Outward Remarks</Label>
                  <Textarea rows={3} {...register("outward_remarks")} placeholder="Operational notes for dispatch, picking, gate handoff, or approval context" />
                </div>
                <div className="rounded-md border bg-gray-50 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <FileText className="h-4 w-4" />
                    Audit readiness
                  </div>
                  <p className="mt-1 text-gray-600">Created by, timestamps, stock reservations, and DO status are recorded by the backend when the order is created.</p>
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SummaryLine label="Client" value={selectedClient?.client_name || "-"} />
              <SummaryLine label="Warehouse" value={selectedWarehouse?.warehouse_name || "-"} />
              <SummaryLine label="Dispatch" value={dispatchDate || "-"} />
              <SummaryLine label="Items" value={`${totals.totalLines}`} />
              <SummaryLine label="Requested" value={`${totals.requested}`} />
              <SummaryLine label="Short" value={`${totals.short}`} strongClass={totals.short ? "text-red-700" : "text-emerald-700"} />
              <div className="h-2 rounded-full bg-gray-100">
                <div className="h-2 rounded-full bg-blue-600" style={{ width: `${progress}%` }} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <CheckRow done={Boolean(selectedClientId && selectedWarehouseId)} label="Client and warehouse selected" />
              <CheckRow done={Boolean(getValues("address_line1") && getValues("city") && getValues("postal_code"))} label="Delivery address complete" />
              <CheckRow done={totals.completedLines === totals.totalLines && totals.totalLines > 0} label="Item lines complete" />
              <CheckRow done={totals.enough} label="Stock allocation available" />
              <CheckRow done={!duplicateWarning} label="No duplicate invoice warning" />
            </CardContent>
          </Card>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-white/95 px-4 py-3 shadow-lg backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-gray-600">
            {Object.keys(dirtyFields).length ? "Unsaved changes" : "No unsaved changes"} · {totals.requested} units requested
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()} disabled={createMutation.isPending}>Cancel</Button>
            <Button type="button" variant="outline" onClick={saveDraft} disabled={createMutation.isPending}>
              <Save className="h-4 w-4" />
              Save Draft
            </Button>
            <Button type="button" variant="outline" onClick={validateCurrent} disabled={createMutation.isPending}>
              <ClipboardCheck className="h-4 w-4" />
              Validate
            </Button>
            <Button
              type="submit"
              variant="outline"
              disabled={createMutation.isPending || hasInsufficientStock || inventoryAvailabilityQuery.isFetching}
              onClick={() => setSubmitIntent("approval")}
            >
              <Send className="h-4 w-4" />
              Submit for Approval
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || hasInsufficientStock || inventoryAvailabilityQuery.isFetching}
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => setSubmitIntent("create")}
            >
              {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              {createMutation.isPending ? "Creating..." : "Create DO"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

function Metric({ label, value, tone = "text-gray-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-md border bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone}`}>{value}</p>
    </div>
  )
}

function ReviewTile({ label, value, tone = "text-gray-900" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md border bg-gray-50 p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 font-medium ${tone}`}>{value}</p>
    </div>
  )
}

function SummaryLine({ label, value, strongClass = "" }: { label: string; value: string; strongClass?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-gray-500">{label}</span>
      <strong className={`text-right ${strongClass}`}>{value}</strong>
    </div>
  )
}

function CheckRow({ done, label }: { done: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <CheckCircle2 className={`h-4 w-4 ${done ? "text-emerald-600" : "text-gray-300"}`} />
      <span className={done ? "text-gray-800" : "text-gray-500"}>{label}</span>
    </div>
  )
}
