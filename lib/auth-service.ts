import bcrypt from "bcryptjs"

import { query } from "@/lib/db"
import { getUserAccessProfile } from "@/lib/rbac"
import { normalizeRoleCode } from "@/lib/role-utils"

type LoginInput = {
  companyCode: string
  username: string
  password: string
}

export type AuthenticatedUser = {
  id: number
  username: string
  email: string | null
  full_name: string
  role: string
  roles: string[]
  permissions: string[]
  company_id: number
  company_code: string
  warehouse_id: number | null
}

export async function authenticateUser(input: LoginInput): Promise<AuthenticatedUser> {
  const result = await query(
    `SELECT
      u.id,
      u.username,
      u.email,
      u.full_name,
      u.role,
      u.warehouse_id,
      u.company_id,
      c.company_code,
      u.password_hash
    FROM users u
    JOIN companies c ON c.id = u.company_id
    WHERE LOWER(TRIM(u.username)) = LOWER(TRIM($1))
      AND UPPER(c.company_code) = UPPER($2)
      AND u.is_active = true
      AND c.is_active = true`,
    [input.username, input.companyCode]
  )

  if (result.rows.length === 0) {
    throw new Error("INVALID_CREDENTIALS")
  }

  const user = result.rows[0]
  const isValid = await bcrypt.compare(input.password, user.password_hash)
  if (!isValid) {
    throw new Error("INVALID_CREDENTIALS")
  }

  const access = await getUserAccessProfile(user.id, normalizeRoleCode(user.role))
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    full_name: user.full_name,
    role: access.primaryRole,
    roles: access.roles,
    permissions: access.permissions,
    company_id: user.company_id,
    company_code: user.company_code,
    warehouse_id: user.warehouse_id,
  }
}
