"use client"

import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Loader2, Save } from "lucide-react"

import { useAdminResource } from "@/hooks/use-admin"
import { useCreateFreightShipment } from "@/hooks/use-freight"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { handleError } from "@/lib/error-handler"

const formSchema = z.object({
  mode: z.enum(["AIR", "SEA", "ROAD"]),
  direction: z.enum(["IMPORT", "EXPORT", "DOMESTIC"]),
  client_id: z.string().optional(),
  shipper_name: z.string().optional(),
  consignee_name: z.string().optional(),
  incoterm: z.string().optional(),
  origin: z.string().min(2),
  destination: z.string().min(2),
  etd: z.string().optional(),
  eta: z.string().optional(),
  remarks: z.string().optional(),
})

type FormValues = z.infer<typeof formSchema>

export function FreightShipmentForm() {
  const router = useRouter()
  const createMutation = useCreateFreightShipment()
  const clientsQuery = useAdminResource("clients")

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      mode: "AIR",
      direction: "EXPORT",
      client_id: "",
      shipper_name: "",
      consignee_name: "",
      incoterm: "",
      origin: "",
      destination: "",
      etd: "",
      eta: "",
      remarks: "",
    },
  })

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = form
  const selectedMode = useWatch({ control, name: "mode" })
  const selectedDirection = useWatch({ control, name: "direction" })
  const selectedClient = useWatch({ control, name: "client_id" })

  const onSubmit = async (values: FormValues) => {
    try {
      const created = await createMutation.mutateAsync({
        mode: values.mode,
        direction: values.direction,
        client_id: values.client_id ? Number(values.client_id) : undefined,
        shipper_name: values.shipper_name?.trim() || undefined,
        consignee_name: values.consignee_name?.trim() || undefined,
        incoterm: values.incoterm?.trim().toUpperCase() || undefined,
        origin: values.origin.trim(),
        destination: values.destination.trim(),
        etd: values.etd ? new Date(values.etd).toISOString() : undefined,
        eta: values.eta ? new Date(values.eta).toISOString() : undefined,
        remarks: values.remarks?.trim() || undefined,
      })
      const createdId = Number((created?.data as { id?: number } | undefined)?.id || 0)
      if (createdId > 0) {
        router.push(`/freight/${createdId}`)
      } else {
        router.push("/freight")
      }
    } catch (error) {
      handleError(error, "Failed to create shipment")
    }
  }

  if (clientsQuery.isLoading) {
    return (
      <div className="flex min-h-[280px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const clients = ((clientsQuery.data as Array<{ id: number; client_name?: string }> | undefined) ?? [])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create Freight Shipment</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={handleSubmit(onSubmit)}>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select value={selectedMode} onValueChange={(v) => setValue("mode", v as FormValues["mode"])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AIR">AIR</SelectItem>
                  <SelectItem value="SEA">SEA</SelectItem>
                  <SelectItem value="ROAD">ROAD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Direction</Label>
              <Select
                value={selectedDirection}
                onValueChange={(v) => setValue("direction", v as FormValues["direction"])}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IMPORT">IMPORT</SelectItem>
                  <SelectItem value="EXPORT">EXPORT</SelectItem>
                  <SelectItem value="DOMESTIC">DOMESTIC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Client</Label>
              <Select value={selectedClient || "none"} onValueChange={(v) => setValue("client_id", v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select client" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {clients.map((client) => (
                    <SelectItem key={client.id} value={String(client.id)}>
                      {client.client_name || `Client ${client.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Origin</Label>
              <Input placeholder="Chennai, IN" {...register("origin")} />
              {errors.origin && <p className="text-xs text-red-600">{errors.origin.message}</p>}
            </div>
            <div className="space-y-2">
              <Label>Destination</Label>
              <Input placeholder="Dubai, AE" {...register("destination")} />
              {errors.destination && <p className="text-xs text-red-600">{errors.destination.message}</p>}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2">
              <Label>Shipper</Label>
              <Input placeholder="Shipper name" {...register("shipper_name")} />
            </div>
            <div className="space-y-2">
              <Label>Consignee</Label>
              <Input placeholder="Consignee name" {...register("consignee_name")} />
            </div>
            <div className="space-y-2">
              <Label>Incoterm</Label>
              <Input placeholder="FOB / CIF / EXW" {...register("incoterm")} />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>ETD</Label>
              <Input type="datetime-local" {...register("etd")} />
            </div>
            <div className="space-y-2">
              <Label>ETA</Label>
              <Input type="datetime-local" {...register("eta")} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Remarks</Label>
            <Textarea rows={4} placeholder="Internal notes" {...register("remarks")} />
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Create Shipment
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
