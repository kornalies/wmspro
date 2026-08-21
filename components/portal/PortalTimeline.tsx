"use client"

/**
 * Where an order actually got to.
 *
 * Three states, because two would force a lie. A step that has not happened on a
 * live order is genuinely pending; the same step on a completed order is one the
 * order never took -- most often because it went out through dispatch rather
 * than the packed tail, which are mutually exclusive per order. Rendering both
 * as an empty circle would tell a client their finished shipment is still
 * waiting to be picked.
 *
 * Precision is honoured too: `dispatch_date` is a DATE, so it prints as a day.
 * Formatting it as a time would invent a dispatch hour out of midnight.
 */

import { formatDay, formatDayTime } from "@/lib/portal-format"

export type TimelineStep = {
  key: string
  label: string
  at: string | null
  precision: "day" | "time"
  state: "done" | "pending" | "not_applicable"
}

export function PortalTimeline({ steps }: { steps: TimelineStep[] }) {
  const shown = steps.filter((step) => step.state !== "not_applicable")
  const skipped = steps.filter((step) => step.state === "not_applicable")

  return (
    <div>
      <ol className="relative space-y-0">
        {shown.map((step, index) => {
          const done = step.state === "done"
          const isLast = index === shown.length - 1
          return (
            <li key={step.key} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast ? (
                <span
                  aria-hidden
                  className={`absolute left-[7px] top-4 h-full w-px ${done ? "bg-emerald-300" : "bg-neutral-200"}`}
                />
              ) : null}
              <span
                aria-hidden
                className={`relative mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                  done ? "border-emerald-600 bg-emerald-600" : "border-neutral-300 bg-white"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${done ? "font-medium text-neutral-900" : "text-neutral-500"}`}>
                  {step.label}
                </p>
                <p className="text-xs text-neutral-500">
                  {done && step.at
                    ? step.precision === "day"
                      ? formatDay(step.at)
                      : formatDayTime(step.at)
                    : "Not yet"}
                </p>
              </div>
            </li>
          )
        })}
      </ol>

      {skipped.length ? (
        <p className="mt-3 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
          {skipped.map((step) => step.label).join(", ")} did not apply to this order.
        </p>
      ) : null}
    </div>
  )
}
