"use client";

import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function GateInList() {
    const vehicles = [
        {
            id: "1",
            vehicleNumber: "KA-01-HH-1234",
            driverName: "John Doe",
            inTime: "2024-02-17 08:30 AM",
            status: "INSIDE",
        },
        {
            id: "2",
            vehicleNumber: "TN-09-BB-5678",
            driverName: "Jane Smith",
            inTime: "2024-02-17 09:15 AM",
            status: "INSIDE",
        },
    ];

    return (
        <div className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <div className="border-b border-slate-200 p-4 dark:border-slate-800">
                <h3 className="text-lg font-semibold">Vehicles Currently Inside</h3>
            </div>
            <Table>
                <TableHeader>
                    <TableRow className="bg-slate-50 dark:bg-slate-900">
                        <TableHead>Vehicle No.</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead>In Time</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {vehicles.map((v) => (
                        <TableRow key={v.id}>
                            <TableCell className="font-medium">{v.vehicleNumber}</TableCell>
                            <TableCell>{v.driverName}</TableCell>
                            <TableCell>{v.inTime}</TableCell>
                            <TableCell>
                                <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
                                    {v.status}
                                </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                                <Button variant="outline" size="sm">
                                    View
                                </Button>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
