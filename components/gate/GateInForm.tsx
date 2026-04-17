"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery } from "@tanstack/react-query"
import { Camera, Loader2, Save, Truck } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { useCreateGateIn } from "@/hooks/use-gate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"

const VEHICLE_MODELS: Record<string, string[]> = {
  LCV: ["Tata Ace", "TATA 407"],
  MCV: ["Canter 14 ft", "Canter 17 ft"],
  HCV: ["20 ft Container", "32 ft", "40 ft Container", "Taurus 16 ton", "Taurus 21 ton", "Lorry 9 ton"],
}

const formSchema = z
  .object({
    warehouse_id: z.string().min(1, "Warehouse is required"),
    client_id: z.string().min(1, "Client is required"),
    vehicle_in_time: z.string().min(1, "Vehicle in time is required"),
    transporter_name: z.string().min(2, "Transporter name is required"),
    vehicle_number: z.string().min(3, "Vehicle number is required"),
    lr_number: z.string().min(1, "LR number is required"),
    lr_date: z.string().min(1, "LR date is required"),
    e_way_bill_number: z.string().optional(),
    e_way_bill_date: z.string().optional(),
    from_location: z.string().min(2, "From location is required"),
    to_location: z.string().min(2, "To location is required"),
    vehicle_type: z.enum(["LCV", "MCV", "HCV"]),
    vehicle_model: z.string().min(1, "Vehicle model is required"),
    transported_by: z.enum(["SELF", "VENDOR"]),
    vendor_name: z.string().optional(),
    transportation_remarks: z.string().optional(),
    driver_name: z.string().optional(),
    driver_phone: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transported_by === "VENDOR" && !value.vendor_name?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vendor name is required when transported by vendor",
        path: ["vendor_name"],
      })
    }
  })

type FormValues = z.infer<typeof formSchema>

type OptionEntity = {
  id: number
  client_name?: string
  warehouse_name?: string
}

export function GateInForm() {
  const router = useRouter()
  const createMutation = useCreateGateIn()
  const [photo, setPhoto] = useState<string | null>(null)

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

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      warehouse_id: "",
      client_id: "",
      vehicle_in_time: new Date().toISOString().slice(0, 16),
      transporter_name: "",
      vehicle_number: "",
      lr_number: "",
      lr_date: new Date().toISOString().slice(0, 10),
      e_way_bill_number: "",
      e_way_bill_date: "",
      from_location: "",
      to_location: "",
      vehicle_type: "LCV",
      vehicle_model: "",
      transported_by: "SELF",
      vendor_name: "",
      transportation_remarks: "",
      driver_name: "",
      driver_phone: "",
    },
  })

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = form

  const selectedWarehouse = useWatch({ control, name: "warehouse_id" })
  const selectedClient = useWatch({ control, name: "client_id" })
  const vehicleType = useWatch({ control, name: "vehicle_type" })
  const vehicleModel = useWatch({ control, name: "vehicle_model" })
  const transportedBy = useWatch({ control, name: "transported_by" })
  const vehicleModelOptions = VEHICLE_MODELS[vehicleType || "LCV"] ?? []

  const onSubmit = async (data: FormValues) => {
    try {
      await createMutation.mutateAsync({
        warehouse_id: Number(data.warehouse_id),
        client_id: Number(data.client_id),
        vehicleInTime: new Date(data.vehicle_in_time).toISOString(),
        transporterName: data.transporter_name.trim(),
        vehicleNo: data.vehicle_number.trim().toUpperCase(),
        lrNo: data.lr_number.trim(),
        lrDate: new Date(data.lr_date).toISOString(),
        eWayBillNo: data.e_way_bill_number?.trim() || undefined,
        eWayBillDate: data.e_way_bill_date ? new Date(data.e_way_bill_date).toISOString() : undefined,
        fromLocation: data.from_location.trim(),
        toLocation: data.to_location.trim(),
        vehicleType: data.vehicle_type,
        vehicleModel: data.vehicle_model,
        transportedBy: data.transported_by,
        vendorName: data.transported_by === "VENDOR" ? data.vendor_name?.trim() : undefined,
        transportationRemarks: data.transportation_remarks?.trim() || undefined,
        vehicle_number: data.vehicle_number.trim().toUpperCase(),
        driver_name: data.driver_name?.trim() || data.transporter_name.trim(),
        driver_phone: data.driver_phone?.trim() || undefined,
        photo_url: photo,
      })
      router.push("/gate/in")
    } catch (error) {
      handleError(error, "Failed to record gate in")
    }
  }

  const capturePhoto = () => {
    setPhoto(`captured-${Date.now()}.jpg`)
  }

  if (clientsQuery.isLoading || warehousesQuery.isLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5" />
            Gate In Details
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Warehouse *</Label>
            <Select value={selectedWarehouse} onValueChange={(value) => setValue("warehouse_id", value)}>
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

          <div className="space-y-2">
            <Label>Client *</Label>
            <Select value={selectedClient} onValueChange={(value) => setValue("client_id", value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select client" />
              </SelectTrigger>
              <SelectContent>
                {(clientsQuery.data ?? []).map((client) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.client_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.client_id && <p className="text-sm text-red-600">{errors.client_id.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Vehicle In Time *</Label>
            <Input type="datetime-local" {...register("vehicle_in_time")} />
            {errors.vehicle_in_time && <p className="text-sm text-red-600">{errors.vehicle_in_time.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Transporter Name *</Label>
            <Input {...register("transporter_name")} />
            {errors.transporter_name && <p className="text-sm text-red-600">{errors.transporter_name.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Vehicle Number *</Label>
            <Input {...register("vehicle_number")} className="uppercase" />
            {errors.vehicle_number && <p className="text-sm text-red-600">{errors.vehicle_number.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Transported By *</Label>
            <Select
              value={transportedBy}
              onValueChange={(value) => setValue("transported_by", value as "SELF" | "VENDOR")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SELF">Self</SelectItem>
                <SelectItem value="VENDOR">Vendor</SelectItem>
              </SelectContent>
            </Select>
            {errors.transported_by && <p className="text-sm text-red-600">{errors.transported_by.message}</p>}
          </div>

          {transportedBy === "VENDOR" && (
            <div className="space-y-2">
              <Label>Vendor Name *</Label>
              <Input {...register("vendor_name")} />
              {errors.vendor_name && <p className="text-sm text-red-600">{errors.vendor_name.message}</p>}
            </div>
          )}

          <div className="space-y-2">
            <Label>LR Number *</Label>
            <Input {...register("lr_number")} />
            {errors.lr_number && <p className="text-sm text-red-600">{errors.lr_number.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>LR Date *</Label>
            <Input type="date" {...register("lr_date")} />
            {errors.lr_date && <p className="text-sm text-red-600">{errors.lr_date.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>E-Way Bill Number</Label>
            <Input {...register("e_way_bill_number")} />
          </div>

          <div className="space-y-2">
            <Label>E-Way Bill Date</Label>
            <Input type="date" {...register("e_way_bill_date")} />
          </div>

          <div className="space-y-2">
            <Label>From Location *</Label>
            <Input {...register("from_location")} />
            {errors.from_location && <p className="text-sm text-red-600">{errors.from_location.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>To Location *</Label>
            <Input {...register("to_location")} />
            {errors.to_location && <p className="text-sm text-red-600">{errors.to_location.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Vehicle Type *</Label>
            <Select
              value={vehicleType}
              onValueChange={(value) => {
                setValue("vehicle_type", value as "LCV" | "MCV" | "HCV")
                setValue("vehicle_model", "")
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="LCV">LCV</SelectItem>
                <SelectItem value="MCV">MCV</SelectItem>
                <SelectItem value="HCV">HCV</SelectItem>
              </SelectContent>
            </Select>
            {errors.vehicle_type && <p className="text-sm text-red-600">{errors.vehicle_type.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Vehicle Model *</Label>
            <Select value={vehicleModel} onValueChange={(value) => setValue("vehicle_model", value)}>
              <SelectTrigger>
                <SelectValue placeholder="Select vehicle model" />
              </SelectTrigger>
              <SelectContent>
                {vehicleModelOptions.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.vehicle_model && <p className="text-sm text-red-600">{errors.vehicle_model.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Driver Name</Label>
            <Input {...register("driver_name")} />
          </div>

          <div className="space-y-2">
            <Label>Driver Phone</Label>
            <Input {...register("driver_phone")} />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>Transportation Remarks</Label>
            <Textarea rows={3} {...register("transportation_remarks")} />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label>Vehicle Photo</Label>
            <Button type="button" onClick={capturePhoto} variant="outline" className="w-full">
              <Camera className="mr-2 h-4 w-4" />
              {photo ? "Retake Photo" : "Capture Photo"}
            </Button>
            {photo && (
              <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">
                Photo captured successfully
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-4">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={createMutation.isPending} className="bg-green-600 hover:bg-green-700">
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Recording...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Record Gate In
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
