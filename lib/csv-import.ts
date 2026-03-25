export type CsvRow = Record<string, string>

function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let curr = ""
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]

    if (ch === '"' && inQuotes && next === '"') {
      curr += '"'
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (ch === "," && !inQuotes) {
      out.push(curr.trim())
      curr = ""
      continue
    }

    curr += ch
  }

  out.push(curr.trim())
  return out
}

export function parseCsv(text: string): CsvRow[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
  if (!normalized) return []

  const lines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map((h) => h.trim())
  const rows: CsvRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i])
    const row: CsvRow = {}
    for (let c = 0; c < headers.length; c++) {
      row[headers[c]] = (values[c] || "").trim()
    }
    rows.push(row)
  }
  return rows
}

export function parseBoolean(input: string, fallback = true): boolean {
  const v = String(input || "").trim().toLowerCase()
  if (!v) return fallback
  if (["true", "1", "yes", "y"].includes(v)) return true
  if (["false", "0", "no", "n"].includes(v)) return false
  return fallback
}

export function parseNumber(input: string): number | null {
  const v = String(input || "").trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
