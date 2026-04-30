"use client"

import { useState } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, Loader2, Plus } from "lucide-react"

import { useFreightShipment, useAddFreightDocument, useAddFreightLeg, useAddFreightMilestone } from "@/hooks/use-freight"
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
import { Badge } from "@/components/ui/badge"
import { handleError } from "@/lib/error-handler"

type ShipmentData = {
  id: number
  shipment_no: string
  mode: string
  direction: string
  status: string
  origin: string
  destination: string
  client_name?: string | null
  shipper_name?: string | null
  consignee_name?: string | null
  incoterm?: string | null
  etd?: string | null
  eta?: string | null
  remarks?: string | null
  legs: Array<Record<string, unknown>>
  milestones: Array<Record<string, unknown>>
  documents: Array<Record<string, unknown>>
}

export default function FreightShipmentDetailPage() {
  const params = useParams<{ id: string }>()
  const id = String(params?.id || "")
  const shipmentQuery = useFreightShipment(id)
  const addLeg = useAddFreightLeg(id)
  const addMilestone = useAddFreightMilestone(id)
  const addDocument = useAddFreightDocument(id)

  const [legMode, setLegMode] = useState("AIR")
  const [milestoneStatus, setMilestoneStatus] = useState("PENDING")
  const [docType, setDocType] = useState("HAWB")

  if (shipmentQuery.isLoading) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const shipment = (shipmentQuery.data?.data as ShipmentData | undefined)
  if (!shipment) {
    return <p className="text-sm text-muted-foreground">Shipment not found.</p>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/freight">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">{shipment.shipment_no}</h1>
            <p className="text-sm text-muted-foreground">
              {shipment.mode} | {shipment.direction} | {shipment.origin} {"->"} {shipment.destination}
            </p>
          </div>
        </div>
        <Badge className="border border-slate-300 bg-slate-600 text-white">{shipment.status}</Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Shipment Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Client</p>
            <p className="font-medium">{shipment.client_name || "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Shipper</p>
            <p className="font-medium">{shipment.shipper_name || "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Consignee</p>
            <p className="font-medium">{shipment.consignee_name || "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Incoterm</p>
            <p className="font-medium">{shipment.incoterm || "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">ETD</p>
            <p className="font-medium">{shipment.etd ? new Date(shipment.etd).toLocaleString("en-IN") : "-"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">ETA</p>
            <p className="font-medium">{shipment.eta ? new Date(shipment.eta).toLocaleString("en-IN") : "-"}</p>
          </div>
          <div className="md:col-span-3">
            <p className="text-xs text-muted-foreground">Remarks</p>
            <p className="font-medium">{shipment.remarks || "-"}</p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Legs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                try {
                  await addLeg.mutateAsync({
                    transport_mode: legMode,
                    from_location: String(form.get("from_location") || ""),
                    to_location: String(form.get("to_location") || ""),
                    carrier_name: String(form.get("carrier_name") || "") || undefined,
                    vessel_or_flight: String(form.get("vessel_or_flight") || "") || undefined,
                    voyage_or_flight_no: String(form.get("voyage_or_flight_no") || "") || undefined,
                    etd: String(form.get("etd") || "")
                      ? new Date(String(form.get("etd"))).toISOString()
                      : undefined,
                    eta: String(form.get("eta") || "")
                      ? new Date(String(form.get("eta"))).toISOString()
                      : undefined,
                  })
                  event.currentTarget.reset()
                } catch (error) {
                  handleError(error, "Failed to add leg")
                }
              }}
            >
              <div className="space-y-2">
                <Label>Mode</Label>
                <Select value={legMode} onValueChange={setLegMode}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AIR">AIR</SelectItem>
                    <SelectItem value="SEA">SEA</SelectItem>
                    <SelectItem value="ROAD">ROAD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Input name="from_location" placeholder="From location" required />
              <Input name="to_location" placeholder="To location" required />
              <Input name="carrier_name" placeholder="Carrier" />
              <Input name="vessel_or_flight" placeholder="Vessel/Flight" />
              <Input name="voyage_or_flight_no" placeholder="Voyage/Flight no" />
              <Input name="etd" type="datetime-local" />
              <Input name="eta" type="datetime-local" />
              <Button type="submit" className="w-full" disabled={addLeg.isPending}>
                <Plus className="mr-2 h-4 w-4" />
                Add Leg
              </Button>
            </form>
            <div className="space-y-2">
              {shipment.legs.length === 0 && <p className="text-xs text-muted-foreground">No legs added</p>}
              {shipment.legs.map((leg) => (
                <div key={String(leg.id)} className="rounded border p-2 text-sm">
                  <p className="font-medium">Leg {String(leg.leg_no)} - {String(leg.transport_mode)}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(leg.from_location)} {"->"} {String(leg.to_location)}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                try {
                  await addMilestone.mutateAsync({
                    code: String(form.get("code") || ""),
                    status: milestoneStatus,
                    planned_at: String(form.get("planned_at") || "")
                      ? new Date(String(form.get("planned_at"))).toISOString()
                      : undefined,
                    actual_at: String(form.get("actual_at") || "")
                      ? new Date(String(form.get("actual_at"))).toISOString()
                      : undefined,
                    remarks: String(form.get("remarks") || "") || undefined,
                  })
                  event.currentTarget.reset()
                } catch (error) {
                  handleError(error, "Failed to add milestone")
                }
              }}
            >
              <Input name="code" placeholder="BOOKING_CONFIRMED" required />
              <Select value={milestoneStatus} onValueChange={setMilestoneStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PENDING">PENDING</SelectItem>
                  <SelectItem value="COMPLETED">COMPLETED</SelectItem>
                  <SelectItem value="DELAYED">DELAYED</SelectItem>
                  <SelectItem value="CANCELLED">CANCELLED</SelectItem>
                </SelectContent>
              </Select>
              <Input name="planned_at" type="datetime-local" />
              <Input name="actual_at" type="datetime-local" />
              <Textarea name="remarks" placeholder="Notes" rows={2} />
              <Button type="submit" className="w-full" disabled={addMilestone.isPending}>
                <Plus className="mr-2 h-4 w-4" />
                Add Milestone
              </Button>
            </form>
            <div className="space-y-2">
              {shipment.milestones.length === 0 && <p className="text-xs text-muted-foreground">No milestones added</p>}
              {shipment.milestones.map((milestone) => (
                <div key={String(milestone.id)} className="rounded border p-2 text-sm">
                  <p className="font-medium">{String(milestone.code)}</p>
                  <p className="text-xs text-muted-foreground">{String(milestone.status)}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Documents</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-2"
              onSubmit={async (event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                try {
                  await addDocument.mutateAsync({
                    doc_type: docType,
                    doc_no: String(form.get("doc_no") || ""),
                    issue_date: String(form.get("issue_date") || "") || undefined,
                    is_master: String(form.get("is_master") || "") === "on",
                  })
                  event.currentTarget.reset()
                } catch (error) {
                  handleError(error, "Failed to add document")
                }
              }}
            >
              <Select value={docType} onValueChange={setDocType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="HAWB">HAWB</SelectItem>
                  <SelectItem value="MAWB">MAWB</SelectItem>
                  <SelectItem value="HBL">HBL</SelectItem>
                  <SelectItem value="MBL">MBL</SelectItem>
                  <SelectItem value="INVOICE">INVOICE</SelectItem>
                  <SelectItem value="PACKING_LIST">PACKING_LIST</SelectItem>
                  <SelectItem value="COO">COO</SelectItem>
                  <SelectItem value="BOE">BOE</SelectItem>
                  <SelectItem value="OTHER">OTHER</SelectItem>
                </SelectContent>
              </Select>
              <Input name="doc_no" placeholder="Document number" required />
              <Input name="issue_date" type="date" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="is_master" />
                Master document
              </label>
              <Button type="submit" className="w-full" disabled={addDocument.isPending}>
                <Plus className="mr-2 h-4 w-4" />
                Add Document
              </Button>
            </form>
            <div className="space-y-2">
              {shipment.documents.length === 0 && <p className="text-xs text-muted-foreground">No documents added</p>}
              {shipment.documents.map((doc) => (
                <div key={String(doc.id)} className="rounded border p-2 text-sm">
                  <p className="font-medium">{String(doc.doc_type)} - {String(doc.doc_no)}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(doc.is_master) === "true" ? "Master" : "House"} document
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
