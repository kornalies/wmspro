import type { Metadata } from "next"

/**
 * Metadata only — it renders its children untouched.
 *
 * It exists because the root layout titles every page "GWU WMS | GWU Tech",
 * which is the internal product name. A client signing in to check their own
 * stock should not have the 3PL's warehouse software named in their browser tab,
 * their history, or their bookmarks.
 */
export const metadata: Metadata = {
  title: "Client Portal | GWU Tech",
  description: "Track your inventory, delivery orders, and invoices with your warehouse provider.",
}

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children
}
