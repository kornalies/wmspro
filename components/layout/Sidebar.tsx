'use client'

import { useMemo, useState, type ComponentType } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { useAuth } from '@/hooks/use-auth'
import { canAccessPermissions, getRequiredPermissionsForPath } from '@/lib/route-permissions'
import {
    LayoutDashboard,
    PackagePlus,
    PackageMinus,
    Search,
    DoorOpen,
    DoorClosed,
    Users,
    Package,
    Warehouse,
    Receipt,
    BarChart3,
    ClipboardCheck,
    Rows3,
    ArrowLeftRight,
    History,
    Building2,
    FileText,
    Rocket,
    Settings2,
    ShieldCheck,
    Gauge,
    Cable,
    Bot,
    ChevronDown,
    ChevronRight,
} from 'lucide-react'

type SidebarRoute = {
    label: string
    icon: ComponentType<{ className?: string }>
    href: string
    color: string
}

type SidebarSection = {
    id: string
    title: string
    defaultCollapsed?: boolean
    routes: SidebarRoute[]
}

const sections: SidebarSection[] = [
    {
        id: 'overview',
        title: 'Overview',
        routes: [
            {
                label: 'Dashboard',
                icon: LayoutDashboard,
                href: '/dashboard',
                color: 'text-sky-500',
            },
            {
                label: 'Reports',
                icon: BarChart3,
                href: '/reports',
                color: 'text-yellow-500',
            },
        ],
    },
    {
        id: 'operations',
        title: 'Operations',
        routes: [
            {
                label: 'GRN Entry',
                icon: PackagePlus,
                href: '/grn',
                color: 'text-violet-500',
            },
            {
                label: 'Mobile GRN Approval',
                icon: ClipboardCheck,
                href: '/grn/mobile-approvals',
                color: 'text-fuchsia-500',
            },
            {
                label: 'DO Processing',
                icon: PackageMinus,
                href: '/do',
                color: 'text-pink-700',
            },
            {
                label: 'Stock Search',
                icon: Search,
                href: '/stock/search',
                color: 'text-orange-700',
            },
            {
                label: 'Put Away',
                icon: ArrowLeftRight,
                href: '/stock/transfer',
                color: 'text-amber-500',
            },
            {
                label: 'Stock Movements',
                icon: History,
                href: '/stock/movements',
                color: 'text-stone-300',
            },
        ],
    },
    {
        id: 'gate',
        title: 'Gate',
        routes: [
            {
                label: 'Gate In',
                icon: DoorOpen,
                href: '/gate/in',
                color: 'text-emerald-500',
            },
            {
                label: 'Gate Out',
                icon: DoorClosed,
                href: '/gate/out',
                color: 'text-red-500',
            },
        ],
    },
    {
        id: 'master-data',
        title: 'Master Data',
        routes: [
            {
                label: 'Clients',
                icon: Users,
                href: '/admin/clients',
                color: 'text-teal-400',
            },
            {
                label: 'Users',
                icon: Users,
                href: '/admin/users',
                color: 'text-blue-500',
            },
            {
                label: 'Items',
                icon: Package,
                href: '/admin/items',
                color: 'text-indigo-500',
            },
            {
                label: 'Warehouses',
                icon: Warehouse,
                href: '/admin/warehouses',
                color: 'text-cyan-500',
            },
            {
                label: 'Zone Layout',
                icon: Rows3,
                href: '/admin/zone-layouts',
                color: 'text-sky-400',
            },
        ],
    },
    {
        id: 'finance',
        title: 'Finance',
        defaultCollapsed: true,
        routes: [
            {
                label: 'Invoices',
                icon: Receipt,
                href: '/finance/invoices',
                color: 'text-lime-400',
            },
            {
                label: 'Billing',
                icon: Receipt,
                href: '/finance/billing',
                color: 'text-green-500',
            },
            {
                label: 'Contracts',
                icon: FileText,
                href: '/finance/contracts',
                color: 'text-emerald-400',
            },
            {
                label: 'Rate Cards',
                icon: FileText,
                href: '/finance/rates',
                color: 'text-teal-300',
            },
        ],
    },
    {
        id: 'platform',
        title: 'Platform',
        defaultCollapsed: true,
        routes: [
            {
                label: 'Labor',
                icon: Gauge,
                href: '/labor',
                color: 'text-rose-400',
            },
            {
                label: 'Integrations',
                icon: Cable,
                href: '/integrations',
                color: 'text-violet-300',
            },
            {
                label: 'WES',
                icon: Bot,
                href: '/wes',
                color: 'text-sky-300',
            },
        ],
    },
    {
        id: 'admin',
        title: 'Admin',
        defaultCollapsed: true,
        routes: [
            {
                label: 'Onboarding',
                icon: Rocket,
                href: '/admin/onboarding',
                color: 'text-amber-300',
            },
            {
                label: 'Tenant Settings',
                icon: Settings2,
                href: '/admin/tenant-settings',
                color: 'text-amber-400',
            },
            {
                label: 'User Scopes',
                icon: ShieldCheck,
                href: '/admin/scopes',
                color: 'text-lime-400',
            },
            {
                label: 'Audit Logs',
                icon: FileText,
                href: '/admin/audit',
                color: 'text-cyan-300',
            },
            {
                label: 'Companies',
                icon: Building2,
                href: '/admin/companies',
                color: 'text-emerald-300',
            },
        ],
    },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
    const pathname = usePathname()
    const { user } = useAuth()
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        const initial: Record<string, boolean> = {}
        sections.forEach((section) => {
            initial[section.id] = !!section.defaultCollapsed
        })
        return initial
    })

    const visibleSections = useMemo(
        () =>
            sections
                .map((section) => {
                    const routes = section.routes.filter((route) => {
                        const allowedPermissions = getRequiredPermissionsForPath(route.href)
                        return canAccessPermissions(user, allowedPermissions)
                    })
                    return { ...section, routes }
                })
                .filter((section) => section.routes.length > 0),
        [user]
    )

    return (
        <div className="flex h-full flex-col space-y-4 overflow-y-auto bg-gray-900 py-4 text-white">
            <div className="flex-1 px-3 py-2">
                <Link href="/dashboard" className="flex items-center pl-3 mb-14">
                    <h1 className="text-2xl font-bold">WMSPro</h1>
                </Link>
                <div className="space-y-4">
                    {visibleSections.map((section) => {
                        const isCollapsed = collapsed[section.id]
                        return (
                            <div key={section.id}>
                                <button
                                    type="button"
                                    className="mb-1 flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-xs font-semibold uppercase tracking-widest text-zinc-400 hover:bg-white/5"
                                    onClick={() =>
                                        setCollapsed((prev) => ({
                                            ...prev,
                                            [section.id]: !prev[section.id],
                                        }))
                                    }
                                >
                                    <span>{section.title}</span>
                                    {isCollapsed ? (
                                        <ChevronRight className="h-3.5 w-3.5" />
                                    ) : (
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    )}
                                </button>
                                {!isCollapsed && (
                                    <div className="space-y-1">
                                        {section.routes.map((route) => {
                                            const isActive =
                                                pathname === route.href ||
                                                pathname.startsWith(`${route.href}/`)
                                            return (
                                                <Link
                                                    key={route.href}
                                                    href={route.href}
                                                    onClick={onNavigate}
                                                    className={cn(
                                                        'group flex w-full cursor-pointer justify-start rounded-lg p-3 text-sm font-medium transition hover:bg-white/10 hover:text-white',
                                                        isActive
                                                            ? 'bg-white/10 text-white'
                                                            : 'text-zinc-400'
                                                    )}
                                                >
                                                    <div className="flex flex-1 items-center">
                                                        <route.icon
                                                            className={cn(
                                                                'mr-3 h-4 w-4 shrink-0',
                                                                route.color
                                                            )}
                                                        />
                                                        {route.label}
                                                    </div>
                                                </Link>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
