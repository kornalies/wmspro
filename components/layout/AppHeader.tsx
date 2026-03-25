"use client"

import { FormEvent, useMemo, useState } from "react"
import { LogOut, Moon, Search, Sun } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"

import { useAuth, useLogout, useSwitchCompany } from "@/hooks/use-auth"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TypeaheadInput } from "@/components/ui/typeahead-input"
import { handleError } from "@/lib/error-handler"
import { apiClient } from "@/lib/api-client"

type CompanyOption = {
  id: number
  company_code: string
  company_name: string
  is_active: boolean
}

export function AppHeader() {
  const router = useRouter()
  const pathname = usePathname()
  const { user } = useAuth()
  const logoutMutation = useLogout()
  const { theme, setTheme } = useTheme()
  const [globalSearch, setGlobalSearch] = useState("")
  const switchCompanyMutation = useSwitchCompany()
  const canSwitchCompany =
    user?.permissions?.includes("admin.companies.manage") || user?.role === "SUPER_ADMIN"
  const companiesQuery = useQuery({
    queryKey: ["auth", "companies"],
    queryFn: async () => {
      const res = await apiClient.get<CompanyOption[]>("/companies")
      return (res.data ?? []).filter((c) => c.is_active)
    },
    enabled: !!canSwitchCompany,
  })

  const onLogout = async () => {
    try {
      await logoutMutation.mutateAsync()
      router.replace("/login")
    } catch (error) {
      handleError(error, "Logout failed")
    }
  }

  const onCompanyChange = async (companyId: number) => {
    try {
      await switchCompanyMutation.mutateAsync(companyId)
      router.refresh()
    } catch (error) {
      handleError(error, "Failed to switch company")
    }
  }

  const crumbs = useMemo(() => {
    const segments = pathname.split("/").filter(Boolean)
    const build: Array<{ label: string; href: string }> = []
    let current = ""
    for (const part of segments) {
      current += `/${part}`
      const label = part
        .replace(/-/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
      build.push({ label, href: current })
    }
    return build
  }, [pathname])
  const globalSearchSuggestions = useMemo(
    () => ["GRN-", "DO-", "Serial", ...crumbs.map((crumb) => crumb.label)],
    [crumbs]
  )

  const handleGlobalSearch = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const term = globalSearch.trim()
    if (!term) return
    const upper = term.toUpperCase()
    if (upper.startsWith("GRN")) {
      router.push(`/grn?search=${encodeURIComponent(term)}`)
      return
    }
    if (upper.startsWith("DO")) {
      router.push(`/do?search=${encodeURIComponent(term)}`)
      return
    }
    router.push(`/stock/search?serial=${encodeURIComponent(term)}`)
  }

  return (
    <div className="flex min-h-16 flex-col gap-2 px-4 py-2 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">WMS - GWU Software Solutions</h2>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Home</span>
          {crumbs.map((crumb, index) => (
            <span key={crumb.href} className="flex items-center gap-2">
              <span>/</span>
              {index === crumbs.length - 1 ? (
                <span className="font-medium text-foreground">{crumb.label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => router.push(crumb.href)}
                  className="hover:text-foreground"
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={handleGlobalSearch} className="relative w-full min-w-[220px] md:w-[280px]">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <TypeaheadInput
            value={globalSearch}
            onValueChange={setGlobalSearch}
            suggestions={globalSearchSuggestions}
            placeholder="Search GRN / DO / Serial..."
            className="h-9 pl-8"
          />
        </form>
        <Badge variant="outline" className="font-mono text-xs">
          Company: {user?.company_code || "N/A"}
        </Badge>
        {canSwitchCompany && (
          <select
            className="h-9 rounded-md border px-2 text-sm"
            value={user?.company_id || ""}
            onChange={(e) => onCompanyChange(Number(e.target.value))}
            disabled={switchCompanyMutation.isPending || companiesQuery.isLoading}
          >
            {(companiesQuery.data ?? []).map((company) => (
              <option key={company.id} value={company.id}>
                {company.company_code} - {company.company_name}
              </option>
            ))}
          </select>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Toggle theme"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <span className="text-sm text-gray-600">{user?.full_name || user?.username || "User"}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onLogout}
          disabled={logoutMutation.isPending}
        >
          <LogOut className="h-4 w-4" />
          Logout
        </Button>
      </div>
    </div>
  )
}
