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

export default function GateOutList() {
    const history = [
        {
            id: "1",
            vehicleNumber: "KA-05-MM-9999",
            driverName: "Robert Fox",
            outTime: "2024-02-16 06:00 PM",
            status: "EXITED",
        },
        {
            id: "2",
            vehicleNumber: "MH-12-QQ-1111",
            driverName: "Cody Fisher",
            outTime: "2024-02-16 04:30 PM",
            status: "EXITED",
        },
    ];

    return (
        <div className="mt-6 rounded-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <div className="border-b border-slate-200 p-4 dark:border-slate-800">
                <h3 className="text-lg font-semibold">Gate Exit History</h3>
            </div>
            <Table>
                <TableHeader>
                    <TableRow className="bg-slate-50 dark:bg-slate-900">
                        <TableHead>Vehicle No.</TableHead>
                        <TableHead>Driver</TableHead>
                        <TableHead>Out Time</TableHead>
                        <TableHead>Status</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {history.map((h) => (
                        <TableRow key={h.id}>
                            <TableCell className="font-medium">{h.vehicleNumber}</TableCell>
                            <TableCell>{h.driverName}</TableCell>
                            <TableCell>{h.outTime}</TableCell>
                            <TableCell>
                                <Badge variant="secondary">{h.status}</Badge>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}
