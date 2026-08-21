/**
 * Client portal acceptance: client mapping, feature grants, tenant isolation,
 * and the invite activation flow.
 *
 * The portal is the one surface a customer's own staff log into, so its failure
 * modes are the expensive kind — one tenant's client seeing another's stock, or
 * a user provisioned with a mapping and no grants quietly receiving every
 * feature including billing. Both were live until migration 080; this suite is
 * what keeps them dead.
 *
 * Three layers get asserted separately, because they fail independently:
 *   - the API (does the route say 403 when it should),
 *   - row level security (does the database refuse the row even if a route
 *     forgets its WHERE clause),
 *   - the invite flow (which reads an RLS-protected table with no session at
 *     all, and is therefore the thing most likely to break when RLS lands).
 *
 * Requires a running dev server (npm run dev) and a migrated database.
 */

import process from "node:process"
import bcrypt from "bcryptjs"

import { BASE_URL, ensureChaosFixtures, login, withDb } from "./chaos/_shared.mjs"

const SUFFIX = Date.now().toString().slice(-9)
const PORTAL_PASSWORD = "Portal@12345"
const NEW_PASSWORD = "Portal@54321"

const USER_GRANTED = `portal_grant_${SUFFIX}`
const USER_UNGRANTED = `portal_nogrant_${SUFFIX}`
const USER_TENANT_B = `portal_demo_${SUFFIX}`
const USER_INVITEE = `portal_invitee_${SUFFIX}`
const USER_DISPUTER = `portal_disputer_${SUFFIX}`
const INVITE_TOKEN = `tok-${SUFFIX}-${"a".repeat(40)}`

let failures = 0
function check(label, condition, extra = "") {
  const status = condition ? "PASS" : "FAIL"
  console.log(`${status}  ${label}${extra ? ` :: ${extra}` : ""}`)
  if (!condition) failures++
}

function skip(label, why) {
  console.log(`SKIP  ${label} :: ${why}`)
}

async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

/**
 * Create a portal user, map it to one client, and grant it exactly the feature
 * keys given. Role CLIENT matters: ADMIN and SUPER_ADMIN short-circuit every
 * feature check, so an admin would pass this suite no matter what the grants
 * table said.
 */
/**
 * Give one fixture user real RBAC permissions.
 *
 * The portal's write routes need BOTH a portal feature grant and an RBAC
 * permission (see app/api/portal/disputes/route.ts). Feature grants live in
 * portal_user_permissions; RBAC lives in rbac_user_roles -> rbac_role_permissions,
 * and the two are entirely separate stores.
 *
 * A dedicated role is created rather than extending the shared CLIENT role:
 * granting a permission to CLIENT would change what every client of every tenant
 * on this database may do, which is not a test's business.
 *
 * The permission ROWS are upserted too, not just looked up, and that is not
 * belt-and-braces. Migration 030 inserts them -- but CI does not run it: it
 * restores db/baseline/schema.sql and stamps migrations 001-068 as already
 * applied, so only a PR's new migrations execute. The baseline carries the
 * SCHEMA of rbac_permissions and none of its ROWS, so on CI that table is empty
 * however many times 030 "ran".
 *
 * A lookup against an empty table quietly matches nothing, producing a role with
 * no permissions and a 403 indistinguishable from a real authorisation failure.
 * That is exactly how this passed locally and failed in CI. Hence the assertion
 * below: the linkage is checked rather than assumed.
 */
async function grantRbacPermissions(db, userId, permissionKeys) {
  const roleCode = `PORTAL_TEST_${SUFFIX}`
  const role = await db.query(
    `INSERT INTO rbac_roles (role_code, role_name, is_active)
     VALUES ($1, 'Portal test role', true)
     ON CONFLICT (role_code) DO UPDATE SET is_active = true
     RETURNING id`,
    [roleCode]
  )
  const roleId = Number(role.rows[0].id)

  await db.query(
    `INSERT INTO rbac_permissions (permission_key, permission_name, is_active)
     SELECT x.key, x.key, true FROM UNNEST($1::text[]) AS x(key)
     ON CONFLICT (permission_key) DO UPDATE SET is_active = true`,
    [permissionKeys]
  )

  const linked = await db.query(
    `INSERT INTO rbac_role_permissions (role_id, permission_id)
     SELECT $1, p.id FROM rbac_permissions p WHERE p.permission_key = ANY($2::text[])
     ON CONFLICT DO NOTHING
     RETURNING permission_id`,
    [roleId, permissionKeys]
  )
  // Assert the link rather than trusting it: this is the step whose silent
  // no-op produced the misleading 403.
  check(
    "the test role received every permission it asked for",
    linked.rows.length === permissionKeys.length,
    `linked=${linked.rows.length} of ${permissionKeys.length}`
  )
  await db.query(
    `INSERT INTO rbac_user_roles (user_id, role_id, is_primary)
     VALUES ($1, $2, false)
     ON CONFLICT DO NOTHING`,
    [userId, roleId]
  )
  return roleId
}

async function seedPortalUser(db, { companyId, username, clientId, features }) {
  // Session scope, not transaction scope: withDb hands out a bare connection in
  // autocommit, where a transaction-local setting is discarded the instant the
  // statement that set it commits.
  await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
  const passwordHash = await bcrypt.hash(PORTAL_PASSWORD, 10)
  const user = await db.query(
    `INSERT INTO users (company_id, username, email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, 'CLIENT', $5, true)
     ON CONFLICT (company_id, username)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true
     RETURNING id`,
    [companyId, username, `${username}@example.test`, `Portal ${username}`, passwordHash]
  )
  const userId = Number(user.rows[0].id)

  if (clientId) {
    await db.query(
      `INSERT INTO portal_user_clients (company_id, user_id, client_id, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (company_id, user_id, client_id) DO UPDATE SET is_active = true`,
      [companyId, userId, clientId]
    )
  }

  await db.query(
    `DELETE FROM portal_user_permissions WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId]
  )
  if (features.length > 0) {
    await db.query(
      `INSERT INTO portal_user_permissions (company_id, user_id, feature_key, is_allowed)
       SELECT $1, $2, x.feature_key, true
       FROM UNNEST($3::text[]) AS x(feature_key)`,
      [companyId, userId, features]
    )
  }
  return userId
}

/**
 * RLS only proves something if the connection is subject to it. A superuser or
 * BYPASSRLS role sails through every policy, so running these checks under one
 * would print a screen of PASS that means nothing at all.
 */
async function isSubjectToRls(db) {
  const res = await db.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
  )
  const row = res.rows[0]
  return Boolean(row) && !row.rolsuper && !row.rolbypassrls
}

async function setupFixtures(fixtures) {
  return withDb(async (db) => {
    const companyA = fixtures.tenantA.companyId
    const companyB = fixtures.tenantB.companyId
    const clientA = fixtures.ids.a.clientId

    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyB)])
    const clientBRes = await db.query(
      `SELECT id FROM clients WHERE company_id = $1 ORDER BY id LIMIT 1`,
      [companyB]
    )
    const clientB = Number(clientBRes.rows[0]?.id || 0)
    if (!clientB) throw new Error("Tenant B fixture has no client to map")

    // Granted: inventory only. The narrow grant is the point -- it proves the
    // check reads the row rather than just noticing that some row exists.
    const grantedId = await seedPortalUser(db, {
      companyId: companyA,
      username: USER_GRANTED,
      clientId: clientA,
      features: ["portal.inventory.view"],
    })

    // Ungranted: mapped to the same client, zero feature rows. This is the user
    // that used to see everything.
    const ungrantedId = await seedPortalUser(db, {
      companyId: companyA,
      username: USER_UNGRANTED,
      clientId: clientA,
      features: [],
    })

    const tenantBId = await seedPortalUser(db, {
      companyId: companyB,
      username: USER_TENANT_B,
      clientId: clientB,
      features: ["portal.inventory.view"],
    })

    // Holds the full dispute set, so the conversation can be exercised end to
    // end rather than only at its gates.
    const disputerId = await seedPortalUser(db, {
      companyId: companyA,
      username: USER_DISPUTER,
      clientId: clientA,
      features: [
        "portal.billing.view",
        "portal.dispute.view",
        "portal.dispute.create",
        "portal.dispute.manage",
      ],
    })

    await grantRbacPermissions(db, disputerId, [
      "billing.view",
      "portal.billing.view",
      "portal.dispute.create",
      "portal.dispute.manage",
    ])

    const inviteeId = await seedPortalUser(db, {
      companyId: companyA,
      username: USER_INVITEE,
      clientId: clientA,
      features: ["portal.inventory.view"],
    })

    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyA)])

    // An invoice of tenant A's own, so the dispute conversation has something to
    // hang off. Reused if one already exists: invoice_header carries a unique
    // constraint on (company, client, period), so a fresh insert on every run
    // collides with whatever the previous run or another fixture left behind.
    //
    // Looked up FIRST and seeded only as a fallback, then asserted rather than
    // skipped -- a fixture lookup that comes back empty turns the conversation
    // test into a SKIP, and a skip reads exactly like a pass in a CI log.
    const existingInvoice = await db.query(
      `SELECT id FROM invoice_header
       WHERE company_id = $1 AND client_id = $2 AND COALESCE(status, '') <> 'VOID'
       ORDER BY id DESC LIMIT 1`,
      [companyA, clientA]
    )
    let invoiceId = Number(existingInvoice.rows[0]?.id || 0)
    if (!invoiceId) {
      // A period well clear of the current billing cycle, and deliberately in
      // the PAST -- fixtures parked in the far future outlive the test that made
      // them and turn up in real reports.
      const seeded = await db.query(
        `INSERT INTO invoice_header (
           company_id, invoice_number, client_id, period_from, period_to,
           invoice_date, due_date, status, grand_total, paid_amount, balance_amount
         ) VALUES (
           $1, $2, $3,
           CURRENT_DATE - INTERVAL '400 days', CURRENT_DATE - INTERVAL '370 days',
           CURRENT_DATE - INTERVAL '370 days', CURRENT_DATE - INTERVAL '355 days',
           'SENT', 1000, 0, 1000
         )
         RETURNING id`,
        [companyA, `INV-PORTALTEST-${SUFFIX}`, clientA]
      )
      invoiceId = Number(seeded.rows[0]?.id || 0)
    }

    await db.query(
      `INSERT INTO portal_user_invites (company_id, user_id, invite_token, status, expires_at, invited_by)
       VALUES ($1, $2, $3, 'PENDING', NOW() + INTERVAL '2 hours', $2)
       ON CONFLICT (company_id, invite_token)
       DO UPDATE SET status = 'PENDING', expires_at = NOW() + INTERVAL '2 hours', accepted_at = NULL`,
      [companyA, inviteeId, INVITE_TOKEN]
    )

    return {
      companyA,
      companyB,
      clientA,
      clientB,
      grantedId,
      ungrantedId,
      tenantBId,
      inviteeId,
      disputerId,
      invoiceId,
    }
  })
}

async function testFeatureGrants(ids, fixtures) {
  const grantedToken = await login(fixtures.tenantA.code, USER_GRANTED, PORTAL_PASSWORD)
  const ungrantedToken = await login(fixtures.tenantA.code, USER_UNGRANTED, PORTAL_PASSWORD)

  const grantedInventory = await api(`/portal/inventory?client_id=${ids.clientA}`, { token: grantedToken })
  check("granted user reaches its one granted feature", grantedInventory.status === 200, `status=${grantedInventory.status}`)

  for (const [path, label] of [
    [`/portal/billing?client_id=${ids.clientA}`, "billing"],
    [`/portal/orders?client_id=${ids.clientA}`, "orders"],
    [`/portal/reports?client_id=${ids.clientA}`, "reports"],
  ]) {
    const res = await api(path, { token: grantedToken })
    check(`granted user is refused ${label} it was not granted`, res.status === 403, `status=${res.status}`)
  }

  // The regression this suite exists for: no rows used to mean unrestricted.
  for (const [path, label] of [
    [`/portal/inventory?client_id=${ids.clientA}`, "inventory"],
    [`/portal/billing?client_id=${ids.clientA}`, "billing"],
    [`/portal/orders?client_id=${ids.clientA}`, "orders"],
    [`/portal/reports?client_id=${ids.clientA}`, "reports"],
    [`/portal/asn?client_id=${ids.clientA}`, "asn"],
  ]) {
    const res = await api(path, { token: ungrantedToken })
    check(`user with no grants is refused ${label}`, res.status === 403, `status=${res.status}`)
  }

  const features = await api("/portal/features", { token: ungrantedToken })
  const allowed = features.json?.data?.allowed
  check(
    "features endpoint reports nothing allowed for a user with no grants",
    Array.isArray(allowed) && allowed.length === 0,
    `allowed=${JSON.stringify(allowed)}`
  )

  const grantedFeatures = await api("/portal/features", { token: grantedToken })
  const grantedAllowed = grantedFeatures.json?.data?.allowed || []
  check(
    "features endpoint reports exactly the granted key",
    grantedAllowed.length === 1 && grantedAllowed[0] === "portal.inventory.view",
    `allowed=${JSON.stringify(grantedAllowed)}`
  )

  return grantedToken
}

async function testClientScoping(ids, fixtures, grantedToken) {
  const crossClient = await api(`/portal/inventory?client_id=${ids.clientB}`, { token: grantedToken })
  check(
    "portal user cannot name another tenant's client id",
    crossClient.status === 403,
    `status=${crossClient.status}`
  )

  const clients = await api("/portal/clients", { token: grantedToken })
  const returnedIds = (clients.json?.data || []).map((row) => Number(row.id))
  check(
    "clients list returns only the mapped client",
    returnedIds.length === 1 && returnedIds[0] === ids.clientA,
    `ids=${JSON.stringify(returnedIds)}`
  )

  const tenantBToken = await login(fixtures.tenantB.code, USER_TENANT_B, PORTAL_PASSWORD)
  const reachAcross = await api(`/portal/inventory?client_id=${ids.clientA}`, { token: tenantBToken })
  check(
    "tenant B portal user cannot read tenant A's client",
    reachAcross.status === 403,
    `status=${reachAcross.status}`
  )
}

/**
 * The routes added for order detail, the finance documents and the dispute
 * thread. Each one takes an id in its path, which is a new way to name a record
 * the caller may not own -- the feature grant only proves they may read THIS
 * client, never that the record belongs to it.
 */
async function testDetailRouteScoping(ids, fixtures, grantedToken) {
  const ungrantedToken = await login(fixtures.tenantA.code, USER_UNGRANTED, PORTAL_PASSWORD)

  // The granted user holds portal.inventory.view and nothing else, so every one
  // of these must refuse on the feature gate before ownership is even reached.
  for (const [path, label] of [
    [`/portal/orders/1?client_id=${ids.clientA}`, "order detail"],
    [`/portal/documents/commercial-invoice/1?client_id=${ids.clientA}`, "invoice document"],
    [`/portal/documents/client-statement/${ids.clientA}?client_id=${ids.clientA}`, "statement"],
    [`/portal/disputes/1?client_id=${ids.clientA}`, "dispute thread"],
  ]) {
    const res = await api(path, { token: grantedToken })
    check(`${label} is refused without its feature grant`, res.status === 403, `status=${res.status}`)
    const bare = await api(path, { token: ungrantedToken })
    check(`${label} is refused for a user with no grants`, bare.status === 403, `status=${bare.status}`)
  }

  // Naming another tenant's client must fail on the client gate, whatever the
  // record id says.
  for (const [path, label] of [
    [`/portal/orders/1?client_id=${ids.clientB}`, "order detail"],
    [`/portal/documents/commercial-invoice/1?client_id=${ids.clientB}`, "invoice document"],
    [`/portal/disputes/1?client_id=${ids.clientB}`, "dispute thread"],
  ]) {
    const res = await api(path, { token: grantedToken })
    check(`${label} refuses another tenant's client id`, res.status === 403, `status=${res.status}`)
  }

  // A statement is keyed on the client itself, so its subject must BE the client
  // in scope -- otherwise the path id would choose whose statement to print.
  const foreignStatement = await api(
    `/portal/documents/client-statement/${ids.clientB}?client_id=${ids.clientA}`,
    { token: grantedToken }
  )
  check(
    "a statement cannot be printed for a client other than the one in scope",
    foreignStatement.status === 403,
    `status=${foreignStatement.status}`
  )

  // The operating paperwork is not the client's to read, whatever they hold.
  const pickList = await api(`/portal/documents/pick-list/1?client_id=${ids.clientA}`, {
    token: grantedToken,
  })
  check(
    "warehouse-internal document types are not served by the portal at all",
    pickList.status === 400,
    `status=${pickList.status}`
  )
}

/**
 * The dispute conversation, end to end.
 *
 * This exists because the write half was broken from the day it shipped and
 * nothing noticed. The UPDATE bound $1 both to the varchar `status` column and
 * against untyped string literals in an IN list, so Postgres refused the whole
 * statement with "inconsistent types deduced for parameter $1" -- every comment
 * and every status change returned a 400, and portal_invoice_dispute_events was
 * empty in every environment.
 *
 * A gate-only test would not have caught it: all the 403s were correct. The
 * assertion that matters is that a reply SURVIVES, so this posts one and reads
 * it back.
 */
async function testDisputeConversation(ids, fixtures) {
  const token = await login(fixtures.tenantA.code, USER_DISPUTER, PORTAL_PASSWORD)

  // The seeded invoice, not "whatever the billing list happens to return first".
  check("the seeded invoice exists to dispute", ids.invoiceId > 0, `invoiceId=${ids.invoiceId}`)
  if (!ids.invoiceId) return

  const created = await api("/portal/disputes", {
    token,
    method: "POST",
    body: {
      client_id: ids.clientA,
      invoice_id: ids.invoiceId,
      dispute_reason: "Storage was billed for 31 days but the stock left on the 12th.",
      category: "BILLING_AMOUNT",
      priority: "MEDIUM",
    },
  })
  check("a dispute can be raised", created.status === 200, `status=${created.status}`)
  const disputeId = created.json?.data?.id
  if (!disputeId) {
    check("dispute id returned", false, JSON.stringify(created.json))
    return
  }

  const commented = await api(`/portal/disputes/${disputeId}`, {
    token,
    method: "PUT",
    body: { client_id: ids.clientA, comment: "Adding the delivery note as evidence." },
  })
  check("a comment on a dispute is accepted", commented.status === 200, `status=${commented.status}`)

  const advanced = await api(`/portal/disputes/${disputeId}`, {
    token,
    method: "PUT",
    body: {
      client_id: ids.clientA,
      status: "UNDER_REVIEW",
      comment: "Passed to the billing team for recalculation.",
    },
  })
  check("a status change on a dispute is accepted", advanced.status === 200, `status=${advanced.status}`)

  const thread = await api(`/portal/disputes/${disputeId}?client_id=${ids.clientA}`, { token })
  const events = thread.json?.data?.events || []
  check("the thread reads back", thread.status === 200, `status=${thread.status}`)
  check(
    "every event written is readable -- created, comment and status change",
    events.length === 3 &&
      events.map((event) => event.event_type).join(",") === "CREATED,COMMENT,STATUS_CHANGE",
    `events=${JSON.stringify(events.map((event) => event.event_type))}`
  )
  check(
    "the dispute carries the new status",
    thread.json?.data?.status === "UNDER_REVIEW",
    `status=${thread.json?.data?.status}`
  )
  check(
    "the client's own messages are attributed to them",
    events.every((event) => event.author === "you"),
    `authors=${JSON.stringify(events.map((event) => event.author))}`
  )

  const foreign = await api(`/portal/disputes/${disputeId}?client_id=${ids.clientB}`, { token })
  check(
    "the thread refuses another tenant's client id",
    foreign.status === 403,
    `status=${foreign.status}`
  )
}

async function testRowLevelSecurity(ids) {
  await withDb(async (db) => {
    if (!(await isSubjectToRls(db))) {
      skip("row level security", "DATABASE_URL role is superuser or BYPASSRLS; policies cannot be observed")
      return
    }

    const tables = [
      "portal_user_clients",
      "portal_user_permissions",
      "portal_user_invites",
      "client_portal_asn_requests",
    ]

    for (const table of tables) {
      const enabled = await db.query(
        `SELECT relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE oid = $1::regclass`,
        [table]
      )
      const row = enabled.rows[0] || {}
      check(`${table} has RLS enabled and forced`, row.relrowsecurity === true && row.relforcerowsecurity === true)
    }

    // Scoped to tenant B: tenant A's mapping rows must be invisible.
    await db.query("SELECT set_config('app.company_id', $1, false)", [String(ids.companyB)])
    const leaked = await db.query(
      `SELECT COUNT(*)::int AS count FROM portal_user_clients WHERE company_id = $1`,
      [ids.companyA]
    )
    check(
      "portal_user_clients hides another tenant's rows",
      Number(leaked.rows[0].count) === 0,
      `count=${leaked.rows[0].count}`
    )

    const leakedPerms = await db.query(
      `SELECT COUNT(*)::int AS count FROM portal_user_permissions WHERE company_id = $1`,
      [ids.companyA]
    )
    check(
      "portal_user_permissions hides another tenant's rows",
      Number(leakedPerms.rows[0].count) === 0,
      `count=${leakedPerms.rows[0].count}`
    )

    // No context at all: the unauthenticated shape. Nothing should be readable,
    // and in particular the invite token window must stay shut.
    await db.query("SELECT set_config('app.company_id', '', false)")
    await db.query("SELECT set_config('app.portal_invite_token', '', false)")
    const noContext = await db.query(`SELECT COUNT(*)::int AS count FROM portal_user_invites`)
    check(
      "invites are unreadable with neither company nor token context",
      Number(noContext.rows[0].count) === 0,
      `count=${noContext.rows[0].count}`
    )

    // Presenting the token opens exactly one row, not the table.
    await db.query("SELECT set_config('app.portal_invite_token', $1, false)", [INVITE_TOKEN])
    const byToken = await db.query(`SELECT invite_token FROM portal_user_invites`)
    check(
      "invite token opens exactly its own row",
      byToken.rows.length === 1 && byToken.rows[0].invite_token === INVITE_TOKEN,
      `rows=${byToken.rows.length}`
    )
  })
}

async function testInviteFlow(fixtures) {
  const valid = await api(`/portal/invite/validate?token=${encodeURIComponent(INVITE_TOKEN)}`)
  check("pending invite validates without a session", valid.status === 200 && valid.json?.data?.valid === true, `status=${valid.status} body=${JSON.stringify(valid.json?.data)}`)

  const bogus = await api(`/portal/invite/validate?token=not-a-real-token-${SUFFIX}`)
  check("unknown invite token is not found", bogus.status === 404, `status=${bogus.status}`)

  const activated = await api("/portal/invite/activate", {
    method: "POST",
    body: { token: INVITE_TOKEN, password: NEW_PASSWORD },
  })
  check("invite activates", activated.status === 200, `status=${activated.status} body=${JSON.stringify(activated.json)}`)

  const revalidated = await api(`/portal/invite/validate?token=${encodeURIComponent(INVITE_TOKEN)}`)
  check(
    "activated invite no longer validates",
    revalidated.status === 200 && revalidated.json?.data?.valid === false && revalidated.json?.data?.status === "ACCEPTED",
    `body=${JSON.stringify(revalidated.json?.data)}`
  )

  const replay = await api("/portal/invite/activate", {
    method: "POST",
    body: { token: INVITE_TOKEN, password: NEW_PASSWORD },
  })
  check("activation cannot be replayed", replay.status === 400, `status=${replay.status}`)

  const token = await login(fixtures.tenantA.code, USER_INVITEE, NEW_PASSWORD)
  check("activated user can log in with the new password", Boolean(token))
}

/** Page routes live at the origin; BASE_URL points at the /api prefix. */
const ORIGIN = BASE_URL.replace(/\/api\/?$/, "")

async function page(path, { cookie } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  })
  return { status: res.status, location: res.headers.get("location") || "" }
}

/**
 * The proxy decides which of the two sign-in screens a visitor lands on, and it
 * decides it from the path alone. Two failures this guards against, both of
 * which were live:
 *
 *   - /portal/activate matched the proxy's /portal/:path* matcher with no
 *     exemption, so an invitee following a valid activation link was redirected
 *     to the staff login with their token stripped from the URL. The invite flow
 *     was unreachable by the only people meant to use it.
 *   - portal traffic redirected to /login, handing a client a screen about
 *     freight forwarding and a product toggle that would strand them.
 */
async function testSignInRouting(fixtures) {
  const portalRedirect = await page("/portal")
  check(
    "unauthenticated /portal goes to the portal login, not the staff login",
    portalRedirect.status === 307 && portalRedirect.location.includes("/portal/login?next=%2Fportal"),
    `status=${portalRedirect.status} location=${portalRedirect.location}`
  )

  const deepRedirect = await page("/portal/billing")
  check(
    "the attempted portal path survives as ?next",
    deepRedirect.location.includes("next=%2Fportal%2Fbilling"),
    `location=${deepRedirect.location}`
  )

  const staffRedirect = await page("/dashboard")
  check(
    "staff paths still go to the staff login",
    staffRedirect.status === 307 && staffRedirect.location.includes("/login?next=%2Fdashboard"),
    `location=${staffRedirect.location}`
  )

  const loginPage = await page("/portal/login")
  check("portal login is reachable without a session", loginPage.status === 200, `status=${loginPage.status}`)

  const activatePage = await page(`/portal/activate?token=${encodeURIComponent(INVITE_TOKEN)}`)
  check(
    "activation link is reachable without a session",
    activatePage.status === 200,
    `status=${activatePage.status} location=${activatePage.location}`
  )

  // Signed in, the sign-in screen should step out of the way.
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company_code: fixtures.tenantA.code,
      username: USER_GRANTED,
      password: PORTAL_PASSWORD,
      requested_product: "WMS",
    }),
  })
  const setCookie = loginRes.headers.get("set-cookie") || ""
  const tokenCookie = /(^|,\s*)token=([^;]+)/.exec(setCookie)
  if (!tokenCookie) {
    check("web login issues a session cookie", false, `set-cookie=${setCookie.slice(0, 120)}`)
    return
  }

  const signedIn = await page("/portal/login", { cookie: `token=${tokenCookie[2]}` })
  check(
    "a signed-in visitor is sent past the portal login",
    signedIn.status === 307 && signedIn.location.endsWith("/portal"),
    `status=${signedIn.status} location=${signedIn.location}`
  )
}

async function cleanup(ids) {
  await withDb(async (db) => {
    for (const companyId of [ids.companyA, ids.companyB]) {
      await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyId)])
      const userIds = [ids.grantedId, ids.ungrantedId, ids.tenantBId, ids.inviteeId]
      // Signing in over the web route writes an audit row pointing at the user,
      // and audit_logs_actor_user_fk blocks the delete. These are throwaway
      // fixture accounts, so their audit trail goes with them.
      await db.query(`DELETE FROM audit_logs WHERE company_id = $1 AND actor_user_id = ANY($2::int[])`, [companyId, userIds])
      await db.query(`DELETE FROM portal_user_invites WHERE company_id = $1 AND user_id = ANY($2::int[])`, [companyId, userIds])
      await db.query(`DELETE FROM portal_user_permissions WHERE company_id = $1 AND user_id = ANY($2::int[])`, [companyId, userIds])
      await db.query(`DELETE FROM portal_user_clients WHERE company_id = $1 AND user_id = ANY($2::int[])`, [companyId, userIds])
      await db.query(`DELETE FROM users WHERE company_id = $1 AND id = ANY($2::int[])`, [companyId, userIds])
    }
  })
}

async function run() {
  const fixtures = await ensureChaosFixtures()
  const ids = await setupFixtures(fixtures)
  try {
    const grantedToken = await testFeatureGrants(ids, fixtures)
    await testClientScoping(ids, fixtures, grantedToken)
  await testDetailRouteScoping(ids, fixtures, grantedToken)
  await testDisputeConversation(ids, fixtures)
    await testRowLevelSecurity(ids)
    await testSignInRouting(fixtures)
    await testInviteFlow(fixtures)
  } finally {
    await cleanup(ids)
  }

  if (failures > 0) {
    console.error(`\n${failures} portal check(s) failed`)
    process.exit(1)
  }
  console.log("\nAll portal checks passed.")
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
