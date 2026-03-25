'use client'

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
} from 'lucide-react'

const routes = [
    {
        label: 'Dashboard',
        icon: LayoutDashboard,
        href: '/dashboard',
        color: 'text-sky-500',
    },
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
    {
        label: 'Onboarding',
        icon: Rocket,
        href: '/admin/onboarding',
        color: 'text-amber-300',
    },
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
    {
        label: 'Reports',
        icon: BarChart3,
        href: '/reports',
        color: 'text-yellow-500',
    },
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
]

export function Sidebar() {
    const pathname = usePathname()
    const { user } = useAuth()

    const visibleRoutes = routes.filter((route) => {
        const allowedPermissions = getRequiredPermissionsForPath(route.href)
        return canAccessPermissions(user, allowedPermissions)
    })

    return (
        <div className="flex h-full flex-col space-y-4 overflow-y-auto bg-gray-900 py-4 text-white">
            <div className="px-3 py-2 flex-1">
                <Link href="/dashboard" className="flex items-center pl-3 mb-14">
                    <h1 className="text-2xl font-bold">WMS</h1>
                </Link>
                <div className="space-y-1">
                    {visibleRoutes.map((route) => (
                        <Link
                            key={route.href}
                            href={route.href}
                            className={cn(
                                'text-sm group flex p-3 w-full justify-start font-medium cursor-pointer hover:text-white hover:bg-white/10 rounded-lg transition',
                                pathname === route.href
                                    ? 'text-white bg-white/10'
                                    : 'text-zinc-400'
                            )}
                        >
                            <div className="flex items-center flex-1">
                                <route.icon className={cn('mr-3 h-4 w-4 shrink-0', route.color)} />
                                {route.label}
                            </div>
                        </Link>
                    ))}
                </div>
            </div>
        </div>
    )
}
