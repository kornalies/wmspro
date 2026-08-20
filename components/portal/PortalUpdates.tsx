"use client"

/**
 * The client's side of the notification loop, as an overview card.
 *
 * Notifications have existed in this product for a while, but only the operator
 * dashboard ever rendered them -- so a row written for a portal user was a row
 * nobody could read. The feed now also hangs off the bell in the shell; this card
 * stays because the overview is where a client lands, and a list they can read
 * without opening a menu is worth the space.
 *
 * Both surfaces share usePortalUpdates, so they poll once between them rather than
 * twice.
 */

import Link from "next/link"

import { relativeTime, usePortalUpdates } from "@/hooks/use-portal-updates"

export function PortalUpdates() {
  const { rows, loaded, unread, markRead } = usePortalUpdates(10)

  return (
    <article className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm md:p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm uppercase tracking-wide text-neutral-600">Updates</p>
        {unread > 0 ? (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            {unread} new
          </span>
        ) : null}
      </div>

      {!loaded ? (
        <div className="space-y-3">
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-1.5">
              <div className="h-3.5 w-2/3 animate-pulse rounded bg-neutral-200" />
              <div className="h-3 w-full animate-pulse rounded bg-neutral-100" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-500">
          Nothing new. Updates about your shipments and orders appear here.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const href = typeof row.data?.href === "string" ? row.data.href : null
            const body = (
              <>
                <p className="text-sm font-medium text-neutral-900">{row.title}</p>
                {row.body ? <p className="mt-0.5 text-sm text-neutral-600">{row.body}</p> : null}
                <p className="mt-1 text-xs text-neutral-400">{relativeTime(row.created_at)}</p>
              </>
            )

            return (
              <li
                key={row.id}
                className={`border-b border-neutral-100 pb-3 last:border-b-0 last:pb-0 ${
                  row.read_at ? "opacity-60" : ""
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                      row.read_at ? "bg-transparent" : "bg-blue-500"
                    }`}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    {href ? (
                      <Link href={href} onClick={() => void markRead(row.id)} className="block">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </div>
                  {!row.read_at ? (
                    <button
                      type="button"
                      className="shrink-0 text-xs text-neutral-500 hover:text-neutral-800"
                      onClick={() => void markRead(row.id)}
                    >
                      Mark read
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </article>
  )
}
