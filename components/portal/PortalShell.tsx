"use client"

/**
 * The frame every portal screen renders inside.
 *
 * Before this, the portal was six pages that happened to share a URL prefix: each
 * drew its own client dropdown, its own heading, and a "Back to Portal" link -- so
 * moving between sections felt like leaving the portal and coming back rather than
 * staying inside it. The client switcher, the notification bell and the account
 * controls now live here, once, and a screen renders only its own content.
 *
 * Sections the user cannot reach are absent from the nav rather than rendered and
 * refused. The screens still check for themselves; hiding a link is presentation,
 * never a substitute for a gate.
 */

import { usePathname, useRouter } from "next/navigation"
import Link from "next/link"

import { useLogout } from "@/hooks/use-auth"
import { PORTAL_LOGIN_PATH } from "@/lib/sign-in-path"
import { PortalBell } from "@/components/portal/PortalBell"
import { usePortalScope, type PortalSection } from "@/components/portal/portal-scope"

type NavItem = { section: PortalSection; href: string; label: string }

export function PortalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const logoutMutation = useLogout()
  const { clients, client, selectClient, can, doLabel, branding, loading, error, reload } = usePortalScope()

  // Ordered to follow the goods: what you hold, what is coming in, what is going
  // out, what it costs, then the exception screens.
  const allNavItems: NavItem[] = [
    { section: "overview", href: "/portal", label: "Overview" },
    { section: "inventory", href: "/portal/inventory", label: "Inventory" },
    { section: "shipments", href: "/portal/asn", label: "Shipments" },
    { section: "orders", href: "/portal/orders", label: `${doLabel} Orders` },
    { section: "billing", href: "/portal/billing", label: "Billing" },
    { section: "disputes", href: "/portal/disputes", label: "Disputes" },
    { section: "performance", href: "/portal/sla", label: "Performance" },
    { section: "reports", href: "/portal/reports", label: "Reports" },
  ]
  const navItems = allNavItems.filter((item) => can[item.section])

  // "/portal" would otherwise match every section, since they all start with it.
  const isCurrent = (href: string) => (href === "/portal" ? pathname === "/portal" : pathname.startsWith(href))

  // Nav links must carry the client scope, or clicking one silently reverts the
  // switcher to whatever the next screen resolves on its own.
  const withClient = (href: string) => (client ? `${href}?client=${encodeURIComponent(client.client_code)}` : href)

  async function logoutPortalUser() {
    try {
      await logoutMutation.mutateAsync()
    } finally {
      router.push(PORTAL_LOGIN_PATH)
      router.refresh()
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 md:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {branding?.logoUrl ? (
              // A tenant-supplied absolute URL, which next/image would only accept
              // behind a configured remote pattern. Decorative: the client's name
              // sits right beside it, so alt="" is correct rather than lazy.
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={branding.logoUrl} alt="" className="h-9 w-9 shrink-0 rounded-lg object-contain" />
            ) : (
              <div
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-sm font-semibold text-blue-800"
              >
                {client?.client_name?.slice(0, 1)?.toUpperCase() || "C"}
              </div>
            )}

            <div className="min-w-0">
              {clients.length > 1 ? (
                <>
                  <label htmlFor="portal-client-switcher" className="sr-only">
                    Switch client
                  </label>
                  <select
                    id="portal-client-switcher"
                    value={client?.client_code ?? ""}
                    onChange={(event) => selectClient(event.target.value)}
                    className="max-w-full truncate rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm font-semibold text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                  >
                    {clients.map((option) => (
                      <option key={option.id} value={option.client_code}>
                        {option.client_name}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className="truncate text-sm font-semibold text-neutral-900">
                  {client?.client_name || "Client Portal"}
                </p>
              )}
              <p className="truncate text-xs text-neutral-500">
                {client?.client_code ? `${client.client_code} · Client Portal` : "Client Portal"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <PortalBell />
            <a
              href="mailto:support@gwusoftware.com?subject=Client%20Portal%20Support"
              className="hidden rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 sm:inline-block"
            >
              Support
            </a>
            <button
              type="button"
              onClick={logoutPortalUser}
              disabled={logoutMutation.isPending}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {logoutMutation.isPending ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </div>

        {navItems.length > 0 ? (
          <nav aria-label="Portal sections" className="mx-auto max-w-6xl overflow-x-auto px-4 md:px-6">
            <ul className="flex min-w-max items-center gap-1">
              {navItems.map((item) => {
                const current = isCurrent(item.href)
                return (
                  <li key={item.href}>
                    <Link
                      href={withClient(item.href)}
                      aria-current={current ? "page" : undefined}
                      // Underline rather than a filled pill: eight pills read as
                      // eight buttons, and only one of them is where you are.
                      className={`-mb-px inline-block border-b-2 px-3 py-2.5 text-sm transition ${
                        current
                          ? "border-blue-700 font-semibold text-blue-800"
                          : "border-transparent font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </nav>
        ) : null}
      </header>

      <main className="mx-auto max-w-6xl p-4 md:p-6">
        {error ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">{error}</p>
            <button
              type="button"
              onClick={reload}
              className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              Try again
            </button>
          </div>
        ) : null}

        {!loading && !error && clients.length === 0 ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            No client is assigned to your account yet. Ask your warehouse provider to map you to a client,
            then sign in again.
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  )
}
