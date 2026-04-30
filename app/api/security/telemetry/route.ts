import { getSession } from "@/lib/auth";
import { fail, ok } from "@/lib/api-response";
import { securityTelemetry } from "@/lib/security-telemetry";

const hasSecurityAccess = (session: NonNullable<Awaited<ReturnType<typeof getSession>>>) => {
  const role = String(session.role || "").toUpperCase();
  if (role === "SUPER_ADMIN" || role === "ADMIN") return true;
  const permissions = Array.isArray(session.permissions) ? session.permissions : [];
  return permissions.includes("audit.view");
};

export async function GET() {
  const session = await getSession();
  if (!session) return fail("UNAUTHORIZED", "Unauthorized", 401);
  if (!hasSecurityAccess(session)) return fail("FORBIDDEN", "Insufficient permissions", 403);

  return ok({
    securityTelemetry: securityTelemetry.snapshot(),
    securityStatus: securityTelemetry.status(),
  });
}

