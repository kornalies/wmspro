# Client Portal (v1)

## Scope
- Dashboard: inventory, GRN, order fulfillment summary
- Orders list
- Billing list
- Reports summary
- ASN request submission

## Routes
- UI:
  - `/portal`
  - `/portal/inventory`
  - `/portal/orders`
  - `/portal/billing`
  - `/portal/asn`
- APIs:
  - `GET /api/portal/clients`
  - `GET /api/portal/inventory?client_id=...`
  - `GET /api/portal/orders?client_id=...`
  - `GET /api/portal/billing?client_id=...`
  - `GET /api/portal/reports?client_id=...`
  - `GET /api/portal/asn?client_id=...`
  - `POST /api/portal/asn`

## Security Model
- Multi-tenant isolation uses `company_id` context.
- Client-level isolation uses `portal_user_clients` mapping table.
- A portal user can access only mapped clients.

## Admin Setup
To grant a user access to one client:

```sql
INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
VALUES (<company_id>, <user_id>, <client_id>, true)
ON CONFLICT (company_id, user_id, client_id)
DO UPDATE SET is_active = EXCLUDED.is_active;
```

## Idempotency
- `POST /api/portal/asn` supports `x-idempotency-key`.
