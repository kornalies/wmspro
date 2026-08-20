"use client"

/**
 * The portal's single source of truth for "who am I looking at, and what may I see".
 *
 * Every portal screen used to answer both questions for itself: six copies of the
 * same two fetches (`/api/v1/policy`, `/api/portal/clients`), six client dropdowns,
 * and six lines of `loadedClients[0]?.id ?? null`. That last line is the reason this
 * module exists. A user mapped to more than one client would pick C0002 on the
 * dashboard, click through to Billing, and land on C0001's invoices -- because the
 * new screen had no idea a choice had been made and defaulted to the first row.
 * Nothing leaked past the access gates, but the client on screen was not the client
 * the user asked for, which is its own kind of wrong.
 *
 * The selection now lives in the URL (`?client=C0002`), so it survives navigation, a
 * refresh, a bookmark, and a link pasted into an email. localStorage backs it up for
 * a bare visit to /portal. The URL wins when both are present: an explicit link
 * should never be overridden by what the browser happens to remember.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

import {
  resolvePortalAccess,
  resolvePortalClient,
  type PortalSection,
} from "@/lib/portal-access"

export type PortalClient = {
  id: number
  client_code: string
  client_name: string
}

type PortalPolicy = {
  features?: Record<string, boolean>
  permissions?: string[]
  branding?: {
    logoUrl?: string
    labels?: Record<string, string>
  }
}

/** The sections the nav can offer. Keyed so screens and nav cannot disagree. */
export type { PortalSection } from "@/lib/portal-access"

type PortalScopeValue = {
  /** True until clients, policy and feature grants have all landed. */
  loading: boolean
  /** Non-empty only when the portal itself failed to load. */
  error: string
  clients: PortalClient[]
  client: PortalClient | null
  selectClient: (clientCode: string) => void
  policy: PortalPolicy | null
  /** Tenant-level product switch. False means every section is off. */
  portalEnabled: boolean
  /** What this user may reach, gates already combined. */
  can: Record<PortalSection, boolean>
  /** Write grants, which a view grant never implies. */
  canCreateAsn: boolean
  canCreateDispute: boolean
  canManageSla: boolean
  canActOnInvoice: boolean
  /** Tenant wording for delivery orders, e.g. "SO". */
  doLabel: string
  branding: PortalPolicy["branding"]
  reload: () => void
}

const PortalScopeContext = createContext<PortalScopeValue | null>(null)

const STORAGE_KEY = "portal.client_code"

export function usePortalScope(): PortalScopeValue {
  const value = useContext(PortalScopeContext)
  if (!value) {
    throw new Error("usePortalScope must be used inside <PortalScopeProvider>")
  }
  return value
}

/**
 * Convenience for a screen that cannot render without a client: returns the id or
 * null, so callers keep the `if (!clientId) return` guard they already had.
 */
export function usePortalClientId(): number | null {
  return usePortalScope().client?.id ?? null
}

export function PortalScopeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const requestedCode = searchParams.get("client")

  const [clients, setClients] = useState<PortalClient[]>([])
  const [policy, setPolicy] = useState<PortalPolicy | null>(null)
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError("")
      try {
        // Three independent reads; serialising them cost the portal a visible
        // beat on every screen it was duplicated on.
        const [policyRes, clientsRes, featureRes] = await Promise.all([
          fetch("/api/v1/policy", { cache: "no-store" }),
          fetch("/api/portal/clients", { cache: "no-store" }),
          fetch("/api/portal/features", { cache: "no-store" }),
        ])
        const [policyJson, clientsJson, featureJson] = await Promise.all([
          policyRes.json(),
          clientsRes.json(),
          featureRes.json(),
        ])
        if (cancelled) return

        setPolicy((policyJson?.data || null) as PortalPolicy | null)
        setClients((clientsJson?.data || []) as PortalClient[])
        setFeatures((featureJson?.data?.features || null) as Record<string, boolean> | null)
      } catch {
        if (!cancelled) setError("We could not load your workspace. Check your connection and try again.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  /**
   * URL first, then the remembered choice, then the first client. A code that is
   * no longer mapped to this user falls through rather than resolving to nothing:
   * a stale bookmark should show the user's own data, not an empty screen.
   */
  const client = useMemo(() => {
    const remembered = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY)
    return resolvePortalClient(clients, requestedCode, remembered)
  }, [clients, requestedCode])

  // Remember the resolved client, not the requested one, so an unmapped code in a
  // stale link never gets written back as the user's preference.
  useEffect(() => {
    if (client) window.localStorage.setItem(STORAGE_KEY, client.client_code)
  }, [client])

  /**
   * Reflect the resolved client back into the URL when it was absent or unmapped,
   * so what the user copies out of the address bar is what they are looking at.
   * `replace` rather than `push`: this is a correction, not a navigation the back
   * button should have to walk through.
   */
  useEffect(() => {
    if (!client) return
    if (requestedCode && requestedCode.toLowerCase() === client.client_code.toLowerCase()) return
    const params = new URLSearchParams(searchParams.toString())
    params.set("client", client.client_code)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [client, pathname, requestedCode, router, searchParams])

  const selectClient = useCallback(
    (clientCode: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set("client", clientCode)
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  /**
   * The gate combination itself lives in lib/portal-access, not here, so it can be
   * tested without mounting React. See tests/portal-access.mjs -- these are the
   * decisions that determine whether the UI offers a control the API will refuse.
   */
  const value = useMemo<PortalScopeValue>(() => {
    const access = resolvePortalAccess({
      features: policy?.features || {},
      permissions: policy?.permissions || [],
      grants: features,
    })

    return {
      loading,
      error,
      clients,
      client: client ?? null,
      selectClient,
      policy,
      ...access,
      doLabel: policy?.branding?.labels?.do || "DO",
      branding: policy?.branding,
      reload: () => setReloadToken((n) => n + 1),
    }
  }, [client, clients, error, features, loading, policy, selectClient])

  return <PortalScopeContext.Provider value={value}>{children}</PortalScopeContext.Provider>
}
