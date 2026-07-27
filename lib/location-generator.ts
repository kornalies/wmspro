/**
 * Bin location generation from rack geometry.
 *
 * Onboarding a warehouse means creating every bin in it. The existing bulk path
 * handles one zone + one rack + a numeric bin range, with the codes assembled in
 * the browser and posted as an explicit array. A real racking layout is three
 * dimensions — racks, levels, bins per level — so a 20-rack aisle at 5 levels of
 * 10 bins needed twenty separate operations to describe one aisle.
 *
 * This module expands a geometry spec into the bins it implies. It is a pure
 * function on purpose: the arithmetic is the part that goes wrong (off-by-one
 * ranges, padding, collisions), and keeping it out of the route means it can be
 * checked directly and previewed to an onboarder before anything is written.
 */

export type AxisSpec = {
  /** Literal prefix, e.g. "R" for R001. */
  prefix: string
  from: number
  to: number
  /** Zero-pad the number to this width. 0 or undefined leaves it unpadded. */
  pad?: number
}

export type GeometrySpec = {
  zoneCode: string
  racks: AxisSpec
  /** Optional middle axis. Omit for a flat rack of bins. */
  levels?: AxisSpec | null
  bins: AxisSpec
  /** Placed between level and bin in a bin code. Defaults to "". */
  binSeparator?: string
}

export type GeneratedBin = {
  rackCode: string
  rackName: string
  binCode: string
  binName: string
  /** Walk order: racks, then levels, then bins. */
  sortOrder: number
}

export class LocationGeneratorError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = "LocationGeneratorError"
  }
}

/** Hard ceiling on one generation. Above this an onboarder wants a script. */
export const MAX_GENERATED_BINS = 5000

function axisLabel(axis: string) {
  return axis
}

function validateAxis(axis: AxisSpec, name: string) {
  if (!Number.isInteger(axis.from) || !Number.isInteger(axis.to)) {
    throw new LocationGeneratorError("VALIDATION_ERROR", `${name} range must be whole numbers`)
  }
  if (axis.from > axis.to) {
    throw new LocationGeneratorError(
      "VALIDATION_ERROR",
      `${name} range is inverted: from ${axis.from} is greater than to ${axis.to}`
    )
  }
  if (axis.from < 0) {
    throw new LocationGeneratorError("VALIDATION_ERROR", `${name} range cannot start below zero`)
  }
  const pad = axis.pad ?? 0
  if (pad < 0 || pad > 10) {
    throw new LocationGeneratorError("VALIDATION_ERROR", `${name} padding must be between 0 and 10`)
  }
  // A padding narrower than the largest number would silently produce codes of
  // mixed width (B08, B09, B10 vs B008) and break any sort that relies on the
  // code being fixed-width.
  if (pad > 0 && String(axis.to).length > pad) {
    throw new LocationGeneratorError(
      "VALIDATION_ERROR",
      `${name} padding of ${pad} is too narrow for ${axis.to}; codes would vary in width`
    )
  }
}

function axisCount(axis: AxisSpec) {
  return axis.to - axis.from + 1
}

function code(axis: AxisSpec, n: number) {
  const pad = axis.pad ?? 0
  const digits = pad > 0 ? String(n).padStart(pad, "0") : String(n)
  return `${axis.prefix}${digits}`.toUpperCase()
}

/** How many bins a spec implies, without building them. */
export function countGeneratedBins(spec: GeometrySpec): number {
  validateAxis(spec.racks, "Rack")
  validateAxis(spec.bins, "Bin")
  if (spec.levels) validateAxis(spec.levels, "Level")
  return (
    axisCount(spec.racks) * (spec.levels ? axisCount(spec.levels) : 1) * axisCount(spec.bins)
  )
}

/**
 * Expand a geometry spec into bins, in the order a picker would walk them:
 * rack, then level, then bin.
 *
 * sortOrder is assigned across the whole generation rather than per rack, so a
 * single ORDER BY sort_order reproduces the walk route for the entire zone.
 */
export function generateBins(spec: GeometrySpec): GeneratedBin[] {
  const total = countGeneratedBins(spec)
  if (total === 0) {
    throw new LocationGeneratorError("VALIDATION_ERROR", "This geometry produces no bins")
  }
  if (total > MAX_GENERATED_BINS) {
    throw new LocationGeneratorError(
      "TOO_MANY_BINS",
      `This geometry produces ${total} bins, above the ${MAX_GENERATED_BINS} limit for one generation. Split it by rack range.`
    )
  }

  const separator = spec.binSeparator ?? ""
  const out: GeneratedBin[] = []
  let sortOrder = 0

  for (let r = spec.racks.from; r <= spec.racks.to; r++) {
    const rackCode = code(spec.racks, r)
    const levelValues = spec.levels
      ? Array.from({ length: axisCount(spec.levels) }, (_, i) => spec.levels!.from + i)
      : [null]

    for (const level of levelValues) {
      const levelCode = level === null ? "" : code(spec.levels!, level)

      for (let b = spec.bins.from; b <= spec.bins.to; b++) {
        const binPart = code(spec.bins, b)
        const binCode = levelCode ? `${levelCode}${separator}${binPart}` : binPart
        out.push({
          rackCode,
          rackName: `${axisLabel("Rack")} ${rackCode}`,
          binCode,
          binName: levelCode ? `Level ${levelCode} Bin ${binPart}` : `Bin ${binPart}`,
          sortOrder: sortOrder++,
        })
      }
    }
  }

  // A spec that generates the same code twice would be silently absorbed by the
  // ON CONFLICT DO NOTHING on insert, reporting fewer bins than asked for with no
  // explanation. Catching it here names the cause.
  const seen = new Set<string>()
  for (const bin of out) {
    const key = `${bin.rackCode}/${bin.binCode}`
    if (seen.has(key)) {
      throw new LocationGeneratorError(
        "DUPLICATE_CODE",
        `This geometry generates ${key} more than once. Unpadded level and bin numbers run together: level 1 bin 11 and level 11 bin 1 both read as "111". Pad the numbers to a fixed width, or set a bin separator.`
      )
    }
    seen.add(key)
  }

  return out
}

/** Short human summary of a spec, for a confirmation prompt. */
export function describeGeometry(spec: GeometrySpec): string {
  const racks = axisCount(spec.racks)
  const levels = spec.levels ? axisCount(spec.levels) : 0
  const bins = axisCount(spec.bins)
  const parts = [`${racks} rack(s)`]
  if (levels) parts.push(`${levels} level(s)`)
  parts.push(`${bins} bin(s) each`)
  return `${spec.zoneCode}: ${parts.join(" × ")} = ${countGeneratedBins(spec)} bins`
}