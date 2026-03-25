"use client"

import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"

import { apiClient } from "@/lib/api-client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type FifoStock = {
  stock_id: number
  serial_number: string
  received_date: string
  age_days: number
  bin_location: string
  stock_status: "IN_STOCK" | "RESERVED"
}

type FifoLine = {
  line_item_id: number
  item_id: number
  item_name: string
  item_code: string
  quantity_requested: number
  quantity_dispatched: number
  quantity_remaining: number
  fifo_stock: FifoStock[]
}

type FifoResponse = {
  do_id: number
  do_number: string
  lines: FifoLine[]
}

export default function FIFOPicker({ doId }: { doId: number | string }) {
  const PAGE_SIZE = 10
  const [selectedLineId, setSelectedLineId] = useState<string>("")
  const [stockPage, setStockPage] = useState(1)
  const doRef = String(doId).trim()

  const fifoQuery = useQuery({
    queryKey: ["do", doRef, "fifo"],
    enabled: doRef.length > 0,
    queryFn: async () => {
      const res = await apiClient.get<FifoResponse>(`/do/${encodeURIComponent(doRef)}/fifo`)
      return res.data ?? { do_id: 0, do_number: doRef, lines: [] }
    },
  })

  const lines = useMemo(() => fifoQuery.data?.lines ?? [], [fifoQuery.data?.lines])
  const effectiveSelectedLineId = selectedLineId || (lines[0] ? String(lines[0].line_item_id) : "")

  const selectedLine = useMemo(
    () => lines.find((line) => String(line.line_item_id) === effectiveSelectedLineId) ?? null,
    [effectiveSelectedLineId, lines]
  )
  const totalStockPages = useMemo(() => {
    if (!selectedLine) return 1
    return Math.max(1, Math.ceil(selectedLine.fifo_stock.length / PAGE_SIZE))
  }, [selectedLine])
  const effectiveStockPage = Math.min(stockPage, totalStockPages)
  const pagedStock = useMemo(() => {
    if (!selectedLine) return []
    const start = (effectiveStockPage - 1) * PAGE_SIZE
    return selectedLine.fifo_stock.slice(start, start + PAGE_SIZE)
  }, [effectiveStockPage, selectedLine])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Available Inventory (FIFO Order)</CardTitle>
      </CardHeader>
      <CardContent>
        {fifoQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : fifoQuery.isError ? (
          <p className="text-sm text-red-600">Unable to load FIFO inventory for this delivery order.</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-gray-500">No delivery order lines found.</p>
        ) : (
          <div className="space-y-4">
            <div className="max-w-md space-y-2">
              <p className="text-sm text-gray-600">DO Item</p>
              <Select
                value={effectiveSelectedLineId}
                onValueChange={(value) => {
                  setSelectedLineId(value)
                  setStockPage(1)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select item" />
                </SelectTrigger>
                <SelectContent>
                  {lines.map((line) => (
                    <SelectItem key={line.line_item_id} value={String(line.line_item_id)}>
                      {line.item_code} - {line.item_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selectedLine && (
              <div className="rounded-lg border p-4">
                <div className="mb-3 flex items-center gap-2 text-sm text-gray-700">
                  <span>Remaining for selected DO line:</span>
                  <span className="inline-flex min-w-12 items-center justify-center rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-semibold text-blue-700">
                    {selectedLine.quantity_remaining}
                  </span>
                </div>
                {selectedLine.fifo_stock.length === 0 ? (
                  <p className="text-sm text-gray-500">No in-stock inventory available for this item.</p>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-md border bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      Showing {(stockPage - 1) * PAGE_SIZE + 1}-
                      {Math.min(effectiveStockPage * PAGE_SIZE, selectedLine.fifo_stock.length)} of{" "}
                      {selectedLine.fifo_stock.length} rows
                    </div>
                    <div className="space-y-2">
                    {pagedStock.map((stock) => (
                      <div key={stock.stock_id} className="flex items-center justify-between rounded border px-3 py-2">
                        <div>
                          <p className="font-mono text-sm">{stock.serial_number}</p>
                          <p className="text-xs text-gray-500">Bin: {stock.bin_location}</p>
                        </div>
                        <div className="text-right text-xs text-gray-500">
                          <p>{stock.stock_status === "RESERVED" ? "Reserved for this DO" : "Available in stock"}</p>
                          <p>Received: {stock.received_date}</p>
                          <p>Age: {stock.age_days} day(s)</p>
                        </div>
                      </div>
                    ))}
                    </div>
                    {totalStockPages > 1 && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => setStockPage((prev) => Math.max(1, prev - 1))}
                          disabled={effectiveStockPage === 1}
                        >
                          Previous
                        </button>
                        <span className="text-xs text-gray-600">
                          Page {effectiveStockPage} of {totalStockPages}
                        </span>
                        <button
                          type="button"
                          className="rounded-md border px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                          onClick={() => setStockPage((prev) => Math.min(totalStockPages, prev + 1))}
                          disabled={effectiveStockPage === totalStockPages}
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
