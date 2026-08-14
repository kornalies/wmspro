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

    const inviteeId = await seedPortalUser(db, {
      companyId: companyA,
      username: USER_INVITEE,
      clientId: clientA,
      features: ["portal.inventory.view"],
    })

    await db.query("SELECT set_config('app.company_id', $1, false)", [String(companyA)])
    await db.query(
      `INSERT INTO portal_user_invites (company_id, user_id, invite_token, status, expires_at, invited_by)
       VALUES ($1, $2, $3, 'PENDING', NOW() + INTERVAL '2 hours', $2)
       ON CONFLICT (company_id, invite_token)
       DO UPDATE SET status = 'PENDING', expires_at = NOW() + INTERVAL '2 hours', accepted_at = NULL`,
      [companyA, inviteeId, INVITE_TOKEN]
    )

    return { companyA, companyB, clientA, clientB, grantedId, ungrantedId, tenantBId, inviteeId }
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
