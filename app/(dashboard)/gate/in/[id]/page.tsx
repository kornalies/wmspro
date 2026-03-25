"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Loader2 } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { formatDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

type GateInDetails = {
  id: number
  gate_in_number: string
  gate_in_datetime: string
  arrival_datetime?: string
  vehicle_number: string
  driver_name: string
  driver_phone?: string
  status: string
  client_name: string
  warehouse_name: string
}

export default function GateInDetailsPage() {
  const params = useParams<{ id: string }>()

  const detailsQuery = useQuery({
    queryKey: ["gate", "in", params.id],
    enabled: !!params.id,
    queryFn: async () => {
      const res = await apiClient.get<GateInDetails>(`/gate/in/${params.id}`)
      return res.data
    },
  })

  if (detailsQuery.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (detailsQuery.isError || !detailsQuery.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Gate In Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-red-600">Unable to load gate-in details.</p>
          <Button asChild variant="outline">
            <Link href="/gate/in">Back to Gate In</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const details = detailsQuery.data

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href="/gate/in">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">{details.gate_in_number}</h1>
        <Badge>{details.status}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Gate In Information</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <p className="text-sm">
            <span className="font-medium">Gate In Date:</span> {formatDate(details.gate_in_datetime)}
          </p>
          <p className="text-sm">
            <span className="font-medium">Arrival Date:</span>{" "}
            {details.arrival_datetime ? formatDate(details.arrival_datetime) : "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Vehicle Number:</span> {details.vehicle_number}
          </p>
          <p className="text-sm">
            <span className="font-medium">Driver Name:</span> {details.driver_name}
          </p>
          <p className="text-sm">
            <span className="font-medium">Driver Phone:</span> {details.driver_phone || "-"}
          </p>
          <p className="text-sm">
            <span className="font-medium">Client:</span> {details.client_name}
          </p>
          <p className="text-sm">
            <span className="font-medium">Warehouse:</span> {details.warehouse_name}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
