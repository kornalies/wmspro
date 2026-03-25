import { Sidebar } from "@/components/layout/Sidebar"
import { AppHeader } from "@/components/layout/AppHeader"
import { DashboardRouteGuard } from "@/components/layout/DashboardRouteGuard"

export default function AppDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen bg-slate-50/60 dark:bg-slate-950">
      <div className="elevated-surface z-50 hidden md:fixed md:inset-y-0 md:flex md:w-72 md:flex-col md:overflow-y-auto">
        <Sidebar />
      </div>

      <main className="flex-1 md:pl-72">
        <div className="elevated-surface sticky top-0 z-40 border-b bg-white/90 backdrop-blur dark:bg-slate-950/90">
          <AppHeader />
        </div>

        <div className="p-4 md:p-8">
          <DashboardRouteGuard>{children}</DashboardRouteGuard>
        </div>
      </main>
    </div>
  )
}
