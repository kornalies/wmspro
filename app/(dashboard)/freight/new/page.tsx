import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { FreightShipmentForm } from "@/components/freight/FreightShipmentForm"
import { Button } from "@/components/ui/button"

export default function NewFreightShipmentPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/freight">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Freight
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold">New Freight Shipment</h1>
          <p className="text-muted-foreground">Create an AIR / SEA / ROAD forwarding shipment</p>
        </div>
      </div>
      <FreightShipmentForm />
    </div>
  )
}
