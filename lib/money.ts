/**
 * Money math for the billing engine.
 *
 * All amounts are rupees with 2 decimal places. Every rounding goes through `round2`, which scales
 * to integer paise before rounding so a chain of float multiplications can never drift a document
 * off by a fraction of a paisa. GST is split from the ALREADY-ROUNDED total (not by rounding each
 * half independently) so cgst + sgst always reconciles to totalTaxAmount to the exact paisa.
 */

export const DEFAULT_GST_RATE = 18

export type SupplyType = "INTRA_STATE" | "INTER_STATE"

export type GstSplit = {
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
  totalTaxAmount: number
  grossAmount: number
}

/** Round a money value to 2 decimals via integer paise (half-up), guarding non-finite input. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  // Adding EPSILON before scaling nudges exact .xx5 halves (which the float repr often stores as
  // .xx499999) up to the intuitive half-up result.
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Split an amount into GST components for the given supply type.
 * INTER_STATE -> single IGST line; INTRA_STATE -> CGST + SGST that always sum back to the total tax.
 */
export function computeGstSplit(amount: number, gstRate: number, supplyType: SupplyType): GstSplit {
  const base = round2(amount)
  const totalTax = round2((base * gstRate) / 100)

  if (supplyType === "INTER_STATE") {
    return {
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: totalTax,
      totalTaxAmount: totalTax,
      grossAmount: round2(base + totalTax),
    }
  }

  const cgst = round2(totalTax / 2)
  // Derive SGST as the remainder so an odd-paisa total (e.g. 18.05) reconciles exactly instead of
  // silently dropping a paisa the way independent halving would.
  const sgst = round2(totalTax - cgst)
  return {
    cgstAmount: cgst,
    sgstAmount: sgst,
    igstAmount: 0,
    totalTaxAmount: round2(cgst + sgst),
    grossAmount: round2(base + cgst + sgst),
  }
}