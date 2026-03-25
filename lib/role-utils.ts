const ROLE_ALIAS_MAP: Record<string, string> = {
  CUSTOMER: "CLIENT",
  CLIENT_USER: "CLIENT",
  READONLY: "VIEWER",
  READ_ONLY: "VIEWER",
}

export function normalizeRoleCode(input: string | null | undefined): string {
  const raw = String(input || "").trim().toUpperCase()
  if (!raw) return ""
  return ROLE_ALIAS_MAP[raw] || raw
}

export function normalizeRoleCodes(input: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  for (const role of input) {
    const normalized = normalizeRoleCode(role)
    if (normalized) seen.add(normalized)
  }
  return Array.from(seen)
}

