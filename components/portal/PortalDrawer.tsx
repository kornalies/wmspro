"use client"

/**
 * A side panel for the portal's write actions.
 *
 * It exists because the billing screen collected a payment through three chained
 * `window.prompt` calls -- amount, then reference, then submit. That is a browser
 * dialog with no validation, no currency formatting, no way to see the invoice you
 * are paying while you type, and no way back: cancelling the second prompt after
 * answering the first left a half-answered financial transaction. A drawer keeps
 * the invoice on screen, validates as you type, and can be abandoned safely.
 */

import { useEffect, useRef, type ReactNode } from "react"

export function PortalDrawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose()
      if (event.key !== "Tab") return

      // Keep Tab inside the panel: a dialog that lets focus wander behind the
      // scrim is unusable with a keyboard and invisible to a screen reader.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusable?.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    // Focus the first control rather than the panel, so a keyboard user starts
    // typing where they would have clicked.
    const timer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>("input, select, textarea, button")?.focus()
    }, 20)

    return () => {
      document.removeEventListener("keydown", onKeyDown)
      document.body.style.overflow = previousOverflow
      window.clearTimeout(timer)
    }
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-neutral-900/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex h-full w-full max-w-md flex-col bg-white shadow-xl motion-safe:animate-in motion-safe:slide-in-from-right motion-safe:duration-200"
      >
        <div className="flex items-start justify-between gap-3 border-b border-neutral-200 p-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-900">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-sm text-neutral-600">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-50"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">{children}</div>

        {footer ? <div className="border-t border-neutral-200 p-5">{footer}</div> : null}
      </div>
    </div>
  )
}
