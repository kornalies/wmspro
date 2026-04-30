"use client"

import { useMemo, useState } from "react"
import { Cable, Database, Download, Loader2, RotateCcw, Shield, Shuffle } from "lucide-react"

import {
  useConnectorCredentials,
  useDispatchIntegrationEvent,
  useIntegrationConnectors,
  useIntegrationMappings,
  useIntegrationMonitor,
  useProcessConnectorQueue,
  useProcessIntegrationQueue,
  useRetryIntegrationEvent,
  useSaveConnectorCredential,
  useUpsertConnector,
  useUpsertIntegrationMapping,
} from "@/hooks/use-integrations"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type Connector = {
  id: number
  connector_code: string
  connector_name: string
  provider_type: "EDI" | "CARRIER" | "ERP"
  transport_type: "REST" | "SFTP" | "FTP" | "EMAIL" | "WEBHOOK"
  direction: "INBOUND" | "OUTBOUND" | "BIDIRECTIONAL"
  auth_type: "NONE" | "API_KEY" | "BASIC" | "BEARER" | "OAUTH2"
  endpoint_url?: string | null
  status: "ACTIVE" | "INACTIVE" | "ERROR"
  retry_limit: number
  dead_letter_after: number
  credential_count: number
}

type Mapping = {
  id: number
  connector_name: string
  entity_type: string
  direction: string
  mapping_version: number
  is_default: boolean
  fields: Array<{
    source_path: string
    target_path: string
    data_type: string
    transform_rule?: string | null
    required: boolean
    sequence_no: number
  }>
}

type MonitorRow = {
  id: number
  connector_name: string
  provider_type: string
  status: "QUEUED" | "PROCESSING" | "SUCCESS" | "RETRY" | "DEAD_LETTER"
  entity_type: string
  entity_id?: string | null
  direction: string
  attempt_count: number
  last_error?: string | null
  created_at: string
  next_retry_at?: string | null
}

const today = new Date().toISOString().slice(0, 10)
const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10)

export default function IntegrationsPage() {
  const [selectedConnectorId, setSelectedConnectorId] = useState<number | undefined>(undefined)
  const [from, setFrom] = useState(weekAgo)
  const [to, setTo] = useState(today)
  const [range, setRange] = useState({ from: weekAgo, to: today })

  const [connectorCode, setConnectorCode] = useState("")
  const [connectorName, setConnectorName] = useState("")
  const [providerType, setProviderType] = useState<"EDI" | "CARRIER" | "ERP">("EDI")
  const [transportType, setTransportType] = useState<"REST" | "SFTP" | "FTP" | "EMAIL" | "WEBHOOK">("REST")
  const [direction, setDirection] = useState<"INBOUND" | "OUTBOUND" | "BIDIRECTIONAL">("BIDIRECTIONAL")
  const [authType, setAuthType] = useState<"NONE" | "API_KEY" | "BASIC" | "BEARER" | "OAUTH2">("NONE")
  const [endpointUrl, setEndpointUrl] = useState("")

  const [credentialKey, setCredentialKey] = useState("")
  const [credentialValue, setCredentialValue] = useState("")

  const [mappingEntityType, setMappingEntityType] = useState("DO")
  const [mappingDirection, setMappingDirection] = useState<"INBOUND" | "OUTBOUND">("OUTBOUND")
  const [mappingFieldsText, setMappingFieldsText] = useState(
    '[{"source_path":"do_number","target_path":"order.id","data_type":"string","required":true,"sequence_no":1}]'
  )

  const [dispatchPayload, setDispatchPayload] = useState("{}")
  const [dispatchEntityType, setDispatchEntityType] = useState("DO")
  const [dispatchEntityId, setDispatchEntityId] = useState("")

  const connectorsQuery = useIntegrationConnectors()
  const mappingsQuery = useIntegrationMappings(selectedConnectorId)
  const monitorQuery = useIntegrationMonitor(range.from, range.to, selectedConnectorId)
  const credentialsQuery = useConnectorCredentials(selectedConnectorId)

  const upsertConnector = useUpsertConnector()
  const saveCredential = useSaveConnectorCredential(selectedConnectorId)
  const upsertMapping = useUpsertIntegrationMapping()
  const dispatchEvent = useDispatchIntegrationEvent()
  const processQueue = useProcessIntegrationQueue()
  const processConnectorQueue = useProcessConnectorQueue()
  const retryEvent = useRetryIntegrationEvent()

  const connectors = (connectorsQuery.data?.data as Connector[] | undefined) ?? []
  const mappings = (mappingsQuery.data?.data as Mapping[] | undefined) ?? []
  const monitorPayload = (monitorQuery.data?.data as {
    summary?: {
      total_events: number
      success_count: number
      queued_count: number
      retry_count: number
      dead_letter_count: number
      processing_count: number
    }
    rows?: MonitorRow[]
  }) || { rows: [] }
  const monitorRows = monitorPayload.rows || []
  const summary = monitorPayload.summary
  const credentials = (credentialsQuery.data?.data as Array<{ id: number; credential_key: string; last_rotated_at: string }> | undefined) ?? []

  const isLoading = connectorsQuery.isLoading || mappingsQuery.isLoading || monitorQuery.isLoading

  const selectedConnector = useMemo(
    () => connectors.find((c) => c.id === selectedConnectorId),
    [connectors, selectedConnectorId]
  )

  if (isLoading) {
    return (
      <div className="flex min-h-[360px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">EDI / Carrier / ERP Integrations</h1>
          <p className="mt-1 text-gray-500">Connector framework, credential vault, schema mappings, and retry/dead-letter monitor</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() =>
              window.open(
                `/api/integrations/monitor/export?status=DEAD_LETTER&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}${
                  selectedConnectorId ? `&connector_id=${selectedConnectorId}` : ""
                }`,
                "_blank"
              )
            }
          >
            <Download className="mr-2 h-4 w-4" />
            Export DLQ CSV
          </Button>
          <Button variant="outline" onClick={() => setRange({ from, to })}>
            Apply Range
          </Button>
          <Button
            variant="outline"
            disabled={!selectedConnectorId || processConnectorQueue.isPending}
            onClick={() => selectedConnectorId && processConnectorQueue.mutate(selectedConnectorId)}
          >
            <Shuffle className="mr-2 h-4 w-4" />
            Run Selected
          </Button>
          <Button onClick={() => processQueue.mutate()} disabled={processQueue.isPending}>
            <Shuffle className="mr-2 h-4 w-4" />
            Run Processor
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-6">
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Total</p><p className="text-2xl font-bold">{summary?.total_events || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Success</p><p className="text-2xl font-bold text-emerald-700">{summary?.success_count || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Queued</p><p className="text-2xl font-bold text-blue-700">{summary?.queued_count || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Retry</p><p className="text-2xl font-bold text-amber-700">{summary?.retry_count || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Dead Letter</p><p className="text-2xl font-bold text-red-700">{summary?.dead_letter_count || 0}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-gray-500">Processing</p><p className="text-2xl font-bold text-purple-700">{summary?.processing_count || 0}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Connector Framework</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-8">
            <Input placeholder="Code" value={connectorCode} onChange={(e) => setConnectorCode(e.target.value)} />
            <Input placeholder="Name" value={connectorName} onChange={(e) => setConnectorName(e.target.value)} />
            <Select value={providerType} onValueChange={(v) => setProviderType(v as "EDI" | "CARRIER" | "ERP")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="EDI">EDI</SelectItem><SelectItem value="CARRIER">CARRIER</SelectItem><SelectItem value="ERP">ERP</SelectItem></SelectContent></Select>
            <Select value={transportType} onValueChange={(v) => setTransportType(v as "REST" | "SFTP" | "FTP" | "EMAIL" | "WEBHOOK")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="REST">REST</SelectItem><SelectItem value="SFTP">SFTP</SelectItem><SelectItem value="FTP">FTP</SelectItem><SelectItem value="EMAIL">EMAIL</SelectItem><SelectItem value="WEBHOOK">WEBHOOK</SelectItem></SelectContent></Select>
            <Select value={direction} onValueChange={(v) => setDirection(v as "INBOUND" | "OUTBOUND" | "BIDIRECTIONAL")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INBOUND">INBOUND</SelectItem><SelectItem value="OUTBOUND">OUTBOUND</SelectItem><SelectItem value="BIDIRECTIONAL">BIDIRECTIONAL</SelectItem></SelectContent></Select>
            <Select value={authType} onValueChange={(v) => setAuthType(v as "NONE" | "API_KEY" | "BASIC" | "BEARER" | "OAUTH2")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE">NONE</SelectItem><SelectItem value="API_KEY">API_KEY</SelectItem><SelectItem value="BASIC">BASIC</SelectItem><SelectItem value="BEARER">BEARER</SelectItem><SelectItem value="OAUTH2">OAUTH2</SelectItem></SelectContent></Select>
            <Input placeholder="Endpoint URL" value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} />
            <Button
              onClick={() =>
                upsertConnector.mutate({
                  connector_code: connectorCode,
                  connector_name: connectorName,
                  provider_type: providerType,
                  transport_type: transportType,
                  direction,
                  auth_type: authType,
                  endpoint_url: endpointUrl || undefined,
                })
              }
              disabled={!connectorCode || !connectorName || upsertConnector.isPending}
            >
              Save
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connectors.map((row) => (
                <TableRow key={row.id} className={row.id === selectedConnectorId ? "bg-blue-50" : ""} onClick={() => setSelectedConnectorId(row.id)}>
                  <TableCell className="font-mono text-xs">{row.connector_code}</TableCell>
                  <TableCell>{row.connector_name}</TableCell>
                  <TableCell>{row.provider_type}</TableCell>
                  <TableCell>{row.transport_type}</TableCell>
                  <TableCell>{row.direction}</TableCell>
                  <TableCell>{row.credential_count}</TableCell>
                  <TableCell>
                    <Badge className={row.status === "ACTIVE" ? "bg-emerald-100 text-emerald-700" : row.status === "ERROR" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-700"}>
                      {row.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base"><Shield className="mr-2 inline h-4 w-4" />Endpoint Credentials</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-gray-500">Values are encrypted at rest and never returned by API.</p>
            <div className="grid gap-2 md:grid-cols-3">
              <Input placeholder="Key (API_KEY, PASSWORD...)" value={credentialKey} onChange={(e) => setCredentialKey(e.target.value)} />
              <Input placeholder="Secret Value" type="password" value={credentialValue} onChange={(e) => setCredentialValue(e.target.value)} />
              <Button disabled={!selectedConnectorId || !credentialKey || !credentialValue || saveCredential.isPending} onClick={() => saveCredential.mutate({ credential_key: credentialKey, credential_value: credentialValue })}>Rotate Credential</Button>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Last Rotated</TableHead></TableRow></TableHeader>
              <TableBody>
                {credentials.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{row.credential_key}</TableCell>
                    <TableCell>{new Date(row.last_rotated_at).toLocaleString("en-IN")}</TableCell>
                  </TableRow>
                ))}
                {credentials.length === 0 ? (
                  <TableRow><TableCell colSpan={2} className="text-center text-gray-500">No credentials configured</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base"><Database className="mr-2 inline h-4 w-4" />Schema Mapping UI</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-3">
              <Input placeholder="Entity (DO, GRN, INVOICE)" value={mappingEntityType} onChange={(e) => setMappingEntityType(e.target.value)} />
              <Select value={mappingDirection} onValueChange={(v) => setMappingDirection(v as "INBOUND" | "OUTBOUND")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="INBOUND">INBOUND</SelectItem><SelectItem value="OUTBOUND">OUTBOUND</SelectItem></SelectContent></Select>
              <Button
                disabled={!selectedConnectorId || !mappingEntityType || upsertMapping.isPending}
                onClick={() => {
                  const parsed = JSON.parse(mappingFieldsText) as Array<{
                    source_path: string
                    target_path: string
                    data_type?: string
                    transform_rule?: string
                    default_value?: string
                    required?: boolean
                    sequence_no?: number
                  }>
                  upsertMapping.mutate({
                    connector_id: selectedConnectorId,
                    entity_type: mappingEntityType,
                    direction: mappingDirection,
                    mapping_version: 1,
                    fields: parsed,
                  })
                }}
              >
                Save Mapping
              </Button>
            </div>
            <textarea
              className="min-h-24 w-full rounded border p-2 font-mono text-xs"
              value={mappingFieldsText}
              onChange={(e) => setMappingFieldsText(e.target.value)}
            />
            <div className="space-y-2">
              {mappings.map((row) => (
                <div key={row.id} className="rounded border p-2">
                  <p className="text-sm font-medium">{row.connector_name} - {row.entity_type} ({row.direction})</p>
                  <p className="text-xs text-gray-500">Fields: {row.fields.length}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base"><Cable className="mr-2 inline h-4 w-4" />Queue + Retry/Dead-letter Monitor</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-6">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <Input placeholder="Entity type" value={dispatchEntityType} onChange={(e) => setDispatchEntityType(e.target.value)} />
            <Input placeholder="Entity id" value={dispatchEntityId} onChange={(e) => setDispatchEntityId(e.target.value)} />
            <textarea className="rounded border p-2 font-mono text-xs md:col-span-2" value={dispatchPayload} onChange={(e) => setDispatchPayload(e.target.value)} />
            <Button
              disabled={!selectedConnectorId || dispatchEvent.isPending}
              onClick={() =>
                dispatchEvent.mutate({
                  connector_id: selectedConnectorId,
                  entity_type: dispatchEntityType,
                  entity_id: dispatchEntityId || undefined,
                  direction: selectedConnector?.direction === "INBOUND" ? "INBOUND" : "OUTBOUND",
                  request_payload: JSON.parse(dispatchPayload),
                })
              }
            >
              Queue Event
            </Button>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Connector</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monitorRows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.id}</TableCell>
                  <TableCell>{row.connector_name}</TableCell>
                  <TableCell>{row.entity_type} {row.entity_id ? `(${row.entity_id})` : ""}</TableCell>
                  <TableCell>
                    <Badge className={row.status === "SUCCESS" ? "bg-emerald-100 text-emerald-700" : row.status === "DEAD_LETTER" ? "bg-red-100 text-red-700" : row.status === "RETRY" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-700"}>
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{row.attempt_count}</TableCell>
                  <TableCell className="max-w-[260px] truncate text-xs text-red-600">{row.last_error || "-"}</TableCell>
                  <TableCell>{new Date(row.created_at).toLocaleString("en-IN")}</TableCell>
                  <TableCell className="text-right">
                    {(row.status === "RETRY" || row.status === "DEAD_LETTER") ? (
                      <Button size="sm" variant="outline" onClick={() => retryEvent.mutate(row.id)}>
                        <RotateCcw className="mr-1 h-3 w-3" />
                        Retry
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
