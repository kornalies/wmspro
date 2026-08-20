"use client"

/**
 * Status, in the client's words and in more than one channel.
 *
 * The portal screens rendered whatever the column held -- PARTIALLY_DISPATCHED,
 * UNDER_REVIEW, PENDING -- which asks a client to learn the warehouse's enum
 * vocabulary to read their own account. Where a status was coloured at all, colour
 * was the only signal, so it carried nothing for a screen reader and nothing for
 * the ~4% of male clients with a red/green deficiency.
 *
 * Every chip therefore carries three things: human wording, a tone, and a glyph
 * whose SHAPE differs by tone (● done, ○ in progress, ▲ needs attention).
 */

export type StatusTone = "done" | "progress" | "attention" | "neutral"

const TONE_CLASS: Record<StatusTone, string> = {
  done: "border-emerald-200 bg-emerald-50 text-emerald-800",
  progress: "border-sky-200 bg-sky-50 text-sky-800",
  attention: "border-amber-200 bg-amber-50 text-amber-900",
  neutral: "border-neutral-200 bg-neutral-100 text-neutral-700",
}

const TONE_GLYPH: Record<StatusTone, string> = {
  done: "●",
  progress: "○",
  attention: "▲",
  neutral: "—",
}

type StatusCopy = { label: string; tone: StatusTone }

/**
 * One map for every status the portal shows. Statuses from different tables share
 * it deliberately: a client does not know that an order status and an ASN status
 * come from different places, and should not have to.
 */
const STATUS_COPY: Record<string, StatusCopy> = {
  // Delivery orders
  DRAFT: { label: "Draft", tone: "neutral" },
  PENDING: { label: "Awaiting action", tone: "attention" },
  APPROVED: { label: "Approved", tone: "progress" },
  ALLOCATED: { label: "Stock allocated", tone: "progress" },
  PICKING: { label: "Being picked", tone: "progress" },
  PICKED: { label: "Picked", tone: "progress" },
  PACKED: { label: "Packed", tone: "progress" },
  PARTIALLY_DISPATCHED: { label: "Part dispatched", tone: "attention" },
  DISPATCHED: { label: "Dispatched", tone: "done" },
  DELIVERED: { label: "Delivered", tone: "done" },
  FULFILLED: { label: "Fulfilled", tone: "done" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  CLOSED: { label: "Closed", tone: "neutral" },

  // ASN requests
  REQUESTED: { label: "Awaiting review", tone: "attention" },
  ACCEPTED: { label: "Accepted", tone: "progress" },
  REJECTED: { label: "Rejected", tone: "attention" },
  RECEIVED: { label: "Received", tone: "done" },

  // Invoices
  ISSUED: { label: "Issued", tone: "progress" },
  SENT: { label: "Sent", tone: "progress" },
  PARTIALLY_PAID: { label: "Part paid", tone: "attention" },
  PAID: { label: "Paid", tone: "done" },
  OVERDUE: { label: "Overdue", tone: "attention" },
  VOID: { label: "Void", tone: "neutral" },

  // Client action on an invoice
  APPROVED_BY_CLIENT: { label: "You approved", tone: "done" },
  DISPUTED: { label: "You disputed", tone: "attention" },

  // Disputes
  OPEN: { label: "Open", tone: "attention" },
  UNDER_REVIEW: { label: "Under review", tone: "progress" },
  RESOLVED: { label: "Resolved", tone: "done" },
}

export function statusCopy(status: string | null | undefined): StatusCopy {
  if (!status) return { label: "—", tone: "neutral" }
  const key = String(status).toUpperCase()
  return (
    STATUS_COPY[key] || {
      // An unmapped status is a gap in this map, not a reason to show the client
      // a blank cell. Title-case the enum so it at least reads as English.
      label: key
        .toLowerCase()
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
      tone: "neutral",
    }
  )
}

export function StatusChip({ status, className = "" }: { status: string | null | undefined; className?: string }) {
  const { label, tone } = statusCopy(status)
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      <span aria-hidden className="text-[9px] leading-none">
        {TONE_GLYPH[tone]}
      </span>
      {label}
    </span>
  )
}
