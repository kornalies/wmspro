# Client Portal

The screens a client's own staff log into, to see their stock and orders in your
warehouse, act on their invoices, raise disputes, and announce inbound shipments.

## Screens

| Route | What it shows |
| --- | --- |
| `/portal` | Client-level summary: stock, GRN, order fulfilment, billing, disputes, SLA |
| `/portal/inventory` | Stock on hand for the selected client |
| `/portal/orders` | Delivery orders and their fulfilment state |
| `/portal/billing` | Invoices, with approve / dispute / pay actions |
| `/portal/disputes` | Invoice disputes and their event history |
| `/portal/sla` | SLA policy and KPI attainment |
| `/portal/asn` | Advance shipment notice requests |
| `/portal/reports` | Reports summary |
| `/portal/login` | Client sign-in. Separate from the staff `/login` — see below |
| `/portal/activate` | Invite redemption. Deliberately outside the portal layout — the visitor has no session yet |

## Sign-in

There are two sign-in screens and they are not interchangeable. `/login` is for
warehouse staff: company code, a Warehouse/Freight product toggle, and
routing-by-product on success. `/portal/login` is for clients: no product toggle,
no module status panel, and it only ever lands the user inside `/portal`.

`proxy.ts` picks between them by path — anything under `/portal` redirects to the
portal login carrying `?next=`, everything else to the staff login. The same
choice is available to client code as `signInPathFor()` in
[`lib/sign-in-path.ts`](../lib/sign-in-path.ts), which the axios 401 interceptor
and the auth store both use so a client whose session expires mid-session does
not get dropped on the staff screen.

`/portal/login` and `/portal/activate` are exempt from the proxy's auth
redirect — they exist precisely because the visitor has no session. Without the
exemption `/portal/:path*` swallowed the activation link and stripped its token,
which made the invite flow unreachable by the only people meant to use it. **If
you add another pre-session portal page, add it to `isPublicPortalPath()`.**
Conversely, a visitor who *is* signed in gets bounced from `/portal/login`
straight to `/portal`.

### Branded links

`/portal/login?c=ACME` prefills the company code and makes the field read-only,
so a tenant can hand its clients a link that only asks for username and password.
Without it the field is normal and remembers the last code in `localStorage`
under `gwu_portal_company_code` (separate from the staff key, so a machine used
for both does not have them fighting).

Staff roles can sign in at the portal login — `ADMIN` and `SUPER_ADMIN` have
legitimate portal access. A role with no portal access at all is told to use the
staff login rather than being signed in and silently bounced.

## APIs

Read: `GET /api/portal/{clients,inventory,orders,billing,reports,asn,sla,disputes,features}`.
All except `clients` and `features` require `?client_id=`.

Write:
- `POST /api/portal/asn` — supports `x-idempotency-key`
- `POST /api/portal/disputes`, `PATCH /api/portal/disputes/[id]`
- `POST /api/portal/billing/[id]/actions` — approve / dispute / pay / comment
- `PUT /api/portal/sla`

Public (no session, token in hand):
- `GET /api/portal/invite/validate?token=…`
- `POST /api/portal/invite/activate`

Admin:
- `GET|PUT /api/admin/portal-mappings` — client mappings and feature grants for one user
- `GET|POST /api/admin/portal-invites` — issue an activation link
- `POST /api/portal/mappings/auto-seed` — best-effort backfill for an existing tenant

## Access model

Four gates, all of which must pass:

1. **Product entitlement.** `assertProductEnabled(companyId, "WMS")`.
2. **Tenant.** `company_id`, enforced by row level security on every portal table
   (migrations 030 and 080) — not by the calling route's `WHERE` clause.
3. **Client.** `portal_user_clients` maps a user to the clients they may name.
   A `client_id` outside that set is a 403, not an empty list.
4. **Feature.** `portal_user_permissions` grants individual feature keys, listed
   canonically in [`lib/portal-features.ts`](../lib/portal-features.ts).

Gate 4 **fails closed**: a user with no grant rows can do nothing. It used to
fall open — no rows meant unrestricted — so provisioning a portal user and
forgetting their grants handed them billing and disputes. Migration 080 backfills
the full key set for everyone who was relying on that, then the default flipped.
Newly created portal users start with nothing until an admin grants it.

`ADMIN` and `SUPER_ADMIN` bypass gate 4 entirely.

Write actions carry a fifth check on top: the RBAC permission
(`portal.billing.action`, `portal.dispute.create`, `portal.sla.manage`), so a
feature grant alone does not authorise a write.

## Setup

Use **Admin → Users → Portal Access** to map clients and tick feature grants,
then issue an invite from the same screen. The invite link goes to
`/portal/activate?token=…`; redeeming it sets the user's password and activates
the account.

For an existing tenant that predates the admin UI, `POST /api/portal/mappings/auto-seed`
maps admins to every client in their own company and client-role users to the
client whose `client_code` matches their username or email local-part. It is a
convenience, not a substitute for reviewing the result.

## Invites and row level security

`portal_user_invites` is the one portal table read without a session — activation
happens before the user can log in, so those two routes arrive holding only the
token and have no company context to filter on.

Its RLS policy therefore also accepts a row whose `invite_token` matches
`app.portal_invite_token`, a transaction-local setting that
`setInviteTokenContext()` populates from the URL. The token is the credential:
120 characters, single-use, expiring. `WITH CHECK` does not get the same escape
hatch — reading an invite by token is the flow, writing one is not — so
activation sets a real tenant context before it marks the invite `ACCEPTED`.

If you add another session-less portal route, this is the pattern to follow. Do
not widen a policy to admit an unset `app.company_id`; unset is exactly the
unauthenticated case.

## Tests

`npm run test:portal` (needs a dev server and a migrated DB). Covers the feature
grant gate including the fail-closed default, client and tenant scoping, RLS on
all four tables added in 080, sign-in routing for both screens, and the invite
validate/activate/replay flow.

The RLS section self-skips when `DATABASE_URL` connects as a superuser or
`BYPASSRLS` role, since policies are unobservable from there. The app itself
refuses to start on such a role (`lib/db.ts`), so this only affects local runs
pointed at an admin connection.
