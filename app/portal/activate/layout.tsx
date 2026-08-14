import type { Metadata } from "next"

// See app/(portal)/layout.tsx.
export const metadata: Metadata = {
  title: "Activate your account | Client Portal",
  description: "Set your password and activate your client portal account.",
}

export default function PortalActivateLayout({ children }: { children: React.ReactNode }) {
  return children
}
