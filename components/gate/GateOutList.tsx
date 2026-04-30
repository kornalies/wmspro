"use client";

import { Loader2 } from "lucide-react";

import { useGateOutLogs } from "@/hooks/use-gate";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

type GateOutRow = {
    id: number;
    gate_out_number: string;
    vehicle_number: string;
    driver_name: string;
    gate_out_datetime: string;
    status?: string;
};

export default function GateOutList() {
    const { data, isLoading } = useGateOutLogs();
    const history = (data?.data as GateOutRow[] | undefined) ?? [];

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
                    {isLoading ? (
                        <TableRow>
                            <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                                <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                            </TableCell>
                        </TableRow>
                    ) : history.length ? history.map((h) => (
                        <TableRow key={h.id}>
                            <TableCell className="font-medium">{h.vehicle_number}</TableCell>
                            <TableCell>{h.driver_name}</TableCell>
                            <TableCell>{new Date(h.gate_out_datetime).toLocaleString()}</TableCell>
                            <TableCell>
                                <Badge variant="secondary">{h.status || "EXITED"}</Badge>
                            </TableCell>
                        </TableRow>
                    )) : (
                        <TableRow>
                            <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                                No gate exits recorded.
                            </TableCell>
                        </TableRow>
                    )}
                </TableBody>
            </Table>
        </div>
    );
}
