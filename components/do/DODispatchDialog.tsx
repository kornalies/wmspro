'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { DOStatus } from '@/lib/do-status'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    Package,
    CheckCircle2,
    AlertCircle,
    Truck,
    User,
    Phone,
    Calendar,
    Clock
} from 'lucide-react'

interface DOItem {
    id: number
    item_id: number
    item_name: string
    item_code: string
    quantity_requested: number
    quantity_dispatched: number
    quantity_remaining: number
    unit: string
}

export interface DeliveryOrder {
    id: number
    do_number: string
    client_name: string
    warehouse_name: string
    request_date: string
    status: DOStatus
    items: DOItem[]
}

interface DispatchData {
    vehicle_number: string
    driver_name: string
    driver_phone: string
    seal_number: string
    dispatch_date: string
    dispatch_time: string
    remarks: string
    items: {
        item_id: number
        quantity: number
    }[]
}

export function DODispatchDialog({
    deliveryOrder,
    isOpen,
    onClose,
    onDispatch
}: {
    deliveryOrder: DeliveryOrder | null
    isOpen: boolean
    onClose: () => void
    onDispatch: (data: DispatchData) => void
}) {
    const createInitialDispatchData = (order: DeliveryOrder | null): DispatchData => ({
        vehicle_number: '',
        driver_name: '',
        driver_phone: '',
        seal_number: '',
        dispatch_date: new Date().toISOString().split('T')[0],
        dispatch_time: new Date().toTimeString().slice(0, 5),
        remarks: '',
        items: order?.items.map(item => ({
            item_id: item.item_id,
            quantity: item.quantity_remaining
        })) || []
    })

    const createInitialItemQuantities = (order: DeliveryOrder | null): Record<number, number> =>
        order?.items.reduce((acc, item) => ({
            ...acc,
            [item.id]: item.quantity_remaining
        }), {}) || {}

    const [dispatchData, setDispatchData] = useState<DispatchData>({
        ...createInitialDispatchData(deliveryOrder)
    })

    const [itemQuantities, setItemQuantities] = useState<Record<number, number>>(
        createInitialItemQuantities(deliveryOrder)
    )

    if (!deliveryOrder) return null

    const handleQuantityChange = (itemId: number, value: string) => {
        const quantity = Math.max(0, parseInt(value) || 0)
        setItemQuantities(prev => ({
            ...prev,
            [itemId]: quantity
        }))
    }

    const handleDispatch = () => {
        if (!isValidDispatch) return

        const finalDispatchData: DispatchData = {
            ...dispatchData,
            items: deliveryOrder.items.map((item) => ({
                item_id: item.item_id,
                quantity: itemQuantities[item.id] || 0,
            }))
        }
        onDispatch(finalDispatchData)
    }

    const totalRequestedQty = deliveryOrder.items.reduce((sum, item) => sum + item.quantity_requested, 0)
    const totalRemainingQty = deliveryOrder.items.reduce((sum, item) => sum + item.quantity_remaining, 0)
    const totalDispatchingQty = Object.values(itemQuantities).reduce((sum, qty) => sum + qty, 0)
    const hasOverDispatch = deliveryOrder.items.some((item) => (itemQuantities[item.id] || 0) > item.quantity_remaining)
    const isPartialDispatch = totalDispatchingQty < totalRemainingQty
    const isValidDispatch = totalDispatchingQty > 0 &&
        !hasOverDispatch &&
        dispatchData.vehicle_number &&
        dispatchData.driver_name &&
        dispatchData.driver_phone

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Package className="h-5 w-5 text-blue-600" />
                        Dispatch Delivery Order
                    </DialogTitle>
                    <DialogDescription>
                        {deliveryOrder.do_number} - {deliveryOrder.client_name}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Dispatch Type Banner */}
                    {isPartialDispatch && totalDispatchingQty > 0 && (
                        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 flex items-start gap-2">
                            <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                            <div>
                                <p className="font-medium text-yellow-900 text-sm">Partial Dispatch</p>
                                <p className="text-yellow-700 text-xs">
                                    Dispatching {totalDispatchingQty} of {totalRemainingQty} remaining items.
                                    This DO will remain open for further dispatch.
                                </p>
                            </div>
                        </div>
                    )}
                    {hasOverDispatch && (
                        <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                            <AlertCircle className="h-5 w-5 text-red-600 mt-0.5" />
                            <div>
                                <p className="font-medium text-red-900 text-sm">Invalid Dispatch Quantity</p>
                                <p className="text-red-700 text-xs">
                                    One or more items exceed remaining quantity. Reduce quantities to continue.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Items Table */}
                    <div>
                        <h3 className="font-semibold mb-3">Dispatch Items</h3>
                        <div className="border rounded-lg">
                            <Table>
                                <TableHeader>
                                    <TableRow className="bg-gray-50">
                                        <TableHead>Item</TableHead>
                                        <TableHead className="text-right">Requested</TableHead>
                                        <TableHead className="text-right">Already Dispatched</TableHead>
                                        <TableHead className="text-right">Remaining</TableHead>
                                        <TableHead className="text-right">Dispatch Now</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {deliveryOrder.items.map((item) => {
                                        const maxDispatch = item.quantity_remaining
                                        const currentDispatch = itemQuantities[item.id] || 0
                                        const isOverLimit = currentDispatch > maxDispatch

                                        return (
                                            <TableRow key={item.id}>
                                                <TableCell>
                                                    <div>
                                                        <div className="font-medium">{item.item_name}</div>
                                                        <div className="text-xs text-gray-500">{item.item_code}</div>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    {item.quantity_requested} {item.unit}
                                                </TableCell>
                                                <TableCell className="text-right text-gray-600">
                                                    {item.quantity_dispatched} {item.unit}
                                                </TableCell>
                                                <TableCell className="text-right font-medium">
                                                    {item.quantity_remaining} {item.unit}
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <Input
                                                            type="number"
                                                            min="0"
                                                            max={maxDispatch}
                                                            value={itemQuantities[item.id] || ''}
                                                            onChange={(e) => handleQuantityChange(item.id, e.target.value)}
                                                            className={`w-24 text-right ${isOverLimit ? 'border-red-500' : ''}`}
                                                        />
                                                        <span className="text-sm text-gray-500 w-12">{item.unit}</span>
                                                    </div>
                                                    {isOverLimit && (
                                                        <p className="text-xs text-red-600 mt-1">
                                                            Cannot exceed {maxDispatch} {item.unit}
                                                        </p>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        </div>
                    </div>

                    {/* Vehicle & Driver Details */}
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <Label htmlFor="vehicle_number" className="flex items-center gap-1">
                                <Truck className="h-4 w-4" />
                                Vehicle Number *
                            </Label>
                            <Input
                                id="vehicle_number"
                                value={dispatchData.vehicle_number}
                                onChange={(e) => setDispatchData({ ...dispatchData, vehicle_number: e.target.value })}
                                className="uppercase"
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="seal_number">Seal Number</Label>
                            <Input
                                id="seal_number"
                                value={dispatchData.seal_number}
                                onChange={(e) => setDispatchData({ ...dispatchData, seal_number: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="driver_name" className="flex items-center gap-1">
                                <User className="h-4 w-4" />
                                Driver Name *
                            </Label>
                            <Input
                                id="driver_name"
                                value={dispatchData.driver_name}
                                onChange={(e) => setDispatchData({ ...dispatchData, driver_name: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="driver_phone" className="flex items-center gap-1">
                                <Phone className="h-4 w-4" />
                                Driver Phone *
                            </Label>
                            <Input
                                id="driver_phone"
                                value={dispatchData.driver_phone}
                                onChange={(e) => setDispatchData({ ...dispatchData, driver_phone: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="dispatch_date" className="flex items-center gap-1">
                                <Calendar className="h-4 w-4" />
                                Dispatch Date *
                            </Label>
                            <Input
                                id="dispatch_date"
                                type="date"
                                value={dispatchData.dispatch_date}
                                onChange={(e) => setDispatchData({ ...dispatchData, dispatch_date: e.target.value })}
                            />
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="dispatch_time" className="flex items-center gap-1">
                                <Clock className="h-4 w-4" />
                                Dispatch Time *
                            </Label>
                            <Input
                                id="dispatch_time"
                                type="time"
                                value={dispatchData.dispatch_time}
                                onChange={(e) => setDispatchData({ ...dispatchData, dispatch_time: e.target.value })}
                            />
                        </div>
                    </div>

                    {/* Remarks */}
                    <div className="space-y-2">
                        <Label htmlFor="remarks">Remarks</Label>
                        <Textarea
                            id="remarks"
                            value={dispatchData.remarks}
                            onChange={(e) => setDispatchData({ ...dispatchData, remarks: e.target.value })}
                            rows={3}
                        />
                    </div>

                    {/* Summary */}
                    <div className="bg-gray-50 rounded-lg p-4 grid grid-cols-3 gap-4">
                        <div>
                            <p className="text-xs text-gray-600">Total Requested</p>
                            <p className="text-lg font-bold">{totalRequestedQty}</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-600">Dispatching Now</p>
                            <p className="text-lg font-bold text-blue-600">{totalDispatchingQty}</p>
                        </div>
                        <div>
                            <p className="text-xs text-gray-600">Will Remain</p>
                            <p className="text-lg font-bold text-orange-600">
                                {totalRemainingQty - totalDispatchingQty}
                            </p>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button
                        onClick={handleDispatch}
                        disabled={!isValidDispatch}
                        className="bg-blue-600 hover:bg-blue-700"
                    >
                        <CheckCircle2 className="h-4 w-4 mr-2" />
                        {isPartialDispatch ? 'Dispatch Partial' : 'Complete Dispatch'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
