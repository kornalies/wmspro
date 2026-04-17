# WMS Pro Web App - End User Manual

Version: 1.0  
Prepared On: 2026-04-06  
Product: WMS Pro (Web)

---

## 1. Purpose
This manual explains how end users operate WMS Pro Web for daily warehouse, finance, reporting, and portal workflows.

## 2. Intended Users
- Warehouse Executive
- Warehouse Supervisor
- Operations Manager
- Finance User
- Admin User
- Client Portal User

## 3. Login and Access

### 3.1 Sign In
1. Open the WMS Pro login page.
2. Enter Company Code, Username, and Password.
3. Click **Login**.

[Screenshot Placeholder: Login Screen]

### 3.2 Access Control
- Menus shown in the sidebar depend on your role and permissions.
- If a menu is missing, contact your Admin.

[Screenshot Placeholder: Sidebar with Role-Based Menus]

---

## 4. Dashboard
Route: `/dashboard`

### 4.1 What You Can See
- Total Warehouses
- Inventory Value
- GRNs and DOs for selected period
- Stock Alerts
- Capacity Utilization
- Alerts, Recent Activity, Billing Snapshot

### 4.2 Steps to Use Dashboard Filters
1. Open **Dashboard**.
2. Select period: **Today / Week / Month / Custom**.
3. For custom range, select **From** and **To** dates.
4. Click **Apply**.

[Screenshot Placeholder: Dashboard KPI Cards and Date Filters]

---

## 5. GRN Management
Routes: `/grn`, `/grn/new`, `/grn/new/manual`, `/grn/[id]`, `/grn/[id]/edit`

### 5.1 Create GRN
1. Open **GRN Entry**.
2. Click **Create GRN**.
3. Fill supplier, warehouse, invoice, and item details.
4. Save and confirm the GRN.

### 5.2 Edit Existing GRN
1. Search GRN in list.
2. Open GRN details.
3. Click **Edit**.
4. Update and save.

### 5.3 Print GRN
1. Open GRN record.
2. Click **Print**.

[Screenshot Placeholder: GRN List]
[Screenshot Placeholder: New GRN Form]
[Screenshot Placeholder: GRN Detail + Print]

---

## 6. Mobile GRN Approval
Routes: `/grn/mobile-approvals`, `/grn/mobile-approvals/[id]`

### 6.1 Approve Mobile Captures
1. Open **Mobile GRN Approval**.
2. Filter by status (Pending/Approved/Rejected/All).
3. Open a capture.
4. Review invoice/supplier/captured lines.
5. Click **Approve** to convert into GRN, or **Reject** with notes.

[Screenshot Placeholder: Mobile GRN Approval List]
[Screenshot Placeholder: Capture Review + Approve/Reject]

---

## 7. DO Processing and Waves
Routes: `/do`, `/do/new`, `/do/[id]`, `/do/[id]/fulfill`, `/do/waves`

### 7.1 Create and Process DO
1. Open **DO Processing**.
2. Create new DO and fill order details.
3. Allocate stock.
4. Complete fulfillment and dispatch steps.

### 7.2 Wave Management
1. Open **DO Waves**.
2. Create/allocate/release wave.
3. Assign tasks and track status.

[Screenshot Placeholder: DO List]
[Screenshot Placeholder: DO Fulfillment Screen]
[Screenshot Placeholder: DO Waves Board]

---

## 8. Stock Operations
Routes: `/stock/search`, `/stock/transfer`, `/stock/movements`

### 8.1 Stock Search
1. Open **Stock Search**.
2. Search by item/serial/client/warehouse.
3. Review available/reserved/dispatched status.

### 8.2 Put Away / Transfer
1. Open **Put Away**.
2. Select source and destination zone/location.
3. Enter quantity/serial details.
4. Submit transfer.

### 8.3 Stock Movement History
1. Open **Stock Movements**.
2. Filter by date/item/client.
3. Audit all movement records.

[Screenshot Placeholder: Stock Search]
[Screenshot Placeholder: Put Away Form]
[Screenshot Placeholder: Stock Movements Table]

---

## 9. Gate Operations
Routes: `/gate/in`, `/gate/in/[id]`, `/gate/out`

### 9.1 Gate In
1. Open **Gate In**.
2. Enter vehicle, transporter, LR/E-way bill and route details.
3. Save gate-in record.

### 9.2 Gate Out
1. Open **Gate Out**.
2. Select dispatch reference.
3. Confirm outbound gate movement.

[Screenshot Placeholder: Gate In Form]
[Screenshot Placeholder: Gate Out List/Form]

---

## 10. Admin Modules
Routes: `/admin/*`

### 10.1 Onboarding
1. Open **Onboarding**.
2. Import master templates (clients/items/users/opening data).
3. Validate and complete setup.

### 10.2 Master Data
- **Clients**: create/update client records.
- **Users**: create users, assign roles/scopes.
- **Items**: maintain item master and attributes.
- **Warehouses**: maintain warehouse records.
- **Zone Layout**: configure zones and capacities.

### 10.3 Governance
- **Tenant Settings**: tenant-level controls.
- **User Scopes**: advanced access scopes.
- **Workflow Policies**: configurable workflow behavior.
- **Audit Logs**: trace all key user actions.

[Screenshot Placeholder: Onboarding Import]
[Screenshot Placeholder: Admin Clients]
[Screenshot Placeholder: Admin Users]
[Screenshot Placeholder: Zone Layout]
[Screenshot Placeholder: Audit Logs]

---

## 11. Finance - Invoices
Route: `/finance/invoices`

### 11.1 Generate and Finalize Invoices
1. Open **Invoices**.
2. Apply search/status/warehouse filters.
3. Click **Generate Invoice** (for draft generation).
4. Open invoice and click **Finalize** when ready.

### 11.2 Send, Export, and Payment
1. Open invoice.
2. Click **Send Email**.
3. Click **Download** for PDF export.
4. Click **Record Payment** and submit payment details.

### 11.3 Credit / Debit Notes
1. Open invoice details.
2. Click **Issue Credit Note** or **Issue Debit Note**.
3. Select/add lines and submit.

[Screenshot Placeholder: Invoice Register]
[Screenshot Placeholder: Invoice Detail]
[Screenshot Placeholder: Record Payment Dialog]
[Screenshot Placeholder: Credit/Debit Note Form]

---

## 12. Finance - Billing
Route: `/finance/billing`

### 12.1 Billing Workspace
- Unbilled transactions
- Unrated transactions
- Exception workbench
- Cycle run and reprocess jobs

### 12.2 Run Billing Cycle
1. Select date range/client/warehouse.
2. Click **Run Billing Cycle**.
3. Review generated invoices and summary metrics.

### 12.3 Handle Exceptions
1. Open **Exceptions** tab.
2. Choose action: Resolve / Ignore / Send to Review.
3. Capture root cause and notes.

[Screenshot Placeholder: Billing Dashboard]
[Screenshot Placeholder: Unrated Transactions]
[Screenshot Placeholder: Exception Actions Dialog]

---

## 13. Finance - Contracts and Rate Cards
Routes: `/finance/contracts`, `/finance/rates`

### 13.1 Contracts
1. Open **Contracts**.
2. Add contract with client, effective dates, rates, cycle.
3. Upload agreement documents.
4. Save contract.

### 13.2 Rate Cards
1. Open **Rate Cards**.
2. Create rate card header.
3. Add detail lines for charge type and calc method.
4. Save and activate.

[Screenshot Placeholder: Contracts List]
[Screenshot Placeholder: Contract Document Upload]
[Screenshot Placeholder: Rate Card Header + Details]

---

## 14. Reports and Analytics
Route: `/reports`

### 14.1 Available Reports
- Stock Summary
- Daily Movement
- Gate In Detailed
- Slow Moving (60+ days)
- Client-wise Analysis

### 14.2 Generate Report
1. Open **Reports**.
2. Select report card.
3. Set date range and client filter.
4. Click **Generate Report**.
5. Use **Export Current Report** when needed.

[Screenshot Placeholder: Reports Landing]
[Screenshot Placeholder: Stock Summary Report]
[Screenshot Placeholder: Daily Movement Report]

---

## 15. Labor Management
Route: `/labor`

### 15.1 Main Functions
- Define labor standards
- Configure shifts and assignments
- Capture productivity events
- Monitor critical/warning exceptions
- Export productivity and exception data

### 15.2 Typical Daily Flow
1. Configure or verify shifts.
2. Assign users to shifts.
3. Capture productivity records.
4. Review exception dashboard and shift gaps.

[Screenshot Placeholder: Labor Dashboard]
[Screenshot Placeholder: Shifts and Assignments]
[Screenshot Placeholder: Productivity Capture]

---

## 16. Integrations
Route: `/integrations`

### 16.1 Connector Setup
1. Create connector (EDI/Carrier/ERP).
2. Configure transport, auth, endpoint.
3. Save connector.

### 16.2 Credentials and Mapping
1. Select connector.
2. Rotate credentials securely.
3. Create schema mappings.

### 16.3 Queue Monitoring
1. Run processor.
2. Monitor queued/retry/dead-letter statuses.
3. Retry failed events.
4. Export dead-letter CSV if required.

[Screenshot Placeholder: Connector Framework]
[Screenshot Placeholder: Credential Vault]
[Screenshot Placeholder: Queue Monitor]

---

## 17. WES Orchestration
Route: `/wes`

### 17.1 Equipment and Commands
1. Register equipment and adapter type.
2. Select equipment.
3. Queue command payload.
4. Run queue processor.

### 17.2 Incident Handling
1. Monitor open incidents.
2. Resolve with notes and close safety mode (if approved).

[Screenshot Placeholder: WES Equipment Table]
[Screenshot Placeholder: Command Queue]
[Screenshot Placeholder: Safety Failover Incidents]

---

## 18. Client Portal (Web)
Routes: `/portal`, `/portal/inventory`, `/portal/orders`, `/portal/billing`, `/portal/disputes`, `/portal/sla`, `/portal/asn`

### 18.1 Portal Dashboard
1. Open portal.
2. Select client mapping.
3. Review inventory/order/billing/dispute/SLA widgets.

### 18.2 Portal Billing Actions
1. Open **Portal Billing**.
2. For each invoice: **Approve**, **Dispute**, or **Pay**.
3. Enter reason/payment references where prompted.

### 18.3 ASN Request
1. Open **ASN** page.
2. Fill inbound shipment details.
3. Submit ASN request.

[Screenshot Placeholder: Portal Home]
[Screenshot Placeholder: Portal Billing with Approve/Dispute/Pay]
[Screenshot Placeholder: Portal ASN Form]

---

## 19. Mobile Integration (Reference for Users)
- Mobile app authenticates via `/api/mobile/auth/*`.
- Mobile GRN captures sync to web approval queue.
- Scanner helper APIs support item/barcode parsing.
- OCR extraction is designed for native mobile ML Kit workflow.

[Screenshot Placeholder: Mobile App Capture]
[Screenshot Placeholder: Web Mobile Approval Correlation]

---

## 20. Common Troubleshooting

### 20.1 Menu Missing
- Cause: permission not assigned.
- Action: ask Admin to update role/scopes.

### 20.2 Report Not Showing Data
- Verify date range, client filter, and warehouse filter.
- Confirm transactions exist for selected period.

### 20.3 Invoice/Billing Mismatch
- Check unrated/unbilled queues in Billing workspace.
- Verify rate card and contract setup.

### 20.4 Integration Event Failures
- Check monitor status and error reason.
- Retry event after mapping/credential fix.

---

## 21. Appendix - Suggested Screenshot Checklist
- Login page
- Dashboard KPIs
- GRN create/edit
- Mobile GRN approval
- DO fulfillment and waves
- Stock transfer and movement
- Gate in/out
- Admin users and audit
- Invoices and payment recording
- Billing exception action
- Reports module
- Labor exception dashboard
- Integrations queue monitor
- WES incident resolution
- Portal billing actions

