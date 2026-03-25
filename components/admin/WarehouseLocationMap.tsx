"use client"

import { useMemo, useState } from "react"
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet"
import type { LatLngExpression } from "leaflet"

import { Button } from "@/components/ui/button"

type WarehouseMapRow = {
  id: number
  warehouse_name: string
  warehouse_code: string
  city?: string
  state?: string
  latitude?: number | null
  longitude?: number | null
}

type WarehouseLocationMapProps = {
  warehouses: WarehouseMapRow[]
  onSelectWarehouse: (warehouseId: number) => void
}

const CITY_COORDINATES: Record<string, [number, number]> = {
  chennai: [13.0827, 80.2707],
  mumbai: [19.076, 72.8777],
  bangalore: [12.9716, 77.5946],
  bengaluru: [12.9716, 77.5946],
  hyderabad: [17.385, 78.4867],
  delhi: [28.6139, 77.209],
  kolkata: [22.5726, 88.3639],
  pune: [18.5204, 73.8567],
  ahmedabad: [23.0225, 72.5714],
  kochi: [9.9312, 76.2673],
}

const TILE_PROVIDERS = [
  {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
  },
]

function normalizeText(value?: string) {
  return (value || "").trim().toLowerCase()
}

function resolveCoordinates(warehouse: WarehouseMapRow): [number, number] | null {
  if (
    typeof warehouse.latitude === "number" &&
    typeof warehouse.longitude === "number" &&
    Number.isFinite(warehouse.latitude) &&
    Number.isFinite(warehouse.longitude)
  ) {
    return [warehouse.latitude, warehouse.longitude]
  }

  const cityKey = normalizeText(warehouse.city)
  if (cityKey && CITY_COORDINATES[cityKey]) return CITY_COORDINATES[cityKey]
  return null
}

function FitToMarkers({ points }: { points: Array<[number, number]> }) {
  const map = useMap()
  if (points.length > 0) {
    map.fitBounds(points, { padding: [25, 25] })
  }
  return null
}

export default function WarehouseLocationMap({
  warehouses,
  onSelectWarehouse,
}: WarehouseLocationMapProps) {
  const [tileIndex, setTileIndex] = useState(0)
  const activeTile = TILE_PROVIDERS[Math.min(tileIndex, TILE_PROVIDERS.length - 1)]
  const tilesFailed = tileIndex >= TILE_PROVIDERS.length
  const markers = useMemo(
    () =>
      warehouses
        .map((warehouse) => {
          const coordinates = resolveCoordinates(warehouse)
          if (!coordinates) return null
          return { warehouse, coordinates }
        })
        .filter(
          (
            value
          ): value is { warehouse: WarehouseMapRow; coordinates: [number, number] } =>
            value !== null
        ),
    [warehouses]
  )

  const points = markers.map((marker) => marker.coordinates)
  const defaultCenter: LatLngExpression = points[0] || [22.9734, 78.6569]

  if (markers.length === 0) {
    return (
      <div className="rounded-md border bg-gray-50 p-4 text-sm text-gray-600">
        No warehouses have mappable coordinates yet. Add latitude/longitude in warehouse details.
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <MapContainer
        center={defaultCenter}
        zoom={5}
        className="h-[420px] w-full"
        scrollWheelZoom={true}
      >
        <TileLayer
          attribution={activeTile.attribution}
          url={activeTile.url}
          eventHandlers={{
            tileerror: () => {
              setTileIndex((current) => {
                if (current < TILE_PROVIDERS.length) return current + 1
                return current
              })
            },
          }}
        />
        <FitToMarkers points={points} />
        {markers.map(({ warehouse, coordinates }) => (
          <CircleMarker
            key={warehouse.id}
            center={coordinates}
            radius={9}
            pathOptions={{ color: "#1d4ed8", fillColor: "#2563eb", fillOpacity: 0.8 }}
          >
            <Popup>
              <div className="space-y-2">
                <div>
                  <p className="text-sm font-semibold">{warehouse.warehouse_name}</p>
                  <p className="text-xs text-gray-500">{warehouse.warehouse_code}</p>
                  <p className="text-xs text-gray-500">
                    {[warehouse.city, warehouse.state].filter(Boolean).join(", ") || "Location not set"}
                  </p>
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => onSelectWarehouse(warehouse.id)}
                >
                  Open Details
                </Button>
              </div>
            </Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      {tilesFailed ? (
        <div className="border-t bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
          Base map tiles could not be loaded from external providers. Markers still work; check network/firewall or VPN.
        </div>
      ) : null}
    </div>
  )
}
