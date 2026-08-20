import { Suspense } from "react"
import type { Metadata } from "next"

import { PortalScopeProvider } from "@/components/portal/portal-scope"
import { PortalShell } from "@/components/portal/PortalShell"

/**
 * The portal's frame: metadata, the client scope, and the shell around it.
 *
 * The title override exists because the root layout names every page "GWU WMS |
 * GWU Tech", which is the internal product name. A client signing in to check
 * their own stock should not have the 3PL's warehouse software named in their
 * browser tab, their history, or their bookmarks.
 *
 * The sign-in and invite-activation screens are deliberately NOT in this route
 * group (they live at app/portal/login and app/portal/activate) -- they run before
 * a session exists, so the scope provider's fetches would 401 and the shell would
 * frame a login form with a client switcher.
 */
export const metadata: Metadata = {
  title: "Client Portal | GWU Tech",
  description: "Track your inventory, delivery orders, and invoices with your warehouse provider.",
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    // The provider reads the selected client from the query string, and
    // useSearchParams opts its subtree out of prerendering unless it sits behind a
    // Suspense boundary. Without this the whole portal fails the production build.
    <Suspense fallback={<div className="min-h-screen bg-neutral-50" />}>
      <PortalScopeProvider>
        <PortalShell>{children}</PortalShell>
      </PortalScopeProvider>
    </Suspense>
  )
}
