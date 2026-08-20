"use client"

/**
 * The notification bell in the portal shell.
 *
 * The feed itself is not new -- it has been on the overview screen for a while --
 * but it only existed there, so a client sitting on their invoices never found out
 * their shipment had arrived. Notifications that reach a screen nobody is on are
 * the same dead end these rows were in before the portal could read them at all.
 */

import { useEffect, useRef, useState } from "react"
import Link from "next/link"

import { relativeTime, usePortalUpdates } from "@/hooks/use-portal-updates"

export function PortalBell() {
  const { rows, loaded, unread, markRead, markAllRead } = usePortalUpdates(10)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close on outside click and on Escape. Both, not either: a dropdown that traps
  // the keyboard user is worse than no dropdown.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={unread > 0 ? `Updates, ${unread} unread` : "Updates"}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-300 text-neutral-700 transition hover:bg-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
          <path d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v3L4 13h12l-1.5-3V7A4.5 4.5 0 0 0 10 2.5Z" strokeLinejoin="round" />
          <path d="M8 15.5a2 2 0 0 0 4 0" strokeLinecap="round" />
        </svg>
        {unread > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-700 px-1 text-[10px] font-semibold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5">
            <p className="text-sm font-medium text-neutral-900">Updates</p>
            {unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAllRead()}
                className="text-xs text-blue-700 hover:underline"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {!loaded ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((row) => (
                  <div key={row} className="space-y-1.5">
                    <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-200" />
                    <div className="h-3 w-full animate-pulse rounded bg-neutral-100" />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-neutral-500">
                Nothing new. Updates about your shipments, orders and invoices appear here.
              </p>
            ) : (
              <ul>
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
                      className={`border-b border-neutral-100 last:border-b-0 ${row.read_at ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-start gap-2.5 px-4 py-3">
                        <span
                          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${row.read_at ? "bg-transparent" : "bg-blue-500"}`}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          {href ? (
                            <Link
                              href={href}
                              onClick={() => {
                                void markRead(row.id)
                                setOpen(false)
                              }}
                              className="block"
                            >
                              {body}
                            </Link>
                          ) : (
                            body
                          )}
                        </div>
                        {!row.read_at ? (
                          <button
                            type="button"
                            onClick={() => void markRead(row.id)}
                            className="shrink-0 text-xs text-neutral-500 hover:text-neutral-800"
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
          </div>
        </div>
      ) : null}
    </div>
  )
}
