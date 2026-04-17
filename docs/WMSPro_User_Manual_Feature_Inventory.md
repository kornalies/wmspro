# WMS Pro User Manual - Feature Inventory (Web App)

Source scope: `C:\Users\Admin-PC\wms-frontend` codebase (App Router pages, sidebar modules, APIs, and docs).

## 1) List of Features Across the Web App

### 1.1 Core Warehouse Operations
- Dashboard (`/dashboard`): executive KPIs, alerts, recent activity, billing snapshot, drill-down links.
- GRN Entry (`/grn`, `/grn/new`, `/grn/new/manual`, `/grn/[id]`, `/grn/[id]/edit`, `/grn/print/[id]`): inbound receiving and GRN lifecycle.
- Mobile GRN Approval (`/grn/mobile-approvals`, `/grn/mobile-approvals/[id]`): review/approve/reject mobile captures into stock.
- DO Processing (`/do`, `/do/new`, `/do/[id]`, `/do/[id]/fulfill`): outbound order handling and fulfillment.
- DO Waves (`/do/waves`): wave creation/allocation/release/task flow.
- Stock Search (`/stock/search`): item/serial-level stock lookup.
- Put Away / Transfer (`/stock/transfer`): stock placement and internal movements.
- Stock Movements (`/stock/movements`): movement history trail.
- Gate In (`/gate/in`, `/gate/in/[id]`): inbound vehicle/consignment control.
- Gate Out (`/gate/out`): outbound gate processing.

### 1.2 Admin and Master Data
- Onboarding (`/admin/onboarding`): guided imports and setup.
- Clients (`/admin/clients`): client master management.
- Users (`/admin/users`): user and role setup.
- Items (`/admin/items`): SKU/item masters.
- Warehouses (`/admin/warehouses`): warehouse master records.
- Zone Layout (`/admin/zone-layouts`): capacity and zone structure.
- Tenant Settings (`/admin/tenant-settings`): tenant-level behavior/config.
- User Scopes (`/admin/scopes`): scoped access controls.
- Workflow Policies (`/admin/workflow-policies`): workflow governance.
- Audit Logs (`/admin/audit`): audit trail visibility.
- Companies (`/admin/companies`): company-level setup.

### 1.3 Finance and Commercials
- Invoices (`/finance/invoices`): invoice generation, finalization, email, PDF export, payment recording, credit/debit notes, trial balance and journal voucher flows.
- Billing (`/finance/billing`): billing workspace for unbilled/unrated/exceptions, cycle runs, reprocess jobs, billing analytics charts, and billing profile management.
- Contracts (`/finance/contracts`): commercial contracts, rates, billing cycle, contract document attachments.
- Rate Cards (`/finance/rates`): pricing engine configuration (FLAT, PER_UNIT, SLAB, PERCENT) with charge-level rules.

### 1.4 Operations Intelligence and Automation
- Reports & Analytics (`/reports`): stock summary, movement, gate-in detail, slow-moving, client-wise analysis.
- Labor Management (`/labor`): standards, shifts, assignments, productivity capture, exception dashboard, shift gap analysis, CSV exports.
- Integrations (`/integrations`): connector setup (EDI/Carrier/ERP), credential vault, mapping UI, queue monitor, retry/dead-letter handling, CSV export.
- WES (`/wes`): equipment adapter layer, command queue, monitor, failover incident handling.

### 1.5 Client Portal (Web)
- Portal Home (`/portal`): client-level summary of stock/GRN/orders/billing/disputes/SLA.
- Portal Inventory (`/portal/inventory`)
- Portal Orders (`/portal/orders`)
- Portal Billing (`/portal/billing`): approve/dispute/pay actions.
- Portal Disputes (`/portal/disputes`)
- Portal SLA (`/portal/sla`)
- Portal ASN (`/portal/asn`)

### 1.6 Security / Control Model
- Role/permission-based route access enforcement (`lib/route-permissions.ts`).
- Multi-tenant and company-aware API data isolation.
- Policy-driven portal feature toggles and permission gating.

## 2) Mobile Integration Features

### 2.1 Mobile API Surface (`/api/mobile/*`)
- Auth:
  - `POST /api/mobile/auth/login`
  - `POST /api/mobile/auth/refresh`
  - `GET /api/mobile/auth/me`
  - `POST /api/mobile/auth/logout`
- Mobile GRN Capture lifecycle:
  - `GET /api/mobile/grn/captures`
  - `POST /api/mobile/grn/captures`
  - `GET /api/mobile/grn/captures/{id}`
  - `POST /api/mobile/grn/captures/{id}/approve`
  - `POST /api/mobile/grn/captures/{id}/reject`
- Scanner helpers:
  - `POST /api/mobile/scans/items/lookup`
  - `POST /api/mobile/scans/grn/barcode/lookup`
  - `POST /api/mobile/scans/do/parse`

### 2.2 Web + Mobile Operational Link
- Mobile captures are reviewed in web module `Mobile GRN Approvals` and approved to create GRNs/stock impact.
- Web GRN experience includes scanner support UI, but OCR extraction is explicitly marked mobile-native (ML Kit flow).

### 2.3 Current Contract Notes
- Implemented contract is documented in `docs/mobile-api-contract-v1.md`.
- Explicitly marked planned/not yet implemented:
  - `POST /api/mobile/scans/gate/vehicle/lookup`
  - `POST /api/mobile/offline/sync`

## 3) Dashboards and Reports

### 3.1 Main Dashboard (Web)
- Route: `/dashboard`
- Time ranges: Today, Week, Month, Custom date range.
- Executive KPIs:
  - Total warehouses
  - Inventory value
  - GRNs in period
  - DOs in period
  - Stock alerts (below threshold)
  - Capacity utilization
- Widgets:
  - Alerts panel
  - Recent activity
  - GRN/DO recent drilldowns
  - Capacity by warehouse
  - Billing snapshot (invoices, billed, paid, pending, overdue)

### 3.2 Reports & Analytics Module
- Route: `/reports`
- Report packs:
  - Stock Summary
  - Daily Movement
  - Gate In Detailed Report
  - Slow Moving (60+ days)
  - Client-wise Analysis
- Filters/controls: date range, client, pagination, export action.
- Primary report APIs:
  - `GET /api/reports/stock`
  - `GET /api/reports/movements`
  - `GET /api/reports/analytics`

### 3.3 Finance Reporting/Analytics Surfaces
- Invoices module:
  - Invoice register KPIs (revenue, paid, outstanding, overdue)
  - Trial Balance query/reporting
  - Journal listing and voucher posting view
- Billing module:
  - Revenue mix, collection efficiency, waterfall, aging, client concentration and trend charts
  - Exception management view (resolve/ignore/review)
  - Unbilled/unrated transaction workspaces
- Supporting APIs include:
  - `GET /api/finance/trial-balance`
  - `GET /api/finance/reconciliation/inventory`
  - `GET /api/finance/billing`
  - `GET /api/finance/invoices`

### 3.4 Functional Dashboards Beyond Reports Page
- Labor Dashboard (`/labor`): productivity, critical/warning exceptions, shift gap dashboard, exports.
- Integrations Monitor (`/integrations`): queue status dashboard, dead-letter export, retries.
- WES Monitor (`/wes`): command status and incident/failover dashboard.
- Portal Summary Dashboard (`/portal`): client-facing stock, GRN, order, billing, disputes, SLA widgets.
