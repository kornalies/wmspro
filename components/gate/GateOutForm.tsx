"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { CheckCircle, Loader2, Save, TruckIcon } from "lucide-react"
import { useQuery } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { handleError } from "@/lib/error-handler"
import { useCreateGateOut } from "@/hooks/use-gate"
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

const formSchema = z.object({
  warehouse_id: z.string().min(1, "Warehouse is required"),
  do_number: z.string().min(1, "DO number is required"),
  vehicle_number: z.string().min(3, "Vehicle number is required"),
  driver_name: z.string().min(2, "Driver name is required"),
  driver_phone: z.string().optional(),
})

type FormValues = z.infer<typeof formSchema>

type DOItem = { do_number: string }
type Warehouse = { id: number; warehouse_name: string }

export function GateOutForm() {
  const router = useRouter()
  const createMutation = useCreateGateOut()
  const [verified, setVerified] = useState(false)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      warehouse_id: "",
      do_number: "",
      vehicle_number: "",
      driver_name: "",
      driver_phone: "",
    },
  })
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    formState: { errors },
  } = form
  const selectedWarehouse = useWatch({ control, name: "warehouse_id" })

  const warehousesQuery = useQuery({
    queryKey: ["warehouses", "active"],
    queryFn: async () => {
      const res = await apiClient.get<Warehouse[]>("/warehouses?is_active=true")
      return res.data ?? []
    },
  })
  const doQuery = useQuery({
    queryKey: ["dos", "options"],
    queryFn: async () => {
      const res = await apiClient.get<DOItem[]>("/do")
      return (res.data ?? []).slice(0, 200)
    },
  })

  const verifyDO = () => {
    const value = getValues("do_number")
    const found = (doQuery.data ?? []).some((item) => item.do_number === value)
    setVerified(found)
  }

  const onSubmit = async (data: FormValues) => {
    try {
      await createMutation.mutateAsync({
        warehouse_id: Number(data.warehouse_id),
        do_number: data.do_number,
        vehicle_number: data.vehicle_number,
        driver_name: data.driver_name,
        driver_phone: data.driver_phone,
      })
      router.push("/gate/out")
    } catch (error) {
      handleError(error, "Failed to record gate out")
    }
  }

  if (warehousesQuery.isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TruckIcon className="h-5 w-5" />
            Gate Out Details
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <Label>DO Number *</Label>
            <div className="flex gap-2">
              <Input {...register("do_number")} className="flex-1 font-mono" />
              <Button type="button" onClick={verifyDO} variant="outline">
                Verify
              </Button>
            </div>
            {errors.do_number && <p className="text-sm text-red-600">{errors.do_number.message}</p>}
            {verified && (
              <div className="flex items-center gap-2 rounded border border-green-200 bg-green-50 p-3 dark:border-green-900/60 dark:bg-green-950/30">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm text-green-800 dark:text-green-200">DO verified and ready for dispatch</span>
              </div>
            )}
          </div>

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
            {errors.warehouse_id && (
              <p className="text-sm text-red-600">{errors.warehouse_id.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Vehicle Number *</Label>
            <Input {...register("vehicle_number")} className="uppercase" />
            {errors.vehicle_number && (
              <p className="text-sm text-red-600">{errors.vehicle_number.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Driver Name *</Label>
            <Input {...register("driver_name")} />
            {errors.driver_name && <p className="text-sm text-red-600">{errors.driver_name.message}</p>}
          </div>

          <div className="space-y-2">
            <Label>Driver Phone</Label>
            <Input {...register("driver_phone")} />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-4">
        <Button type="button" variant="outline" onClick={() => router.back()} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={createMutation.isPending || !verified} className="bg-blue-600 hover:bg-blue-700">
          {createMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Recording...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              Record Gate Out
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
