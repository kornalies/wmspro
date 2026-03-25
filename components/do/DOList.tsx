'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TypeaheadInput } from '@/components/ui/typeahead-input'
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table'
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select'
import { Search, Plus, Eye, Package } from 'lucide-react'
import { DO_STATUS_LABELS, type DOStatus } from '@/lib/do-status'

export function DOList() {
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState('all')

    // Mock data
    const deliveryOrders = [
        {
            id: 1,
            do_number: 'DO-CHN-2026-0001',
            request_date: '2026-02-15',
            client_name: 'ABC Corporation',
            warehouse_name: 'Chennai Warehouse',
            total_items: 3,
            total_quantity_requested: 150,
            total_quantity_dispatched: 150,
            status: 'COMPLETED',
        },
        {
            id: 2,
            do_number: 'DO-CHN-2026-0002',
            request_date: '2026-02-16',
            client_name: 'XYZ Industries',
            warehouse_name: 'Chennai Warehouse',
            total_items: 5,
            total_quantity_requested: 200,
            total_quantity_dispatched: 120,
            status: 'PARTIALLY_FULFILLED',
        },
        {
            id: 3,
            do_number: 'DO-CHN-2026-0003',
            request_date: '2026-02-17',
            client_name: 'Global Trading',
            warehouse_name: 'Mumbai Warehouse',
            total_items: 2,
            total_quantity_requested: 80,
            total_quantity_dispatched: 0,
            status: 'PENDING',
        },
    ] as Array<{
        id: number
        do_number: string
        request_date: string
        client_name: string
        warehouse_name: string
        total_items: number
        total_quantity_requested: number
        total_quantity_dispatched: number
        status: DOStatus
    }>

    const getStatusBadge = (status: DOStatus) => {
        const variants: Record<string, { variant: "default" | "secondary" | "outline" | "destructive", color: string }> = {
            COMPLETED: { variant: 'default', color: 'bg-green-100 text-green-800' },
            PARTIALLY_FULFILLED: { variant: 'secondary', color: 'bg-yellow-100 text-yellow-800' },
            PENDING: { variant: 'outline', color: 'bg-blue-100 text-blue-800' },
            CANCELLED: { variant: 'destructive', color: 'bg-red-100 text-red-800' },
        }

        const config = variants[status] || variants.PENDING

        return (
            <Badge className={config.color}>
                {DO_STATUS_LABELS[status]}
            </Badge>
        )
    }
    const searchSuggestions = useMemo(
        () => deliveryOrders.flatMap((row) => [row.do_number, row.client_name]),
        [deliveryOrders]
    )

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Delivery Orders</h1>
                    <p className="text-gray-500 mt-1">Manage outbound deliveries</p>
                </div>
                <Link href="/do/new">
                    <Button className="bg-blue-600 hover:bg-blue-700">
                        <Plus className="h-4 w-4 mr-2" />
                        Create DO
                    </Button>
                </Link>
            </div>

            {/* Filters */}
            <div className="flex gap-4">
                <div className="flex-1 flex gap-2">
                    <TypeaheadInput
                        value={search}
                        onValueChange={setSearch}
                        suggestions={searchSuggestions}
                        className="max-w-md"
                    />
                    <Button variant="secondary">
                        <Search className="h-4 w-4" />
                    </Button>
                </div>

                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-[200px]">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="PENDING">Pending</SelectItem>
                        <SelectItem value="PARTIALLY_FULFILLED">Partial</SelectItem>
                        <SelectItem value="COMPLETED">Completed</SelectItem>
                        <SelectItem value="CANCELLED">Cancelled</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Table */}
            <div className="border rounded-lg bg-white shadow">
                <Table>
                    <TableHeader>
                        <TableRow className="bg-gray-50">
                            <TableHead>DO Number</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Client</TableHead>
                            <TableHead>Warehouse</TableHead>
                            <TableHead className="text-right">Items</TableHead>
                            <TableHead className="text-right">Requested</TableHead>
                            <TableHead className="text-right">Dispatched</TableHead>
                            <TableHead className="text-center">Progress</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {deliveryOrders.map((do_item) => (
                            <TableRow key={do_item.id} className="hover:bg-gray-50">
                                {(() => {
                                    const fulfillmentPercentage = do_item.total_quantity_requested > 0
                                        ? Math.min(100, Math.round((do_item.total_quantity_dispatched / do_item.total_quantity_requested) * 100))
                                        : 0
                                    return (
                                        <>
                                <TableCell className="font-medium font-mono">
                                    {do_item.do_number}
                                </TableCell>
                                <TableCell>{do_item.request_date}</TableCell>
                                <TableCell>{do_item.client_name}</TableCell>
                                <TableCell>{do_item.warehouse_name}</TableCell>
                                <TableCell className="text-right">{do_item.total_items}</TableCell>
                                <TableCell className="text-right">{do_item.total_quantity_requested}</TableCell>
                                <TableCell className="text-right">{do_item.total_quantity_dispatched}</TableCell>
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 bg-gray-200 rounded-full h-2">
                                            <div
                                                className={`h-2 rounded-full ${fulfillmentPercentage === 100
                                                    ? 'bg-green-600'
                                                    : fulfillmentPercentage > 0
                                                        ? 'bg-yellow-600'
                                                        : 'bg-blue-600'
                                                    }`}
                                                style={{ width: `${fulfillmentPercentage}%` }}
                                            />
                                        </div>
                                        <span className="text-xs text-gray-600 w-12">
                                            {fulfillmentPercentage}%
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell>{getStatusBadge(do_item.status)}</TableCell>
                                <TableCell className="text-right">
                                    <div className="flex gap-2 justify-end">
                                        <Button variant="ghost" size="sm">
                                            <Eye className="h-4 w-4" />
                                        </Button>
                                        {do_item.status !== 'COMPLETED' && (
                                            <Button variant="ghost" size="sm" className="text-blue-600">
                                                <Package className="h-4 w-4" />
                                            </Button>
                                        )}
                                    </div>
                                </TableCell>
                                        </>
                                    )
                                })()}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-4 gap-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <p className="text-sm text-blue-600 font-medium">Total DOs</p>
                    <p className="text-2xl font-bold text-blue-900">3</p>
                </div>
                <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <p className="text-sm text-yellow-600 font-medium">Pending</p>
                    <p className="text-2xl font-bold text-yellow-900">1</p>
                </div>
                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                    <p className="text-sm text-green-600 font-medium">Completed</p>
                    <p className="text-2xl font-bold text-green-900">1</p>
                </div>
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                    <p className="text-sm text-purple-600 font-medium">Partial</p>
                    <p className="text-2xl font-bold text-purple-900">1</p>
                </div>
            </div>
        </div>
    )
}
