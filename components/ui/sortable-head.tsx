"use client"

/**
 * The clickable column header for every sortable list table.
 *
 * This existed three times over (admin/users, admin/warehouses, finance/contracts) with
 * three slightly different arrow treatments and no `aria-sort` in any of them, so the
 * sort state was invisible to a screen reader on every list screen in the app.
 */

import { TableHead } from "@/components/ui/table"
import type { SortDir } from "@/lib/table-sort"
import { cn } from "@/lib/utils"

export function SortableHead({
  label,
  active,
  dir,
  onClick,
  align = "left",
  hint,
  className,
}: {
  label: string
  active: boolean
  dir: SortDir
  onClick: () => void
  align?: "left" | "right"
  /** Tooltip for columns that cannot be sorted server-side; see the DO and GRN lists. */
  hint?: string
  className?: string
}) {
  return (
    <TableHead
      // aria-sort belongs on the header cell, not the button, and must be "none"
      // rather than absent on the inactive columns of a sortable table.
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn(align === "right" && "text-right", className)}
    >
      <button
        type="button"
        onClick={onClick}
        title={hint}
        className={cn(
          "inline-flex items-center gap-1 font-semibold hover:text-blue-700",
          align === "right" && "justify-end"
        )}
      >
        {label}
        <span aria-hidden className="text-[10px] text-slate-400">
          {active ? (dir === "asc" ? "↑" : "↓") : ""}
        </span>
        {hint ? <span aria-hidden className="text-[10px] text-amber-500">*</span> : null}
      </button>
    </TableHead>
  )
}
