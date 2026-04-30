"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SecurityLevel = "normal" | "elevated" | "critical";

type SecurityTelemetrySnapshot = {
  totalEvents: number;
  lastEventAt: string | null;
  lastEventType: string | null;
  eventCounts: Record<string, number>;
};

type SecurityStatus = {
  level: SecurityLevel;
  totalEvents: number;
  topEvents: Array<{ type: string; count: number }>;
  thresholds: {
    elevatedTotalEvents: number;
    criticalTotalEvents: number;
    elevatedPerEventCount: number;
    criticalPerEventCount: number;
  };
};

const formatEventType = (value: string) => value.replaceAll("_", " ");

const statusVariantClass: Record<SecurityLevel, string> = {
  normal: "bg-emerald-100 text-emerald-800",
  elevated: "bg-amber-100 text-amber-800",
  critical: "bg-red-100 text-red-800",
};

export default function SecurityTelemetryPage() {
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<SecurityTelemetrySnapshot | null>(null);
  const [status, setStatus] = useState<SecurityStatus | null>(null);

  const load = useCallback(async (notifyOnError = false) => {
    try {
      const res = await fetch("/api/security/telemetry", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        if (notifyOnError) {
          toast.error(json?.error?.message || "Failed to load security telemetry");
        }
        return;
      }
      setSnapshot((json?.data?.securityTelemetry || null) as SecurityTelemetrySnapshot | null);
      setStatus((json?.data?.securityStatus || null) as SecurityStatus | null);
    } catch {
      if (notifyOnError) {
        toast.error("Unable to load security telemetry");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const eventRows = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot.eventCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([eventType, count]) => ({ eventType, count }));
  }, [snapshot]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Security Telemetry</CardTitle>
          <div className="flex items-center gap-2">
            {status ? (
              <Badge className={statusVariantClass[status.level]}>
                {status.level.toUpperCase()}
              </Badge>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
              {loading ? "Loading..." : "Refresh"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border p-4">
            <p className="text-sm text-gray-500">Total Events</p>
            <p className="mt-2 text-2xl font-semibold">{snapshot?.totalEvents ?? 0}</p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-sm text-gray-500">Last Event Time</p>
            <p className="mt-2 text-sm font-medium">
              {snapshot?.lastEventAt ? new Date(snapshot.lastEventAt).toLocaleString() : "-"}
            </p>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-sm text-gray-500">Last Event Type</p>
            <p className="mt-2 text-sm font-medium capitalize">
              {snapshot?.lastEventType ? formatEventType(snapshot.lastEventType) : "-"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top Event Types</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status?.topEvents?.length ? (
                status.topEvents.map((event) => (
                  <TableRow key={event.type}>
                    <TableCell className="capitalize">{formatEventType(event.type)}</TableCell>
                    <TableCell className="text-right font-medium">{event.count}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-gray-500">
                    {loading ? "Loading..." : "No security events recorded."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Thresholds</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">Elevated</p>
            <p className="mt-2 text-gray-600">
              Total events threshold: {status?.thresholds.elevatedTotalEvents ?? "-"}
            </p>
            <p className="text-gray-600">
              Per-event threshold: {status?.thresholds.elevatedPerEventCount ?? "-"}
            </p>
          </div>
          <div className="rounded-lg border p-4 text-sm">
            <p className="font-medium">Critical</p>
            <p className="mt-2 text-gray-600">
              Total events threshold: {status?.thresholds.criticalTotalEvents ?? "-"}
            </p>
            <p className="text-gray-600">
              Per-event threshold: {status?.thresholds.criticalPerEventCount ?? "-"}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All Event Counters</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eventRows.length ? (
                eventRows.map((event) => (
                  <TableRow key={event.eventType}>
                    <TableCell className="capitalize">{formatEventType(event.eventType)}</TableCell>
                    <TableCell className="text-right font-medium">{event.count}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-gray-500">
                    {loading ? "Loading..." : "No events found."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
