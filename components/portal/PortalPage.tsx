"use client"

/**
 * The heading block each portal screen opens with.
 *
 * Every screen used to render its own `<main>`, its own "Portal <Thing>" title and
 * a "Back to Portal" link -- the last of which only made sense while the portal had
 * no persistent navigation. The shell provides both now, so a screen states what it
 * is, optionally why, and gets on with it.
 *
 * `denied` is the fourth state the portal screens were missing: a user who reaches
 * a section they have no grant for should be told who to ask, not handed an empty
 * table that reads as lost data.
 */

import type { ReactNode } from "react"

export function PortalPage({
  title,
  description,
  actions,
  denied,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  denied?: { reason: string } | null
  children: ReactNode
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
          {description ? <p className="mt-1 max-w-2xl text-sm text-neutral-600">{description}</p> : null}
        </div>
        {actions && !denied ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>

      {denied ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <p className="text-sm font-medium text-amber-900">This section is not available to you</p>
          <p className="mt-1 text-sm text-amber-800">{denied.reason}</p>
        </div>
      ) : (
        children
      )}
    </div>
  )
}
