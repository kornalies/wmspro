"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { canAccessPath } from "@/lib/route-permissions"
import { useAuth } from "@/hooks/use-auth"

export function DashboardRouteGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const { user, isLoading, isAuthenticated } = useAuth()

  useEffect(() => {
    if (isLoading) return

    if (!isAuthenticated) {
      router.replace("/login")
      return
    }

    if (!canAccessPath(user, pathname)) {
      router.replace("/dashboard")
    }
  }, [isLoading, isAuthenticated, user, pathname, router])

  if (isLoading) return null
  if (!isAuthenticated) return null
  if (!canAccessPath(user, pathname)) return null

  return <>{children}</>
}
