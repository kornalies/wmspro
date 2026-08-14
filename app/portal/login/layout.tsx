import type { Metadata } from "next"

// See app/(portal)/layout.tsx — the sign-in page sits outside that route group,
// so it needs its own title rather than inheriting the root "GWU WMS" one.
export const metadata: Metadata = {
  title: "Sign in | Client Portal",
  description: "Sign in to your client portal account.",
}

export default function PortalLoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
